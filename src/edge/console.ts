/**
 * The debug console: admin-only HTTP + WebSocket on the edge.
 *
 * It shows raw thermal frames, so imagery reaches a browser here (and in the
 * algo console, which now hosts it as module 03). That is why it lives on the
 * edge (never the web tier), requires a sign-in, and without ADMIN_PASSWORD
 * binds to localhost only (see config.ts).
 *
 * Built as a core with two routers so it can be served in two places with one
 * set of state -- one provisioning queue, one live feed:
 * - `machine`: rig RGB uploads, firmware downloads, TMflash. Their callers are
 *   devices with their own credentials, so these stay on CONSOLE_PORT, where
 *   the rig bridge and nodes already send them.
 * - `ui`: the console a person uses. Mounted by the algo console at
 *   /console-app/ behind its sign-in; on CONSOLE_PORT only when the algo
 *   console is off, behind Basic auth as before.
 *
 * Commands to nodes are POSTs that need a custom header, which a cross-site
 * form cannot send -- basic-auth credentials are attached by the browser
 * automatically, so without it any page the admin visits could reboot nodes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { sendLatest } from '../shared/fanout.js';
import { requestUrl, sameOrigin } from '../shared/http.js';
import { FirmwareStore } from './firmware.js';
import { Provisioning } from './provisioning.js';
import { CMD_IDENTIFY, CMD_REBOOT, CMD_RESET_BACKGROUND, CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_LIMITS, PARAM_NAMES } from './protocol.js';
import type { RolloutTarget } from './rollout.js';
import type { EdgeRuntime } from './runtime.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How many nodes one console may watch raw frames from at once. */
const MAX_SUBSCRIPTIONS = 64;

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ConsoleCore {
  /** Endpoints for devices and TMflash: their own credentials, never a person's. */
  machine: Router;
  /** The console a person uses. The caller puts its own sign-in in front. */
  ui: Router;
  /**
   * Takes a WebSocket upgrade for the live feed if it is for `path` and
   * carries a valid token (from the ui router's /api/ws-token). False means
   * not ours or not allowed; the caller answers.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string, access?: { binding: string; valid(): boolean }): boolean;
  /** Close feeds authenticated by a session that has just logged out. */
  closeSessions(binding: string): void;
}

/** Who did it, for provisioning, firmware and rollout records. */
const who = (res: Response) => (typeof res.locals.user === 'string' ? `console:${res.locals.user}` : 'console');

