/**
 * The debug console: admin-only HTTP + WebSocket on the edge.
 *
 * It shows raw thermal frames, so it is the one place imagery reaches a
 * browser. That is why it lives on the edge (never the web tier), requires
 * ADMIN_PASSWORD, and without one binds to localhost only (see config.ts).
 *
 * Commands to nodes are POSTs that need a custom header, which a cross-site
 * form cannot send -- basic-auth credentials are attached by the browser
 * automatically, so without it any page the admin visits could reboot nodes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { CMD_IDENTIFY, CMD_REBOOT, CMD_RESET_BACKGROUND, CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_NAMES } from './protocol.js';
import type { EdgeRuntime } from './runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startConsole(rt: EdgeRuntime): Server {
  const { adminPassword, consolePort, consoleHost } = rt.cfg;
  const wsSecret = randomBytes(32);
  const app = express();
  app.disable('x-powered-by');

  // RGB frames from verification rigs. Before the admin check because the
  // sender is a node, not a person: it signs each frame with the site key
  // over (uid, timestamp, sha256(jpeg)). Only nodes flagged "rgb" in
  // nodes.json are accepted; frames live in memory and reach only this console.
  const lastRgbTs = new Map<string, number>();
  app.post('/api/demo/rgb/:uid', express.raw({ type: 'image/jpeg', limit: '600kb' }), (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    const node = rt.reg.nodes.get(uid);
    if (!node?.rgb) return res.status(403).json({ error: 'not an RGB-enabled node' });
    const ts = Number(req.get('x-tm-ts'));
    const now = Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 30_000 || ts <= (lastRgbTs.get(uid) ?? 0)) {
      return res.status(401).json({ error: 'stale or replayed frame' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) return res.status(400).json({ error: 'not a JPEG' });
    const msg = `${uid}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`;
    const got = req.get('x-tm-sig') ?? '';
    const ok = rt.cfg.keys.some((k) => safeEqual(got, createHmac('sha256', k).update(msg).digest('hex')));
    if (!ok) return res.status(401).json({ error: 'bad signature' });
    lastRgbTs.set(uid, ts);
    rt.acceptRgb(uid, body, now);
    return res.status(204).end();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) return next();
    const h = req.headers.authorization ?? '';
    const [scheme, b64] = h.split(' ');
    const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass && safeEqual(pass, adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="TMedge console"').status(401).send('authentication required');
  });

  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(join(ROOT, 'public-console'), { index: 'index.html' }));

  app.get('/api/layout', (_req, res) => res.json(rt.layout()));
  app.get('/api/state', (_req, res) => res.json(state(rt)));
  app.get('/api/nodes/:uid/rgb.jpg', (req, res) => {
    const f = rt.rgb.get((req.params.uid ?? '').toLowerCase());
    if (!f) return res.status(404).end();
    return res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).send(f.jpeg);
  });
  app.get('/api/nodes/:uid/raw', (req, res) => {
    const raw = rt.lastRaw(req.params.uid ?? '');
    if (!raw) return res.status(404).json({ error: 'no raw frame from this node yet (is raw_every 0?)' });
    return res.json(raw);
  });

  const mutating = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-tm-console') !== '1') return res.status(403).json({ error: 'missing x-tm-console header' });
    return next();
  };

  app.post('/api/nodes/:uid/command', mutating, async (req, res) => {
    const uid = req.params.uid ?? '';
    const body = (req.body ?? {}) as { op?: string; param?: string; value?: number };
    try {
      switch (body.op) {
        case 'set': {
          const id = PARAM_NAMES.indexOf(body.param as (typeof PARAM_NAMES)[number]);
          if (id < 0 || typeof body.value !== 'number' || !Number.isInteger(body.value)) {
            return res.status(400).json({ error: `set needs param (one of ${PARAM_NAMES.join(', ')}) and an integer value` });
          }
          await rt.ingest.sendCommand(uid, CMD_SET_PARAM, id, body.value);
          break;
        }
        case 'reset-bg': await rt.ingest.sendCommand(uid, CMD_RESET_BACKGROUND); break;
        case 'identify': await rt.ingest.sendCommand(uid, CMD_IDENTIFY, 0, typeof body.value === 'number' ? body.value : 10); break;
        case 'save': await rt.ingest.sendCommand(uid, CMD_SAVE_PARAMS); break;
        case 'reboot': await rt.ingest.sendCommand(uid, CMD_REBOOT); break;
        default: return res.status(400).json({ error: 'op must be set | reset-bg | identify | save | reboot' });
      }
      return res.json({ sent: true, note: 'applied when the node acknowledges in its next STATUS (last_cmd)' });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/nodes/:uid/reset-cursor', mutating, (req, res) => {
    res.json({ reset: rt.ingest.resetCursor(req.params.uid ?? '') });
  });

  // A short-lived token for the WebSocket, which cannot carry basic auth reliably.
  app.get('/api/ws-token', (_req, res) => {
    const exp = Date.now() + 60_000;
    res.json({ token: `${exp}.${createHmac('sha256', wsSecret).update(String(exp)).digest('hex')}` });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const subs = new Map<WebSocket, Set<string>>();

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const [exp, mac] = (url.searchParams.get('token') ?? '').split('.');
    const ok = url.pathname === '/ws' && exp && mac && Number(exp) > Date.now() &&
      safeEqual(mac, createHmac('sha256', wsSecret).update(exp).digest('hex'));
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      subs.set(ws, new Set());
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as { type?: string; uids?: unknown };
          if (msg.type === 'subscribe' && Array.isArray(msg.uids)) {
            subs.set(ws, new Set(msg.uids.filter((u): u is string => typeof u === 'string').slice(0, 16)));
          }
        } catch {
          /* ignore malformed client messages */
        }
      });
      ws.on('close', () => subs.delete(ws));
      ws.send(JSON.stringify({ type: 'state', ...state(rt) }));
    });
  });

  const broadcast = (msg: unknown, filter?: (ws: WebSocket) => boolean) => {
    const s = JSON.stringify(msg);
    for (const ws of subs.keys()) if (ws.readyState === ws.OPEN && (!filter || filter(ws))) ws.send(s);
  };
  rt.on('report', (uid, dets, at) => broadcast({ type: 'report', uid, at, dets }));
  rt.on('raw', (raw) => broadcast({ type: 'raw', ...raw }, (ws) => subs.get(ws)?.has(raw.uid) ?? false));
  rt.on('rgb', (uid, jpeg, at) => broadcast({ type: 'rgb', uid, at, jpeg: jpeg.toString('base64') }, (ws) => subs.get(ws)?.has(uid) ?? false));
  setInterval(() => broadcast({ type: 'state', ...state(rt) }), 1000).unref();

  server.listen(consolePort, consoleHost);
  return server;
}

function state(rt: EdgeRuntime) {
  const now = Date.now();
  return {
    health: rt.health(now),
    nodes: rt.nodes(now),
    snapshot: rt.latest,
    authorities: rt.engine.authorities(),
    dwell: Object.fromEntries([...rt.dwell].map(([id, d]) => [id, d.toJSON()])),
  };
}
