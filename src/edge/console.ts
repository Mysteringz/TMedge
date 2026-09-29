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
import { sendLatest } from '../shared/fanout.js';
import { FirmwareStore } from './firmware.js';
import { FirmwareBuildJobs } from '../modules/firmware/application/firmware-build-jobs.js';
import { createFirmwareRouter } from '../modules/firmware/routes/firmware-router.js';
import { FirmwareStoreExecutor } from '../infrastructure/firmware-build/firmware-store-executor.js';
import { RolloutImageUsageQuery } from '../infrastructure/firmware-build/rollout-image-usage-query.js';
import { Provisioning } from './provisioning.js';
import { CMD_IDENTIFY, CMD_REBOOT, CMD_RESET_BACKGROUND, CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_LIMITS, PARAM_NAMES } from './protocol.js';
import type { EdgeRuntime } from './runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How many nodes one console may watch raw frames from at once. */
const MAX_SUBSCRIPTIONS = 64;

export function startConsole(rt: EdgeRuntime, options: { firmwareBuildJobs?: FirmwareBuildJobs } = {}): Server {
  const { adminPassword, consolePort, consoleHost } = rt.cfg;
  const provisioning = new Provisioning(rt.reg, {
    token: rt.cfg.flashToken,
    nodesPath: rt.cfg.nodesPath,
    auditPath: join(rt.cfg.dataDir, 'provisioning.jsonl'),
  });
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

  /**
   * The firmware image itself, for a node that talks to this edge directly;
   * one behind a gateway fetches from its gateway instead. Before the admin
   * check for the same reason as the RGB endpoint: the caller is a node, not
   * a person. It is safe to serve: the release build bakes in no secrets, and
   * the node accepts the bytes only if they hash to the SHA-256 in the signed
   * request that sent it here.
   */
  app.get('/fw/:image', (req, res) => {
    const id = /^([0-9a-f]{16})\.bin$/.exec(req.params.image ?? '')?.[1];
    const bytes = id ? rt.firmware.bytes(id) : null;
    if (!bytes) return res.status(404).end();
    res.set('Content-Type', 'application/octet-stream');
    return res.end(bytes);
  });

  /**
   * TMflash asking for a freshly flashed node to be let in. Before the admin
   * check because the caller is a provisioning tool holding its own token,
   * not a person with a console session -- and the token buys exactly one
   * thing: a row in a list somebody still has to approve.
   */
  const bearer = (req: Request): string | null => {
    const h = req.headers.authorization ?? '';
    const [scheme, value] = h.split(' ');
    return scheme === 'Bearer' && value ? value : null;
  };
  const provisionAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!provisioning.authorise(bearer(req))) {
      // Identical for "provisioning is off" and "wrong token": which of the
      // two it is is not an unauthenticated caller's business.
      return res.status(401).json({ error: 'provisioning is not available with that token' });
    }
    return next();
  };

  app.post('/api/provision/request', express.json({ limit: '4kb' }), provisionAuth, (req, res) => {
    try {
      const out = provisioning.request((req.body ?? {}) as Record<string, unknown>, req.socket.remoteAddress ?? '?');
      if (out.status === 'already-registered') return res.json({ status: 'registered', uid: out.uid });
      // Put it on every open console at once: commissioning is someone
      // standing at a node waiting, not a queue checked later.
      broadcast({ type: 'join_request', request: out.request });
      return res.status(202).json({ status: 'pending', id: out.request.id, uid: out.request.uid });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  /** TMflash polls this while it waits for someone to click Allow. */
  app.get('/api/provision/status/:uid', provisionAuth, (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    return res.json({ uid, status: provisioning.statusOf(uid) });
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
  // Never cached. Express would send max-age=0 with an ETag, which is correct
  // and not enough: Cloudflare caches by file extension in front of this, so a
  // .js file can be served from the edge long after a deploy -- the same trap
  // that once left the student site on last week's stylesheet. There are a
  // handful of admins on this page and revalidating costs nothing, so the
  // whole class of "is this the new one?" simply goes away.
  app.use(express.static(join(ROOT, 'public-console'), {
    index: 'index.html',
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  }));

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

  /**
   * The console's half of provisioning: see what is waiting, and answer it.
   * Behind the admin password and the custom header, like every other write
   * here -- admitting a node is a change to which devices the edge trusts.
   */
  app.get('/api/provision/requests', (_req, res) => {
    res.json({ enabled: provisioning.enabled, requests: provisioning.requests() });
  });

  app.post('/api/provision/requests/:id/:verdict', mutating, (req, res) => {
    const { id = '', verdict = '' } = req.params;
    if (verdict !== 'approve' && verdict !== 'deny') {
      return res.status(400).json({ error: 'verdict must be approve or deny' });
    }
    try {
      if (verdict === 'deny') {
        const req_ = provisioning.deny(id, 'console');
        broadcast({ type: 'join_resolved', id, uid: req_.uid, verdict });
        return res.json({ ok: true, uid: req_.uid });
      }
      const node = provisioning.approve(id, 'console');
      broadcast({ type: 'join_resolved', id, uid: node.uid, verdict });
      return res.json({ ok: true, uid: node.uid, label: node.label, placed: false });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

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
          // The node refuses an out-of-range value in silence, so sending one
          // looks like success and changes nothing. Say no here instead.
          const limits = PARAM_LIMITS[body.param as (typeof PARAM_NAMES)[number]];
          if (limits && (body.value < limits.lo || body.value > limits.hi)) {
            return res.status(400).json({ error: `the node only accepts ${body.param} between ${limits.lo} and ${limits.hi}; it would ignore ${body.value}` });
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
  const firmwareBuildJobs = options.firmwareBuildJobs ?? new FirmwareBuildJobs(new FirmwareStoreExecutor(rt.firmware));
  app.use('/api', createFirmwareRouter({
    firmware: rt.firmware,
    buildJobs: firmwareBuildJobs,
    rollouts: rt.rollouts,
    imageInUse: new RolloutImageUsageQuery(rt.rollouts),
    mutating,
    pioInstalled: () => FirmwareStore.findPio() !== null,
  }));

  app.get('/api/ws-token', (_req, res) => {
    const exp = Date.now() + 60_000;
    res.json({ token: `${exp}.${createHmac('sha256', wsSecret).update(String(exp)).digest('hex')}` });
  });

  const server = createServer(app);
  server.once('close', () => firmwareBuildJobs.dispose());
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
            // The cap is there so one console cannot ask the edge to fan out
            // every node's raw frames forever; it has to be above the number
            // of nodes a site actually has, or the console quietly stops
            // showing the ones past the limit. 21 nodes (two sites' worth of
            // simulation plus the real ones) already passed the old 16.
            subs.set(ws, new Set(msg.uids.filter((u): u is string => typeof u === 'string').slice(0, MAX_SUBSCRIPTIONS)));
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
    // A browser that is behind is skipped, not queued for (sendLatest).
    for (const ws of subs.keys()) if (!filter || filter(ws)) sendLatest(ws, s);
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
