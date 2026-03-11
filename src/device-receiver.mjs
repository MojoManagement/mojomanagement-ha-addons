import YouTubeCastReceiver, { Constants, Player, PlaylistRequestHandler } from 'yt-cast-receiver';
import { resolveYouTubeAudio } from './resolver.mjs';
import { DeviceBoundCastTarget } from './cast-target.mjs';

class NoopPlaylistRequestHandler extends PlaylistRequestHandler {
  async getPreviousNextVideos() { return { previous: null, next: null }; }
}

class ForwardingPlayer extends Player {
  constructor({ target, label, logger, resolverConfig }) {
    super();
    this.target = target;
    this.label = label;
    this._bridgeLogger = logger;
    this.resolverConfig = resolverConfig;
    this.currentTrack = null;
    this.volume = { level: 50, muted: false };
    this.lastNonMutedLevel = 50;
    this.target.attachOwner(this);
  }

  async doPlay(video, position) {
    try {
      const track = await resolveYouTubeAudio(video.id, this.resolverConfig);
      this.currentTrack = track;
      await this.target.play(track.mediaUrl, Number(position || 0));
      await this.target.setVolume((this.volume.muted ? 0 : this.volume.level) / 100);
      this._bridgeLogger.info(`[${this.label}] Forwarding "${track.title}"`);
      return true;
    } catch (err) {
      this._bridgeLogger.error(`[${this.label}] doPlay failed`, err?.message ?? err);
      return false;
    }
  }

  async doPause() { try { await this.target.pause(); return true; } catch { return false; } }
  async doResume() { try { await this.target.resume(); return true; } catch { return false; } }
  async doStop() { try { await this.target.stop(); return true; } catch { return false; } }
  async doSeek(position) { try { if (this.currentTrack?.isLive) return false; await this.target.seekTo(Number(position || 0)); return true; } catch { return false; } }

  async doSetVolume(volume) {
    try {
      const level = Math.max(0, Math.min(100, Number(volume?.level ?? this.volume.level)));
      const muted = Boolean(volume?.muted);
      if (!muted) this.lastNonMutedLevel = level;
      this.volume = { level: muted ? this.lastNonMutedLevel : level, muted };
      try {
        await this.target.setVolume((muted ? 0 : level) / 100);
      } catch (err) {
        if (!DeviceBoundCastTarget.isNoSessionStartedError(err)) throw err;
      }
      return true;
    } catch {
      return false;
    }
  }

  async doGetVolume() { return this.volume; }
  async doGetPosition() { try { return await this.target.getPosition(); } catch { return 0; } }
  async doGetDuration() { return Number(this.currentTrack?.duration ?? 0); }
}

export class DeviceReceiver {
  constructor({ port, dialPrefix, virtualName, screenName, host, registry, label, logger, logLevel, resolverConfig, playRetryMs }) {
    this.port = port;
    this.host = host;
    this.label = label;
    this.started = false;
    this.activeSenders = 0;

    const target = new DeviceBoundCastTarget({ getRecord: () => registry.getRecord(host), playRetryMs });
    const player = new ForwardingPlayer({ target, label, logger, resolverConfig });

    this.receiver = new YouTubeCastReceiver(player, {
      dial: { port, prefix: dialPrefix },
      app: {
        enableAutoplayOnConnect: true,
        resetPlayerOnDisconnectPolicy: Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED,
        mutePolicy: Constants.MUTE_POLICIES.PRESERVE_VOLUME_LEVEL,
        playlistRequestHandler: new NoopPlaylistRequestHandler(),
      },
      device: {
        name: virtualName,
        screenName,
        brand: 'Custom',
        model: 'CastAudioBridge',
      },
      dataStore: false,
      logLevel,
    });

    this.receiver.on('senderConnect', () => { this.activeSenders += 1; });
    this.receiver.on('senderDisconnect', () => { this.activeSenders = Math.max(0, this.activeSenders - 1); });
  }

  async start() { if (!this.started) { await this.receiver.start(); this.started = true; } }
  async stop() { if (this.started) { await this.receiver.stop(); this.started = false; } }
}
