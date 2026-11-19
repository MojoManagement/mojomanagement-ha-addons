import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Logger } from './logger.ts';
import { errorMessage } from './util.ts';

/** Home Assistant's ingress proxy always connects from this address. */
const INGRESS_ADDRESS = '172.30.32.2';
const MAX_BODY_BYTES = 10 * 1024;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};

export interface Health {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  receivers: number;
}

export interface HttpActions {
  setDeviceEnabled(id: string, enabled: boolean): Promise<void>;
  rescan(): Promise<void>;
  updateYtDlp(): Promise<unknown>;
  selfTest(): Promise<unknown>;
}

export interface HttpServerOptions {
  port: number;
  /** Serve UI and API to any client instead of only Home Assistant ingress and localhost. */
  uiOpen: boolean;
  uiDir: string;
  getHealth: () => Health;
  getStatus: () => unknown;
  actions: HttpActions;
  logger: Logger;
}

export function isTrustedClient(remoteAddress: string | undefined, uiOpen: boolean): boolean {
  if (uiOpen) return true;
  const address = (remoteAddress ?? '').replace(/^::ffff:/, '');
  return address === INGRESS_ADDRESS || address === '127.0.0.1' || address === '::1';
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'Body must be a JSON object');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Serves the public health check plus the status UI and its API. Everything
 * except `/healthz` is restricted to Home Assistant ingress unless `uiOpen` is set.
 */
export function createHttpServer(options: HttpServerOptions): http.Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Behind ingress the path may arrive with duplicate slashes; the query string is unused.
    const pathname = (req.url ?? '/').split('?', 1)[0]?.replace(/\/{2,}/g, '/') || '/';

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const health = options.getHealth();
      sendJson(res, health.ok ? 200 : 503, health);
      return;
    }
    if (!isTrustedClient(req.socket.remoteAddress, options.uiOpen)) {
      throw new HttpError(403, 'The status page is only available through Home Assistant (open the add-on and click "Open Web UI").');
    }

    if (req.method === 'GET') {
      const asset = STATIC_FILES[pathname];
      if (asset) {
        const body = await readFile(path.join(options.uiDir, asset.file));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type });
        res.end(body);
        return;
      }
      if (pathname === '/api/status') {
        sendJson(res, 200, options.getStatus());
        return;
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const deviceMatch = /^\/api\/devices\/([a-z0-9._-]{1,80})\/enabled$/i.exec(pathname);
      if (deviceMatch?.[1]) {
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false');
        await options.actions.setDeviceEnabled(deviceMatch[1], body.enabled);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/rescan') {
        await options.actions.rescan();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/ytdlp/update') {
        sendJson(res, 200, await options.actions.updateYtDlp());
        return;
      }
      if (pathname === '/api/selftest') {
        sendJson(res, 200, await options.actions.selfTest());
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    throw new HttpError(405, 'Method not allowed');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) options.logger.error('Request failed', errorMessage(err));
      if (res.headersSent) res.end();
      else sendJson(res, status, { ok: false, error: status === 500 ? 'Internal error' : errorMessage(err) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 50;
  return server;
}
