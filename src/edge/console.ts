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
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { FirmwareBuildJobService } from '../modules/firmware/application/firmware-build-job-service.js';
import { FirmwareBuildJobs } from '../modules/firmware/application/firmware-build-jobs.js';
import { createFirmwareRouter } from '../modules/firmware/routes/firmware-router.js';
import { FirmwareStoreExecutor } from '../infrastructure/firmware-build/firmware-store-executor.js';
import { RolloutImageUsageQuery } from '../infrastructure/firmware-build/rollout-image-usage-query.js';
import { Provisioning } from './provisioning.js';
import { AdoptionCredentials } from './adoption-credentials.js';
import { createAdoptionRouter } from '../modules/provisioning/routes/adoption-router.js';
import { FileProvisioningService } from '../infrastructure/provisioning/file-provisioning-service.js';
import type { ProvisioningService } from '../modules/provisioning/application/provisioning-service.js';
import { createProvisioningAdminRouter, createProvisioningToolRouter } from '../modules/provisioning/routes/provisioning-routers.js';
import { applicationErrorHandler } from '../infrastructure/http/errors.js';
import { ApplicationError } from '../modules/shared/application/contracts.js';
import type { EdgeRuntime } from './runtime.js';
import { ExecuteNodeCommand } from '../modules/nodes/application/execute-node-command.js';
import { ResetNodeCursor } from '../modules/nodes/application/reset-node-cursor.js';
import { createNodeRouter } from '../modules/nodes/routes/node-router.js';
import { FirmwareBuildWorkerClient } from '../infrastructure/firmware-build/firmware-build-worker-client.js';
import { asyncHandler } from '../infrastructure/http/errors.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { sendLatest } from '../shared/fanout.js';
import { requestUrl, sameOrigin } from '../shared/http.js';
import type { RawFrameMessage } from '../shared/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const consoleCleanups = new WeakMap<Server, () => Promise<void>>();
const MAX_SUBSCRIPTIONS = 64;

export interface ConsoleCore {
  machine: Router;
  provisioningTool: Router;
  adoption: Router;
  flasherCredentials: AdoptionCredentials;
  provisioningService: ProvisioningService;
  ui: Router;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string, access?: { binding: string; valid(): boolean }): boolean;
  closeSessions(binding: string): void;
  dispose(): Promise<void>;
}