export function createConsole(rt: EdgeRuntime): ConsoleCore {
  const provisioning = new Provisioning(rt.reg, {
    token: rt.cfg.flashToken,
    nodesPath: rt.cfg.nodesPath,
    auditPath: join(rt.cfg.dataDir, 'provisioning.jsonl'),
  });
  const wsSecret = randomBytes(32);
  const machine = express.Router();

  // RGB frames from verification rigs. Before the admin check because the
  // sender is a node, not a person: it signs each frame with the site key
  // over (uid, timestamp, sha256(jpeg)). Only nodes flagged "rgb" in
  // nodes.json are accepted; frames live in memory and reach only this console.
  const lastRgbTs = new Map<string, number>();
  machine.post('/api/demo/rgb/:uid', express.raw({ type: 'image/jpeg', limit: '600kb' }), (req, res) => {
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
  machine.get('/fw/:image', (req, res) => {
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

  machine.post('/api/provision/request', express.json({ limit: '4kb' }), provisionAuth, (req, res) => {
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
  machine.get('/api/provision/status/:uid', provisionAuth, (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    return res.json({ uid, status: provisioning.statusOf(uid) });
  });

  const ui = express.Router();
  ui.use(express.json({ limit: '4kb' }));
  // public-console/index.html is tracked; the modules it loads are compiled
  // into public-console/js by `npm run build` and are not. A fresh checkout
  // therefore serves a page that loads, 404s its own script and sits there
  // blank, so an unbuilt console says so on the page and in the edge's log
  // instead. After the admin check, like everything else a person can read.
  const consoleEntry = join(ROOT, 'public-console', 'js', 'console-client', 'app.js');
  if (!existsSync(consoleEntry)) {
    console.warn('[edge] console UI is not built (missing public-console/js/console-client/app.js): run `npm run build`');
    ui.get(['/', '/index.html'], (_req, res) => {
      res.status(503).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>TMedge console</title>'
        + '<body style="font:16px/1.5 system-ui;padding:2rem;max-width:40rem">'
        + '<h1>The console UI is not built</h1>'
        + '<p>Run <code>npm run build</code> in the release directory, then reload this page.</p>',
      );
    });
  }
  // Never cached. Express would send max-age=0 with an ETag, which is correct
  // and not enough: Cloudflare caches by file extension in front of this, so a
  // .js file can be served from the edge long after a deploy -- the same trap
  // that once left the student site on last week's stylesheet. There are a
  // handful of admins on this page and revalidating costs nothing, so the
  // whole class of "is this the new one?" simply goes away.
  ui.use(express.static(join(ROOT, 'public-console'), {
    index: 'index.html',
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  }));

  ui.get('/api/layout', (_req, res) => res.json(rt.layout()));
  ui.get('/api/state', (_req, res) => res.json(state(rt)));
  ui.get('/api/nodes/:uid/rgb.jpg', (req, res) => {
    const f = rt.rgb.get((req.params.uid ?? '').toLowerCase());
    if (!f) return res.status(404).end();
    return res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).send(f.jpeg);
  });
  ui.get('/api/nodes/:uid/raw', (req, res) => {
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
  ui.get('/api/provision/requests', (_req, res) => {
    res.json({ enabled: provisioning.enabled, requests: provisioning.requests() });
  });

  ui.post('/api/provision/requests/:id/:verdict', mutating, (req, res) => {
    const { id = '', verdict = '' } = req.params;
    if (verdict !== 'approve' && verdict !== 'deny') {
      return res.status(400).json({ error: 'verdict must be approve or deny' });
    }
    try {
      if (verdict === 'deny') {
        const req_ = provisioning.deny(id, who(res));
        broadcast({ type: 'join_resolved', id, uid: req_.uid, verdict });
        return res.json({ ok: true, uid: req_.uid });
      }
      const node = provisioning.approve(id, who(res));
      broadcast({ type: 'join_resolved', id, uid: node.uid, verdict });
      return res.json({ ok: true, uid: node.uid, label: node.label, placed: false });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

  ui.post('/api/nodes/:uid/command', mutating, async (req, res) => {
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

  ui.post('/api/nodes/:uid/reset-cursor', mutating, (req, res) => {
    res.json({ reset: rt.ingest.resetCursor(req.params.uid ?? '') });
  });

  // A short-lived token for the WebSocket, which cannot carry basic auth reliably.
  // --- firmware updates ----------------------------------------------------
  // The console uploads a PlatformIO project file by file, builds it here,
  // and rolls the image out. Raw bodies, one file per request: multipart
  // would mean a parser dependency for no gain.

  let building: { uploadId: string; startedAt: number; log: string[]; error?: string } | null = null;

  ui.get('/api/firmware', (_req, res) => res.json({
    pio: FirmwareStore.findPio() !== null,
    builds: rt.firmware.list(),
    building: building ? { startedAt: building.startedAt, log: building.log.slice(-40), error: building.error } : null,
    rollout: rt.rollouts.current(),
    history: rt.rollouts.history(),
    diskBytes: rt.firmware.diskBytes(),
  }));

  ui.post('/api/firmware/uploads', mutating, (_req, res) => {
    try {
      res.json({ uploadId: rt.firmware.startUpload(who(res)) });
    } catch (err) {
      res.status(429).json({ error: (err as Error).message });
    }
  });

  ui.post('/api/firmware/uploads/:id/files', mutating, express.raw({ type: '*/*', limit: '8mb' }), (req, res) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      rt.firmware.addFile(req.params.id ?? '', path, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  ui.post('/api/firmware/uploads/:id/build', mutating, (req, res) => {
    // A build that failed is history, not a queue: starting another one is
    // exactly what someone does next.
    if (building && !building.error) return res.status(409).json({ error: 'a build is already running' });
    const uploadId = req.params.id ?? '';
    building = { uploadId, startedAt: Date.now(), log: [] };
    // Compiling takes minutes; the console polls /api/firmware for progress.
    void rt.firmware.build(uploadId, who(res))
      .then(() => { building = null; })
      .catch((err: unknown) => {
        rt.firmware.discard(uploadId);
        const log = (err as { log?: string[] }).log ?? [];
        building = { uploadId, startedAt: building?.startedAt ?? Date.now(), log, error: (err as Error).message };
        setTimeout(() => { if (building?.error) building = null; }, 5 * 60_000).unref();
      });
    return res.status(202).json({ ok: true });
  });

  ui.delete('/api/firmware/:id', mutating, (req, res) => {
    const current = rt.rollouts.current();
    if (current && current.buildId === req.params.id && current.stage !== 'done' && current.stage !== 'stopped') {
      return res.status(409).json({ error: 'that image is rolling out right now' });
    }
    return res.json({ ok: rt.firmware.remove(req.params.id ?? '') });
  });

  ui.post('/api/firmware/rollout', mutating, (req, res) => {
    const body = (req.body ?? {}) as { buildId?: string; target?: RolloutTarget };
    if (!body.buildId || !body.target) return res.status(400).json({ error: 'buildId and target are required' });
    try {
      return res.json(rt.rollouts.start(body.buildId, body.target, who(res)));
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  ui.post('/api/firmware/rollout/cancel', mutating, (_req, res) => {
    rt.rollouts.cancel(who(res));
    res.json({ ok: true });
  });

  ui.get('/api/ws-token', (_req, res) => {
    const exp = Date.now() + 60_000;
    const binding = String(res.locals.wsBinding ?? '');
    res.json({ token: `${exp}.${createHmac('sha256', wsSecret).update(`${exp}:${binding}`).digest('hex')}` });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const subs = new Map<WebSocket, Set<string>>();
  const accesses = new Map<WebSocket, { binding: string; valid(): boolean }>();

  const upgrade: ConsoleCore['upgrade'] = (req, socket, head, path, access = { binding: '', valid: () => true }) => {
    const url = requestUrl(req.url);
    if (!url || !sameOrigin(req) || subs.size >= 64 || !access.valid()) return false;
    const [exp, mac] = (url.searchParams.get('token') ?? '').split('.');
    const ok = url.pathname === path && exp && mac && Number(exp) > Date.now() &&
      safeEqual(mac, createHmac('sha256', wsSecret).update(`${exp}:${access.binding}`).digest('hex'));
    if (!ok) return false;
    wss.handleUpgrade(req, socket, head, (ws) => {
      subs.set(ws, new Set());
      accesses.set(ws, access);
      ws.on('error', () => ws.terminate());
      ws.on('message', (data) => {
        if (!access.valid()) { ws.terminate(); return; }
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
      ws.on('close', () => { subs.delete(ws); accesses.delete(ws); });
      ws.send(JSON.stringify({ type: 'state', ...state(rt) }));
    });
    return true;
  };

  const broadcast = (msg: unknown, filter?: (ws: WebSocket) => boolean) => {
    const s = JSON.stringify(msg);
    // A browser that is behind is skipped, not queued for (sendLatest).
    for (const ws of subs.keys()) {
      if (!accesses.get(ws)?.valid()) { ws.terminate(); continue; }
      if (!filter || filter(ws)) sendLatest(ws, s);
    }
  };
  rt.on('report', (uid, dets, at) => broadcast({ type: 'report', uid, at, dets }));
  rt.on('raw', (raw) => broadcast({ type: 'raw', ...raw }, (ws) => subs.get(ws)?.has(raw.uid) ?? false));
  rt.on('rgb', (uid, jpeg, at) => broadcast({ type: 'rgb', uid, at, jpeg: jpeg.toString('base64') }, (ws) => subs.get(ws)?.has(uid) ?? false));
  setInterval(() => broadcast({ type: 'state', ...state(rt) }), 1000).unref();

  return { machine, ui, upgrade, closeSessions: (binding) => {
    for (const [ws, access] of accesses) if (access.binding === binding) ws.terminate();
  } };
}

export interface ConsoleOptions {
  /**
   * Where the console a person uses lives now, when it is not here: the algo
   * console's /console. CONSOLE_PORT then serves only the device endpoints and
   * sends a browser on. Unset: the console is served here behind Basic auth.
   */
  uiMovedTo?: (req: Request) => string;
}

/**
 * Where a browser that opens the old console address belongs: module 03 of
 * the algo console. console.<domain> is the public name and only ever
 * reached through the Cloudflare tunnel, so it becomes https://algo.<domain>;
 * anything else (localhost, a LAN or tailnet address) is the same host on
 * the algo port.
 */
export function consoleMovedTo(algoPort: number): (req: Request) => string {
  return (req) => {
    const name = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
    if (/^console\./i.test(name)) return `https://algo.${name.slice('console.'.length)}/console`;
    return `http://${name}:${algoPort}/console`;
  };
}

export function startConsole(rt: EdgeRuntime, core: ConsoleCore = createConsole(rt), opts: ConsoleOptions = {}): Server {
  const { adminPassword, consolePort, consoleHost } = rt.cfg;
  const app = express();
  app.disable('x-powered-by');
  app.use(core.machine);

  const moved = opts.uiMovedTo;
  if (moved) {
    app.use((req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      // An API caller is told, not sent a page.
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        return res.status(410).json({ error: 'the console moved', location: moved(req) });
      }
      // A browser goes on to the new home -- with a 200 page that forwards
      // at once, not a 302. The deploy's health check probes this port's /
      // and accepts only 200 or 401, and the copy of that check production
      // runs is pinned on the box (/opt/tmedge-deploy, installed by hand;
      // a release cannot replace it). A 302 here rolled a release back on
      // 2026-10-04. The URL is built from the Host header, so it is escaped.
      const to = escapeHtml(moved(req));
      return res.status(200).set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'").type('html').send(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${to}">`
        + `<title>The console moved</title><p>The console is now module 03 of the algo console: <a href="${to}">${to}</a></p>`,
      );
    });
  } else {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!adminPassword) return next();
      const h = req.headers.authorization ?? '';
      const [scheme, b64] = h.split(' ');
      const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
      if (pass && safeEqual(pass, adminPassword)) return next();
      res.set('WWW-Authenticate', 'Basic realm="TMedge console"').status(401).send('authentication required');
    });
    app.use(core.ui);
  }

  const server = createServer(app);
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (moved || !core.upgrade(req, socket, head, '/ws')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });
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
