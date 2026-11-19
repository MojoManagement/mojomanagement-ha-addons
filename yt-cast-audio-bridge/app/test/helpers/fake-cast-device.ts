import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'castv2';

const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';
const MEDIA_APP_ID = 'CC1AD845';

interface Message {
  type: string;
  requestId?: number;
  [key: string]: unknown;
}

interface MediaState {
  mediaSessionId: number;
  playerState: 'PLAYING' | 'PAUSED' | 'IDLE';
  currentTime: number;
  playbackRate: number;
  idleReason?: string;
  media?: unknown;
}

function createCertificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-cast-cert-'));
  try {
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=fake-cast'], { stdio: 'ignore' });
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A minimal Cast receiver that speaks the real CASTV2 protocol over TLS. It
 * lets the tests drive the bridge's Cast code against the real client library.
 */
export class FakeCastDevice {
  readonly #server: Server;
  readonly #clients = new Set<string>();
  volume = { level: 0.4, muted: false };
  session: { appId: string; sessionId: string; transportId: string; displayName: string; namespaces: { name: string }[] } | null = null;
  media: MediaState | null = null;
  /** Every media/receiver command received, e.g. `LOAD`, `PAUSE`. */
  readonly commands: string[] = [];
  loads: { url: string; currentTime: number; title: string }[] = [];
  port = 0;
  #nextMediaSessionId = 1;
  #nextSession = 1;

  constructor() {
    this.#server = new Server(createCertificate());
    this.#server.on('message', (clientId: string, sourceId: string, destinationId: string, namespace: string, data: string) => {
      this.#clients.add(clientId);
      let message: Message;
      try {
        message = JSON.parse(data) as Message;
      } catch {
        return;
      }
      this.#handle(clientId, sourceId, destinationId, namespace, message);
    });
    this.#server.on('error', () => undefined);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.port = (this.#server as unknown as { server: { address(): { port: number } } }).server.address().port;
        resolve();
      });
    });
  }

  close(): void {
    this.dropConnections();
    this.#server.close();
  }

  /** Simulates a network drop: every client connection is cut. */
  dropConnections(): void {
    const sockets = (this.#server as unknown as { clients: Record<string, { socket: { destroy(): void } }> }).clients;
    for (const client of Object.values(sockets)) client.socket.destroy();
    this.#clients.clear();
  }

  /** The current track played to its end. */
  finishTrack(): void {
    this.#endMedia('FINISHED');
  }

  failTrack(): void {
    this.#endMedia('ERROR');
  }

  /** Someone pressed pause/play on the speaker or in another app. */
  setPlayerState(state: 'PLAYING' | 'PAUSED', currentTime?: number): void {
    if (!this.media) return;
    this.media = { ...this.media, playerState: state, currentTime: currentTime ?? this.media.currentTime };
    this.#broadcastMedia();
  }

  /** Someone changed the volume on the speaker itself. */
  setVolumeOnDevice(level: number): void {
    this.volume = { ...this.volume, level };
    this.#broadcastReceiver();
  }

  /** Another app took over the speaker. */
  launchOtherApp(): void {
    this.session = { appId: 'OTHER', sessionId: `other-${this.#nextSession++}`, transportId: 'web-other', displayName: 'Other', namespaces: [] };
    this.media = null;
    this.#broadcastReceiver();
  }

  #endMedia(idleReason: string): void {
    if (!this.media) return;
    this.media = { ...this.media, playerState: 'IDLE', idleReason };
    this.#broadcastMedia();
    this.media = null;
  }

  #receiverStatus(requestId: number): Message {
    return { type: 'RECEIVER_STATUS', requestId, status: { applications: this.session ? [this.session] : [], volume: this.volume } };
  }

  #mediaStatus(requestId: number): Message {
    return { type: 'MEDIA_STATUS', requestId, status: this.media ? [this.media] : [] };
  }

  #broadcastReceiver(): void {
    for (const clientId of this.#clients) this.#send(clientId, 'receiver-0', '*', NS_RECEIVER, this.#receiverStatus(0));
  }

  #broadcastMedia(): void {
    const transportId = this.session?.transportId ?? 'web-1';
    for (const clientId of this.#clients) this.#send(clientId, transportId, '*', NS_MEDIA, this.#mediaStatus(0));
  }

  #send(clientId: string, sourceId: string, destinationId: string, namespace: string, message: Message): void {
    try {
      this.#server.send(clientId, sourceId, destinationId, namespace, JSON.stringify(message));
    } catch {
      // Client went away.
    }
  }

  #handle(clientId: string, sourceId: string, destinationId: string, namespace: string, message: Message): void {
    const requestId = message.requestId ?? 0;
    if (namespace === NS_HEARTBEAT && message.type === 'PING') {
      this.#send(clientId, destinationId, sourceId, namespace, { type: 'PONG' });
      return;
    }
    if (namespace === NS_RECEIVER) {
      this.commands.push(message.type);
      if (message.type === 'LAUNCH') {
        const id = this.#nextSession++;
        this.session = { appId: String(message.appId), sessionId: `session-${id}`, transportId: `web-${id}`, displayName: 'Default Media Receiver', namespaces: [{ name: NS_MEDIA }] };
        this.media = null;
      } else if (message.type === 'STOP') {
        this.session = null;
        this.media = null;
      } else if (message.type === 'SET_VOLUME') {
        this.volume = { ...this.volume, ...(message.volume as object) };
      } else if (message.type !== 'GET_STATUS') {
        return;
      }
      this.#send(clientId, destinationId, sourceId, namespace, this.#receiverStatus(requestId));
      if (message.type !== 'GET_STATUS') this.#broadcastReceiver();
      return;
    }
    if (namespace === NS_MEDIA) {
      if (!this.session || this.session.appId !== MEDIA_APP_ID || destinationId !== this.session.transportId) return;
      this.commands.push(message.type);
      switch (message.type) {
        case 'LOAD': {
          const media = message.media as { contentId: string; metadata?: { title?: string } };
          this.loads.push({ url: media.contentId, currentTime: Number(message.currentTime) || 0, title: media.metadata?.title ?? '' });
          this.media = { mediaSessionId: this.#nextMediaSessionId++, playerState: 'PLAYING', currentTime: Number(message.currentTime) || 0, playbackRate: 1, media };
          break;
        }
        case 'PAUSE':
          if (this.media) this.media = { ...this.media, playerState: 'PAUSED' };
          break;
        case 'PLAY':
          if (this.media) this.media = { ...this.media, playerState: 'PLAYING' };
          break;
        case 'SEEK':
          if (this.media) this.media = { ...this.media, currentTime: Number(message.currentTime) || 0 };
          break;
        case 'STOP':
          if (this.media) this.media = { ...this.media, playerState: 'IDLE', idleReason: 'CANCELLED' };
          break;
        case 'GET_STATUS':
          break;
        default:
          return;
      }
      this.#send(clientId, destinationId, sourceId, namespace, this.#mediaStatus(requestId));
      if (message.type !== 'GET_STATUS') this.#broadcastMedia();
      if (this.media?.playerState === 'IDLE') this.media = null;
    }
  }
}