export function createConsole(rt: EdgeRuntime, options: ConsoleOptions = {}): ConsoleCore {
  const registration = options.provisioningService ?? new FileProvisioningService(new Provisioning(rt.reg, {
    token: rt.cfg.flashToken,
    nodesPath: rt.cfg.nodesPath,
    auditPath: join(rt.cfg.dataDir, 'provisioning.jsonl'),
  }));
  const credentials = new AdoptionCredentials(join(rt.cfg.dataDir, 'flasher-credentials.json'));
  const provisioningService: ProvisioningService = {
    get enabled() { return registration.enabled || credentials.list().length > 0; },
    authorize: token => registration.authorize(token) || credentials.authorize(token),
    ready: () => registration.ready(),
    request: (input, from) => registration.request(input, from),
    statusOf: uid => registration.statusOf(uid), requests: () => registration.requests(),
    approve: async (id, actor) => {
      const request = (await registration.requests()).find(item => item.id === id);
      // Both console entry points must enforce the same device-key policy.
      // Admission alone cannot supply a board's authentication key.
      if (request && rt.cfg.devices && !rt.cfg.devices.keys(request.uid).length && !rt.cfg.devices.allowsLegacy(request.uid)) {
        throw new ApplicationError('conflict', 'enrol this device in the device key policy before approving; authentication is required');
      }
      return registration.approve(id, actor);
    },
    deny: (id, actor) => registration.deny(id, actor),
  };
  const firmwareBuildWorker = new FirmwareBuildWorkerClient();
  const firmwareBuildJobs: FirmwareBuildJobService = options.firmwareBuildJobs ?? new FirmwareBuildJobs(new FirmwareStoreExecutor(rt.firmware, firmwareBuildWorker));
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
  machine.post('/api/provision/request', express.json({ limit: '4kb' }));
  const provisioningTool = createProvisioningToolRouter({
    service: provisioningService,
    broadcast: (message) => broadcast(message),
  });
  machine.use('/api/provision', provisioningTool);

  const ui = express.Router();
  ui.use(express.json({ limit: '4kb' }));
  ui.get('/api/state', (_req, res) => res.json(state(rt)));
  const secret = randomBytes(32);
  const feeds = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const clients = new Map<WebSocket, { binding: string; valid(): boolean; subscriptions: Set<string> }>();
  ui.get('/api/ws-token', (req, res) => {
    const binding = String(res.locals.wsBinding ?? 'console');
    const expiresAt = Date.now() + 60_000;
    res.json({ token: `${expiresAt}.${createHmac('sha256', secret).update(`${expiresAt}:${binding}`).digest('hex')}` });
  });
  const broadcast = (message: unknown, filter?: (client: WebSocket) => boolean) => {
    const serialized = JSON.stringify(message);
    for (const [ws, client] of clients) {
      if (!client.valid()) { ws.terminate(); continue; }
      if (ws.readyState !== ws.OPEN) continue;
      // A slow browser is skipped instead of accumulating an unbounded feed.
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); continue; }
      if (!filter || filter(ws)) sendLatest(ws, serialized);
    }
  };
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
  // Module 04 owns OTA in the algo console. Keep the original panel when
  // ALGO_PORT=0, where this document is the only admin UI available.
  ui.get(['/', '/index.html'], (_req, res) => {
    let html = readFileSync(join(ROOT, 'public-console', 'index.html'), 'utf8');
    if (res.locals.embeddedConsole) {
      html = html.replace(/<!-- firmware:start -->[\s\S]*?<!-- firmware:end -->/, '');
      // The algo console around it is Gray 100 only; a frame that followed a
      // light system setting would be a white slab under a dark header.
      html = html.replace('<html lang="en">', '<html lang="en" data-theme="dark">');
    }
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });
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
  ui.get('/healthz', (_req, res) => res.status(200).json({ live: true }));
  ui.get('/readyz', asyncHandler(async (_req, res) => {
    const persistenceAvailable = rt.persistenceAvailable ? await rt.persistenceAvailable().catch(() => false) : null;
    const buildStatus = firmwareBuildJobs.operationalStatus
      ? await firmwareBuildJobs.operationalStatus().catch(() => ({ unavailable: true }))
      : null;
    return res.status(200).json({
      live: true,
      ready: rt.isStarted,
      components: {
        ingestion: { ready: rt.isStarted, packetsPerSec: rt.ingest.rates().packetsPerSec },
        snapshotPublishing: {
          targets: rt.publisher.status,
          lastSnapshotAt: rt.latest.generatedAt,
          ageMs: Math.max(0, Date.now() - rt.latest.generatedAt),
          freshness: Date.now() - rt.latest.generatedAt <= 2 * rt.cfg.publishMs ? 'current' : 'stale',
        },
        persistence: {
          mode: rt.cfg.persistenceMode,
          available: persistenceAvailable,
          adminWritesAvailable: persistenceAvailable === false ? false : true,
        },
        recording: rt.recorder.health(),
        occupancyHistory: rt.occupancyHistory?.stats() ?? null,
        firmwareBuilds: buildStatus,
      },
    });
  }));
  const mutating = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-tm-console') !== '1') return res.status(403).json({ error: 'missing x-tm-console header' });
    return next();
  };

  ui.use('/api/nodes', createNodeRouter({
    reads: {
      rgb: (uid) => rt.rgb.get(uid) ?? null,
      raw: (uid) => rt.lastRaw(uid),
    },
    executeCommand: new ExecuteNodeCommand(({ uid, opcode, argument, value }) =>
      rt.commandOutcomes
        ? rt.commandOutcomes.send({ uid, opcode, argument, value }, { id: 'console', kind: 'console' })
        : rt.ingest.sendCommand(uid, opcode, argument, value).then(() => undefined)),
    resetCursor: new ResetNodeCursor((uid) => rt.ingest.resetCursor(uid)),
    mutating,
  }));

  ui.use('/api/provision', createProvisioningAdminRouter({
    service: provisioningService,
    mutating,
    broadcast: (message) => broadcast(message),
    actor: req => req.res?.locals.user ? `algo:${String(req.res.locals.user)}` : 'console',
  }));

  const imageInUse = new RolloutImageUsageQuery(rt.rollouts);
  rt.firmware.cleanup(imageInUse);
  ui.use('/api', createFirmwareRouter({
    firmware: rt.firmware,
    buildJobs: firmwareBuildJobs,
    rollouts: rt.rolloutService,
    imageInUse,
    mutating,
    buildWorkerConfigured: () => firmwareBuildWorker.configured,
  }));

  ui.use(applicationErrorHandler);
  machine.use(applicationErrorHandler);
  const onSnapshot = () => broadcast({ type: 'state', ...state(rt) });
  const onRaw = (raw: RawFrameMessage) => broadcast({ type: 'raw', ...raw }, (ws) => clients.get(ws)?.subscriptions.has(raw.uid) ?? false);
  const onRgb = (uid: string, jpeg: Buffer, at: number) => broadcast({ type: 'rgb', uid, at, jpeg: jpeg.toString('base64') }, (ws) => clients.get(ws)?.subscriptions.has(uid) ?? false);
  rt.on('snapshot', onSnapshot);
  const onReport = (uid: string, dets: unknown, at: number) => broadcast({ type: 'report', uid, at, dets });
  rt.on('report', onReport);
  rt.on('raw', onRaw);
  rt.on('rgb', onRgb);
  const stateTimer = setInterval(() => broadcast({ type: 'state', ...state(rt) }), 1000);
  stateTimer.unref();
  let disposal: Promise<void> | null = null;
  return {
    flasherCredentials: credentials,
    provisioningService,
    provisioningTool,
    adoption: createAdoptionRouter(rt, provisioningService, credentials),
    machine,
    ui,
    upgrade(req, socket, head, path, access) {
      socket.on('error', () => socket.destroy());
      const url = requestUrl(req.url);
      if (disposal || !url || url.pathname !== path || !sameOrigin(req) || clients.size >= 64 || (access && !access.valid())) return false;
      const [expiry, mac] = (url.searchParams.get('token') ?? '').split('.');
      const binding = access?.binding ?? 'console';
      const expected = expiry ? createHmac('sha256', secret).update(`${expiry}:${binding}`).digest('hex') : '';
      if (!expiry || !mac || !Number.isFinite(Number(expiry)) || Number(expiry) <= Date.now() || !safeEqual(mac, expected)) return false;
      feeds.handleUpgrade(req, socket, head, (ws) => {
        const currentAccess = access ?? { binding, valid: () => true };
        const subscriptions = new Set<string>();
        clients.set(ws, { binding, valid: currentAccess.valid, subscriptions });
        ws.on('message', (data) => {
          if (!currentAccess.valid()) { ws.terminate(); return; }
          try {
            const message = JSON.parse(String(data)) as { type?: string; uids?: unknown };
            if (message.type === 'subscribe' && Array.isArray(message.uids)) {
              subscriptions.clear();
              for (const uid of message.uids.slice(0, MAX_SUBSCRIPTIONS)) if (typeof uid === 'string') subscriptions.add(uid);
            }
          } catch { /* malformed client messages are ignored */ }
        });
        ws.on('close', () => clients.delete(ws));
        ws.on('error', () => ws.terminate());
        ws.send(JSON.stringify({ type: 'state', ...state(rt) }));
      });
      return true;
    },
    closeSessions(binding) {
      for (const [ws, current] of clients) if (current.binding === binding) ws.terminate();
    },
    dispose() {
      if (disposal) return disposal;
      clearInterval(stateTimer);
      rt.off('snapshot', onSnapshot);
      rt.off('report', onReport);
      rt.off('raw', onRaw);
      rt.off('rgb', onRgb);
      for (const ws of clients.keys()) ws.terminate();
      disposal = Promise.all([
        new Promise<void>((resolve) => feeds.close(() => resolve())),
        firmwareBuildJobs.dispose?.() ?? Promise.resolve(),
      ]).then(() => undefined);
      return disposal;
    },
  };
}

