/**
 * The algo console's API: `algo.hkumyseat.com`.
 *
 * Separate port and separate app from the student web tier on purpose. This
 * one serves thermal imagery and writes parameters into live sensors, so it
 * belongs with the console on the edge, behind its own sign-in (auth.ts) and
 * the Cloudflare Access in front of it -- never on the tier students can
 * reach.
 */
import type { ConsoleDetection, RawFrameMessage } from '../shared/types.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { CMD_RESET_BACKGROUND } from '../edge/protocol.js';
import { createAlgoAuth, loadAlgoAuthConfig, safeAlgoNext, type AlgoAuthConfig } from './auth.js';
import type { EdgeRuntime } from '../edge/runtime.js';
import { JsonParameterAuditSink } from '../infrastructure/algo/json-parameter-audit-sink.js';
import { JsonPipelineRepository } from '../infrastructure/algo/json-pipeline-repository.js';
import { AlgoWebSocketAdapter } from './websocket-adapter.js';
import { createAlgoRouter } from './routes.js';
import { defaultPipeline } from './nodes.js';
import { PairRecorder } from './pairs.js';
import { TrainingSpool } from './training-spool.js';
import { recordModeOf } from './autorecord.js';
import { createTrain, trainRoot } from './train/routes.js';
import { EDGE_PARAMS, ParamBroker, REVERT_MS } from './params.js';
import { AlgoRuntime } from './runtime.js';
import type { Pipeline } from './types.js';
import { sendLatest } from '../shared/fanout.js';
import { requestUrl, sameOrigin } from '../shared/http.js';
import { encodeFrame } from './frames.js';
import { validate } from './graph.js';
import { NODE_SPECS, specOf } from './nodes.js';

export interface AlgoServerOptions { listen?: boolean; dataDir?: string }
interface ConsoleCore {
  ui: express.Router;
  upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, path: string, access?: { binding: string; valid(): boolean }): boolean;
  closeSessions(binding: string): void;
  dispose(): Promise<void>;
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-algo');

export interface AlgoServerHandle {
  server: Server;
  algo: AlgoRuntime;
  dispose(): Promise<void>;
}