export function consoleMovedTo(port: number): (req: Request) => string {
  return (req) => {
    const host = req.get('host') ?? 'localhost';
    if (host === 'console.hkumyseat.com') return 'https://algo.hkumyseat.com/console';
    const hostname = host.replace(/:\d+$/, '');
    return `http://${hostname}:${port}/console`;
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface ConsoleOptions {
  firmwareBuildJobs?: FirmwareBuildJobService;
  provisioningService?: ProvisioningService;
  listen?: boolean;
  uiMovedTo?: (req: Request) => string;
}

export function startConsole(rt: EdgeRuntime, optionsOrCore: ConsoleOptions | ConsoleCore = {}, additionalOptions: ConsoleOptions = {}): Server {
  const options = 'ui' in optionsOrCore ? additionalOptions : optionsOrCore;
  const core = 'ui' in optionsOrCore ? optionsOrCore : createConsole(rt, options);
  const { adminPassword, consolePort, consoleHost } = rt.cfg;
  const app = express();
  app.disable('x-powered-by');
  app.use(core.machine);
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) return next();
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const password = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    if (password && safeEqual(password, adminPassword)) return next();
    return res.set('WWW-Authenticate', 'Basic realm="TMedge console"').status(401).send('authentication required');
  };
  app.get(['/healthz', '/readyz'], requireAdmin, core.ui);
  const moved = options.uiMovedTo;
  if (moved) {
    app.use((req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        return res.status(410).json({ error: 'the console moved', location: moved(req) });
      }
      const to = moved(req).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
      return res.status(200).set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'").type('html').send(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${to}">`
        + `<title>The console moved</title><p>The console is now module 03 of the algo console: <a href="${to}">${to}</a></p>`,
      );
    });
  } else {
    app.use(requireAdmin);
    app.use(core.ui);
  }
  app.use(applicationErrorHandler);
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (moved || !core.upgrade(req, socket, head, '/ws')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });
  consoleCleanups.set(server, () => core.dispose());
  server.once('close', () => { void core.dispose(); });
  if (options.listen !== false) server.listen(consolePort, consoleHost);
  return server;
}

/** Awaits console-owned WebSocket and firmware worker cleanup. */
export function stopConsole(server: Server): Promise<void> {
  return consoleCleanups.get(server)?.() ?? Promise.resolve();
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