export function startAlgo(
  rt: EdgeRuntime, port: number, host: string,
  authOrOptions: AlgoAuthConfig | AlgoServerOptions = {},
  /** The debug console, hosted here as module 03 when given (edge/console.ts). */
  consoleCore?: ConsoleCore,
): AlgoServerHandle {
  const options = 'enabled' in authOrOptions ? {} : authOrOptions;
  const authCfg: AlgoAuthConfig = 'enabled' in authOrOptions ? authOrOptions : loadAlgoAuthConfig(process.env, rt.cfg.adminPassword);
  const auth = createAlgoAuth(authCfg);
  const broker = new ParamBroker(rt);
  broker.start();
  const algo = new AlgoRuntime(rt, broker);
  const wsSecret = randomBytes(32);
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? join(ROOT, 'data');
  const dir = join(dataDir, 'algo', 'pipelines');
  mkdirSync(dir, { recursive: true });
  // Training data for the ML locator. It holds pictures of a room, so by
  // default it is kept only while the detector says somebody is in it
  // (autorecord.ts); "on" keeps everything, "off" nothing.
  const pairsDir = join(dataDir, 'algo', 'pairs');
  if (process.env.TRAINING_STORAGE && !['postgres', 'files'].includes(process.env.TRAINING_STORAGE)) {
    throw new Error('TRAINING_STORAGE must be postgres or files');
  }
  mkdirSync(pairsDir, { recursive: true });
  const spool = process.env.TRAINING_STORAGE === 'postgres'
    ? new TrainingSpool(join(dataDir, 'training'), join(pairsDir, 'recording.on')) : null;
  const pairs = spool ?? new PairRecorder({ dir: pairsDir });
  // The env var forces it on; otherwise the recorder remembers what it was
  // last told, so a deploy does not quietly stop a collection run.
  if (process.env.ALGO_RECORD_PAIRS === '1') pairs.setMode('on');

  /**
   * Which sensor the debugger opens on. A node that is sending pictures beats
   * one that is merely real: opening on an unpowered bench node shows an empty
   * screen and looks like the tool is broken.
   */
  const pickUid = (): string => {
    const all = [...rt.reg.nodes.values()];
    const health = rt.nodes();
    const online = (uid: string) => health.find((h) => h.uid === uid)?.online ?? false;
    const withFrames = all.find((n) => algo.frames.list(n.uid).length > 0);
    return (withFrames ?? all.find((n) => !n.simulated && online(n.uid)) ?? all.find((n) => online(n.uid)) ?? all[0])?.uid ?? '';
  };
  let pipeline: Pipeline = loadPipeline(dir, 'default') ?? defaultPipeline(pickUid());
  // Nothing has been heard from anyone at start-up, so revisit the choice once
  // frames have had a moment to arrive.
  const pickTimer = setTimeout(() => {
    if (algo.frames.list(pipeline.uid).length === 0) {
      const better = pickUid();
      if (better && better !== pipeline.uid) {
        pipeline = { ...pipeline, uid: better, updatedAt: Date.now() };
        algo.setPipeline(pipeline);
      }
    }
  }, 15_000).unref();
  algo.setPipeline(pipeline);

  // Frames arrive whether or not anyone is looking; the ring is what makes
  // stepping backwards possible at all.
  const onRaw = (msg: RawFrameMessage) => {
    if (!rt.reg.nodes.has(msg.uid)) return;
    algo.frames.addRaw(msg);
    const node = rt.reg.nodes.get(msg.uid);
    if (node && !node.simulated) spool?.raw(msg, { floorId: node.floorId, pose: node.pose, detector: node.detector });
    scheduleRun('frame');
  };
  rt.on('raw', onRaw);
  // Every RGB frame is offered to the recorder, which keeps it only when a
  // thermal frame of the same moment exists to pair it with.
  const onRgb = (uid: string, jpeg: Buffer, at: number) => {
    const node = rt.reg.nodes.get(uid);
    // No pose means no orientation to record the pair against.
    if (!node?.pose) return;
    pairs.offer(uid, jpeg, at, algo.frames, node.pose.mirror);
  };
  rt.on('rgb', onRgb);

  const onReport = (uid: string, dets: ConsoleDetection[]) => {
    if (!rt.reg.nodes.has(uid)) return;
    // The report's own frame number, not the last RAW's: they are only the
    // same when a RAW happened to arrive for that frame, and the whole point
    // of the pairing is to know when it did.
    const report = rt.lastReport(uid);
    if (report) algo.frames.addReport(uid, report.frame, dets, report.flags, report.boot);
    // Simulated people are not training data (onRaw keeps their frames out too).
    if (!rt.reg.nodes.get(uid)?.simulated) pairs.presence(uid, dets.reduce((n, d) => n + d.persons, 0));
  };
  rt.on('report', onReport);

  // Turnstile is a script plus an iframe from Cloudflare; allow exactly that
  // origin, and only when it is switched on. Fonts come from Google, as on
  // the student site.
  const cf = authCfg.turnstile ? ' https://challenges.cloudflare.com' : '';
  // frame-src 'self': module 03 is the debug console in a same-origin frame.
  const cspWith = (styleNonce?: string) => `default-src 'self'; script-src 'self'${cf}; frame-src 'self'${cf}; img-src 'self' data:; ` +
    `style-src 'self'${styleNonce ? ` 'nonce-${styleNonce}'` : ''} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; ` +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const csp = cspWith();

  /**
   * The one HTML page, for every screen. Read per request rather than at
   * start-up: an edge without a built client must still start (the tests, a
   * fresh checkout), and it costs a file read on a page nobody caches.
   */
  const sendShell = (res: Response) => {
    const index = join(PUBLIC, 'index.html');
    if (!existsSync(index)) return res.status(503).send('the algo dashboard is not built (npm run build)');
    // Module 02's editor (CodeMirror) writes its theme into one <style>
    // element, which style-src 'self' refuses. A fresh nonce per page admits
    // that element and nothing else; 'unsafe-inline' would admit anything.
    const nonce = randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', cspWith(nonce));
    return res.type('html').send(readFileSync(index, 'utf8')
      .replaceAll('{{turnstile}}', authCfg.turnstile?.siteKey ?? '').replaceAll('{{nonce}}', nonce));
  };

  const app = express();
  app.disable('x-powered-by');
  // cloudflared connects from loopback. Without this every visitor is
  // 127.0.0.1 to the sign-in limiter (ten wrong guesses by anyone would lock
  // out everyone) and no request looks like HTTPS, so the cookie would never
  // be marked Secure.
  if (authCfg.trustProxy) app.set('trust proxy', authCfg.trustProxy === true ? 'loopback' : authCfg.trustProxy);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set({
      'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
    });
    next();
  });

  // --- before sign-in: the form, the endpoints it posts to, the bundle -----
  app.use(auth.router);
  app.get(['/login', '/login/'], (req, res) => {
    if (auth.userOf(req)) return res.redirect(safeAlgoNext(req.query.next));
    return sendShell(res);
  });
  // The raw template would otherwise be served by the static handler below,
  // past the gate and with its placeholders still in.
  app.get('/index.html', (_req, res) => res.redirect('/'));
  // The bundle holds no data; it is what draws the sign-in page.
  app.use(express.static(PUBLIC, { index: false, setHeaders: (r) => r.set('Cache-Control', 'no-store') }));

  // --- everything else needs a signed-in engineer ---------------------------
  app.use(auth.requireUser);
  /** Who did it, for the audit log: a real account now, not a shared password. */
  const by = (res: Response) => `algo:${String(res.locals.user ?? 'unknown')}`;

  // Module 03: the debug console, as it is, in a frame of its own. Its page
  // is a separate document with its own global stylesheet and a module that
  // runs once per page load -- a frame keeps both from colliding with the
  // React app. Its CSP differs from the shell's in two ways: it may be
  // framed by this origin (and nothing else), and it shows rig RGB from
  // blob: URLs.
  if (consoleCore) {
    const consoleCsp = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; " +
      "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
    app.use('/console-app', (req: Request, res: Response, next: NextFunction) => {
      // Relative URLs in the console's page need the trailing slash.
      if (req.originalUrl === '/console-app') return res.redirect('/console-app/');
      res.set('Content-Security-Policy', consoleCsp);
      res.locals.wsBinding = auth.sessionToken(req);
      res.locals.embeddedConsole = true;
      return next();
    }, consoleCore.ui);
  }
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/me', (_req, res) => res.json({ user: res.locals.user, auth: authCfg.enabled }));

  /** Writes need a header a cross-site form cannot send. */
  const mutating = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-tm-algo') !== '1') return res.status(403).json({ error: 'missing x-tm-algo header' });
    return next();
  };

  // Module 02: training jobs for HKU HPC2021 (src/algo/train/, docs/hpc/).
  const train = createTrain({
    root: trainRoot(process.env.DATA_DIR || join(ROOT, 'data')),
    configPath: process.env.HPC_CONFIG || join(ROOT, 'config', 'hpc.json'),
    mutating,
    bindingOf: (req) => auth.sessionToken(req),
  });
  if (train.error) console.warn(`[algo] ${train.error}`);
  app.use('/api/train', train.router);

  app.get('/api/catalogue', (_req, res) => res.json({
    nodes: NODE_SPECS,
    edgeParams: EDGE_PARAMS,
    revertMs: REVERT_MS,
    preview: { available: algo.detector.unavailable === null, reason: algo.detector.unavailable },
  }));

  app.get('/api/sources', (_req, res) => {
    const health = rt.nodes();
    res.json({
      nodes: [...rt.reg.nodes.values()].map((n) => {
        const h = health.find((x) => x.uid === n.uid);
        const floor = rt.reg.floors.find((f) => f.id === n.floorId);
        return {
          uid: n.uid, label: n.label, floorId: n.floorId, simulated: n.simulated,
          /** A dual-cam rig: there is a live picture to show beside the thermal. */
          rgb: n.rgb,
          online: h?.online ?? false, rawEvery: h?.status?.params?.raw_every ?? null,
          frames: algo.frames.list(n.uid).length,
          /** A floor students can see: changing this node is visible to them. */
          published: floor ? floor.visibility === 'public' : false,
        };
      }),
    });
  });

  app.get('/api/pipeline', (_req, res) => res.json({
    pipeline,
    problems: validate(pipeline),
    dirty: algo.dirtyFor(pipeline),
    saved: readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
  }));

  app.put('/api/pipeline', mutating, (req, res) => {
    const next = req.body as Pipeline;
    if (!next || next.version !== 1 || !Array.isArray(next.nodes)) {
      return res.status(400).json({ error: 'not a pipeline' });
    }
    const problems = validate(next);
    if (problems.length > 0) return res.status(400).json({ error: problems[0]?.message, problems });
    pipeline = { ...next, updatedAt: Date.now() };
    algo.setPipeline(pipeline);
    scheduleRun('pipeline');
    return res.json({ ok: true, pipeline });
  });

  app.post('/api/pipeline/save', mutating, (req, res) => {
    const name = String((req.body as { name?: string }).name ?? '').replace(/[^a-z0-9-_]/gi, '');
    if (!name || name.length > 64) return res.status(400).json({ error: 'a name of 1-64 letters, digits, - and _ please' });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ ...pipeline, id: name }, null, 2));
    return res.json({ ok: true, name });
  });

  app.post('/api/pipeline/load', mutating, (req, res) => {
    const name = String((req.body as { name?: string }).name ?? '').replace(/[^a-z0-9-_]/gi, '');
    const loaded = name === 'default' && !existsSync(join(dir, 'default.json'))
      ? defaultPipeline(pipeline.uid)
      : loadPipeline(dir, name);
    if (!loaded) return res.status(404).json({ error: `no saved pipeline called ${name}` });
    pipeline = loaded;
    algo.setPipeline(pipeline);
    scheduleRun('pipeline');
    return res.json({ ok: true, pipeline });
  });

  app.post('/api/pipeline/reset', mutating, (_req, res) => {
    pipeline = defaultPipeline(pipeline.uid);
    algo.setPipeline(pipeline);
    scheduleRun('pipeline');
    res.json({ ok: true, pipeline });
  });

  app.get('/api/frames', (req, res) => {
    const uid = String(req.query.uid ?? pipeline.uid);
    res.json({ uid, frames: algo.frames.timeline(uid) });
  });

  app.get('/api/frame/:frame', (req, res) => {
    const uid = String(req.query.uid ?? pipeline.uid);
    const pair = algo.frames.get(uid, Number(req.params.frame));
    if (!pair) return res.status(404).json({ error: 'that frame is no longer in the ring' });
    return res.json({ ...encodeFrame(pair), observed: pair.deviceDetections });
  });

  app.post('/api/run', mutating, async (req, res) => {
    const body = (req.body ?? {}) as { frame?: number; only?: string };
    try {
      const result = await algo.run(pipeline, { frame: body.frame, only: body.only });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- the part that reaches outside this process -------------------------

  app.get('/api/params', (_req, res) => res.json({
    device: broker.deviceParams(pipeline.uid),
    edge: broker.edgeParams(),
    pending: broker.changes(),
    audit: broker.recent(50),
  }));

  app.post('/api/params/apply', mutating, async (req, res) => {
    const body = (req.body ?? {}) as { nodeId?: string; param?: string; value?: number; uid?: string };
    const n = pipeline.nodes.find((x) => x.id === body.nodeId);
    const spec = n ? specOf(n.type) : undefined;
    const ps = spec?.params.find((x) => x.id === body.param);
    if (!n || !spec || !ps) return res.status(400).json({ error: 'no such node parameter' });
    if (typeof body.value !== 'number' || !Number.isFinite(body.value)) {
      return res.status(400).json({ error: 'value must be a number' });
    }
    if (body.value < ps.min || body.value > ps.max) {
      return res.status(400).json({ error: `${ps.label} must be between ${ps.min} and ${ps.max}` });
    }
    if (ps.binding.kind === 'local') {
      // A debugger-only knob: keep it on the graph, touch nothing outside.
      n.params[ps.id] = body.value;
      scheduleRun('params');
      return res.json({ ok: true, local: true });
    }
    try {
      const change = await broker.apply({
        uid: body.uid ?? pipeline.uid, nodeId: n.id, param: ps.id,
        binding: ps.binding, value: body.value, by: by(res),
      });
      delete n.params[ps.id];   // it is the live value now, not an edit
      scheduleRun('params');
      return res.json({ ok: true, change });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/params/commit', mutating, (req, res) => {
    const { param, uid } = (req.body ?? {}) as { param?: string; uid?: string };
    const ok = broker.commit(uid ?? pipeline.uid, String(param), by(res));
    res.json({ ok });
  });

  app.post('/api/params/revert', mutating, async (req, res) => {
    const { param, uid } = (req.body ?? {}) as { param?: string; uid?: string };
    const ok = await broker.revert(uid ?? pipeline.uid, String(param), by(res));
    scheduleRun('params');
    res.json({ ok });
  });

  app.post('/api/params/persist', mutating, async (req, res) => {
    const uid = String((req.body as { uid?: string }).uid ?? pipeline.uid);
    try {
      await broker.persist(uid, by(res));
      return res.json({ ok: true });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/api/node/reset-background', mutating, async (req, res) => {
    const uid = String((req.body as { uid?: string }).uid ?? pipeline.uid);
    try {
      await rt.ingest.sendCommand(uid, CMD_RESET_BACKGROUND);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
  });

  /**
   * The rig's own camera, latest frame. Only for nodes flagged rgb in the
   * registry, and only ever from memory -- the same picture the console
   * shows, on the screen where it is useful: next to the thermal frame it
   * was taken with.
   */
  app.get('/api/nodes/:uid/rgb.jpg', (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    if (!rt.reg.nodes.get(uid)?.rgb) return res.status(404).end();
    const f = rt.rgb.get(uid);
    if (!f) return res.status(404).end();
    return res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      .set('x-tm-rgb-at', String(f.at))
      .send(f.jpeg);
  });

  // --- training data ------------------------------------------------------

  app.get('/api/pairs', (_req, res) => res.json({
    ...pairs.stats(),
    rgbNodes: [...rt.reg.nodes.values()].filter((n) => n.rgb).map((n) => n.uid),
  }));

  app.post('/api/pairs/record', mutating, (req, res) => {
    const mode = recordModeOf(req.body);
    if (!mode) return res.status(400).json({ error: 'mode must be off, auto or on' });
    const rgb = [...rt.reg.nodes.values()].filter((n) => n.rgb);
    if (mode !== 'off' && rgb.length === 0) return res.status(400).json({ error: 'no node on this site has an RGB camera' });
    pairs.setMode(mode);
    return res.json({ ok: true, ...pairs.stats() });
  });

  app.post('/api/pairs/prune', mutating, (_req, res) => {
    const removed = pairs.prune();
    res.json({ ok: true, removed, ...pairs.stats() });
  });

  app.get('/api/ws-token', (req, res) => {
    const exp = Date.now() + 60_000;
    res.json({ token: `${exp}.${createHmac('sha256', wsSecret).update(`${exp}:${auth.sessionToken(req)}`).digest('hex')}` });
  });

  // Home, /flow, /train, /console, /updates: routed in the browser.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'no such endpoint' });
    return sendShell(res);
  });

  const server = createServer(app);
  server.on('close', train.stop);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const clients = new Map<WebSocket, { req: IncomingMessage; binding: string }>();
  auth.onLogout((binding) => {
    for (const [ws, client] of clients) if (client.binding === binding) ws.terminate();
    consoleCore?.closeSessions(binding);
    train.sockets?.closeFor(binding);
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    socket.on('error', () => undefined);
    const url = requestUrl(req.url);
    if (!url || !sameOrigin(req) || clients.size >= 64) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    // A one-minute WS token is bound to this live session. Removing an
    // account, resetting its password or logging out also ends its feeds.
    if (!auth.userOf(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const binding = auth.sessionToken(req);
    // Module 02's shell on the cluster: its own one-time ticket, bound to this sign-in.
    if (url.pathname === '/train-term') {
      if (train.sockets?.upgrade(req, socket, head, url, auth.userOf(req)!, binding)) return;
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // The console's live feed. Its token comes from /console-app/api/ws-token,
    // which only a signed-in engineer can reach.
    if (url.pathname === '/console-app/ws') {
      if (consoleCore?.upgrade(req, socket, head, '/console-app/ws', { binding, valid: () => !!auth.userOf(req) })) return;
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const [exp, mac] = (url.searchParams.get('token') ?? '').split('.');
    const ok = url.pathname === '/ws' && exp && mac && Number(exp) > Date.now() &&
      safeEqual(mac, createHmac('sha256', wsSecret).update(`${exp}:${binding}`).digest('hex'));
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, { req, binding });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'pipeline_state', pipeline, live }));
    });
  });

  const send = (msg: unknown) => {
    const s = JSON.stringify(msg);
    // A browser that is behind is skipped, not queued for (sendLatest).
    for (const [ws, client] of clients) {
      if (!auth.userOf(client.req)) { ws.terminate(); continue; }
      sendLatest(ws, s);
    }
  };

  // Live mode runs the graph as frames arrive; paused holds the frame the
  // operator is looking at. Runs are coalesced because a detector replay over
  // the ring costs more than a frame interval.
  let live = true;
  let running = false;
  let queued: string | null = null;
  let heldFrame: number | undefined;

  function scheduleRun(reason: string): void {
    if (!live && reason === 'frame') return;
    queued = reason;
    void drain();
  }

  async function drain(): Promise<void> {
    if (running || queued === null) return;
    running = true;
    queued = null;
    try {
      const result = await algo.run(pipeline, { frame: live ? undefined : heldFrame });
      send({ type: 'frame', ...result, dirty: algo.dirtyFor(pipeline), pending: broker.changes() });
    } catch (err) {
      send({ type: 'node_error', error: (err as Error).message });
    } finally {
      running = false;
      if (queued !== null) void drain();
    }
  }

  app.post('/api/mode', mutating, (req, res) => {
    const body = (req.body ?? {}) as { mode?: string; frame?: number };
    if (body.mode === 'live') { live = true; heldFrame = undefined; }
    else if (body.mode === 'pause') { live = false; heldFrame = body.frame ?? algo.frames.latest(pipeline.uid)?.frame; }
    else if (body.mode === 'step') { live = false; heldFrame = body.frame ?? heldFrame; }
    else return res.status(400).json({ error: 'mode must be live, pause or step' });
    scheduleRun('mode');
    return res.json({ ok: true, live, frame: heldFrame });
  });

  const stateTimer = setInterval(() => send({ type: 'pipeline_state', pipeline, live, pending: broker.changes() }), 5000).unref();

  let disposal: Promise<void> | undefined;
  if (options.listen !== false) server.listen(port, host);
  return {
    server,
    algo,
    // Release owned feeds and timers once, including during startup rollback.
    dispose: () => {
      if (disposal) return disposal;
      clearTimeout(pickTimer);
      clearInterval(stateTimer);
      rt.off('raw', onRaw);
      rt.off('rgb', onRgb);
      rt.off('report', onReport);
      broker.stop();
      for (const ws of wss.clients) ws.terminate();
      disposal = Promise.all([
        algo.dispose(), consoleCore?.dispose(),
        new Promise<void>(resolve => wss.close(() => resolve())),
      ]).then(() => undefined);
      return disposal;
    },
  };
}

function loadPipeline(dir: string, name: string): Pipeline | null {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const pipeline = JSON.parse(readFileSync(path, 'utf8')) as Pipeline;
    return validate(pipeline).length === 0 ? pipeline : null;
  } catch {
    return null;  }
}

function sendDashboard(res: Response): void {
  if (!existsSync(join(PUBLIC, 'index.html'))) {
    res.status(503).send('the algo dashboard is not built (npm run build)');
    return;
  }
  res.sendFile(join(PUBLIC, 'index.html'));
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
