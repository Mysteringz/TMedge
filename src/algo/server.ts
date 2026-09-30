/** The edge hosted debugger composition root. */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { EdgeRuntime } from '../edge/runtime.js';
import { JsonParameterAuditSink } from '../infrastructure/algo/json-parameter-audit-sink.js';
import { JsonPipelineRepository } from '../infrastructure/algo/json-pipeline-repository.js';
import { AlgoWebSocketAdapter } from './websocket-adapter.js';
import { createAlgoRouter } from './routes.js';
import { defaultPipeline } from './nodes.js';
import { PairRecorder } from './pairs.js';
import { ParamBroker } from './params.js';
import { AlgoRuntime } from './runtime.js';
import type { Pipeline } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-algo');

export interface AlgoServerHandle {
  server: Server;
  algo: AlgoRuntime;
  dispose(): Promise<void>;
}

export interface AlgoServerOptions {
  listen?: boolean;
  dataDir?: string;
}

/** Composes debugger adapters and routes without changing graph or detector behavior. */
export function startAlgo(rt: EdgeRuntime, port: number, host: string, options: AlgoServerOptions = {}): AlgoServerHandle {
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? join(ROOT, 'data');
  const pipelineDir = join(dataDir, 'algo', 'pipelines');
  mkdirSync(pipelineDir, { recursive: true });
  const pipelines = new JsonPipelineRepository(pipelineDir);
  const broker = new ParamBroker(rt, new JsonParameterAuditSink(join(dataDir, 'algo', 'audit.jsonl')));
  broker.start();
  const algo = new AlgoRuntime(rt, broker);
  const pairs = createPairRecorder(dataDir);
  let pipeline = pipelines.load('default') ?? defaultPipeline(selectInitialUid(rt, algo));
  let live = true;
  let heldFrame: number | undefined;
  let disposed = false;
  const app = createExpressApp(rt);
  const server = createServer(app);
  const sockets = new AlgoWebSocketAdapter(server, () => ({ type: 'pipeline_state', pipeline, live }));
  sockets.start();
  algo.setPipeline(pipeline);
  const onRaw = (message: import('../shared/types.js').RawFrameMessage): void => {
    algo.frames.addRaw(message);
    scheduleRun('frame');
  };
  const onRgb = (uid: string, jpeg: Buffer, at: number): void => recordRgb(pairs, rt, algo, uid, jpeg, at);
  const onReport = (uid: string, detections: import('../shared/types.js').ConsoleDetection[]): void => {
    const report = rt.lastReport(uid);
    if (report) algo.frames.addReport(uid, report.frame, detections, report.flags);
  };
  rt.on('raw', onRaw);
  rt.on('rgb', onRgb);
  rt.on('report', onReport);
  const initialUidTimer = scheduleInitialPipelineSelection(() => pipeline, (next) => setPipeline(next), rt, algo);
  let runTimer: NodeJS.Timeout | null = null;
  const send = (message: unknown) => sockets.broadcast(message);
  let drainPromise: Promise<void> | null = null;
  let queuedReason: string | null = null;
  const scheduleRun = (reason: string): void => {
    if (disposed || (!live && reason === 'frame')) return;
    queuedReason = reason;
    if (drainPromise) return;
    drainPromise = drainRuns(algo, () => pipeline, () => live, () => heldFrame, broker, send, () => queuedReason, (value) => { queuedReason = value; }, () => !disposed)
      .finally(() => {
        drainPromise = null;
        if (queuedReason !== null && !disposed) scheduleRun(queuedReason);
      });
  };
  const mutating = createMutationGuard();
  app.use(createAlgoRouter({
    runtime: rt, algo, broker, pairs, pipelines, mutating,
    getPipeline: () => pipeline,
    setPipeline: (next) => setPipeline(next),
    isLive: () => live,
    heldFrame: () => heldFrame,
    setMode: (mode, frame) => {
      if (mode === 'live') { live = true; heldFrame = undefined; }
      else if (mode === 'pause') { live = false; heldFrame = frame ?? algo.frames.latest(pipeline.uid)?.frame; }
      else { live = false; heldFrame = frame ?? heldFrame; }
    },
    scheduleRun,
    issueWebSocketToken: () => sockets.issueToken(),
  }));
  app.use(express.static(PUBLIC, { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
  app.get('*', (_req, res) => sendDashboard(res));
  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    clearTimeout(initialUidTimer);
    if (runTimer) clearInterval(runTimer);
    runTimer = null;
    broker.stop();
    rt.off('raw', onRaw);
    rt.off('rgb', onRgb);
    rt.off('report', onReport);
    const activeRun = drainPromise;
    const socketClose = sockets.close();
    disposePromise = Promise.all([activeRun, socketClose, algo.dispose()]).then(() => undefined);
    return disposePromise;
  };
  server.once('close', () => { void dispose(); });
  runTimer = setInterval(() => send({ type: 'pipeline_state', pipeline, live, pending: broker.changes() }), 5000);
  runTimer.unref();
  if (options.listen !== false) server.listen(port, host);
  return { server, algo, dispose };

  function setPipeline(next: Pipeline): void {
    pipeline = next;
    algo.setPipeline(next);
  }
}

function createPairRecorder(dataDir: string): PairRecorder {
  const recorder = new PairRecorder({ dir: join(dataDir, 'algo', 'pairs') });
  if (process.env.ALGO_RECORD_PAIRS === '1') recorder.setRecording(true);
  return recorder;
}

function selectInitialUid(runtime: EdgeRuntime, algo: AlgoRuntime): string {
  const all = [...runtime.reg.nodes.values()];
  const online = new Set(runtime.nodes().filter((node) => node.online).map((node) => node.uid));
  const withFrames = all.find((node) => algo.frames.list(node.uid).length > 0);
  return (withFrames ?? all.find((node) => !node.simulated && online.has(node.uid)) ?? all.find((node) => online.has(node.uid)) ?? all[0])?.uid ?? '';
}

function scheduleInitialPipelineSelection(
  getPipeline: () => Pipeline,
  setPipeline: (pipeline: Pipeline) => void,
  runtime: EdgeRuntime,
  algo: AlgoRuntime,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (algo.frames.list(getPipeline().uid).length > 0) return;
    const better = selectInitialUid(runtime, algo);
    if (better && better !== getPipeline().uid) setPipeline({ ...getPipeline(), uid: better, updatedAt: Date.now() });
  }, 15_000);
  timer.unref();
  return timer;
}

function recordRgb(pairs: PairRecorder, runtime: EdgeRuntime, algo: AlgoRuntime, uid: string, jpeg: Buffer, at: number): void {
  const node = runtime.reg.nodes.get(uid);
  if (node?.pose) pairs.offer(uid, jpeg, at, algo.frames, node.pose.mirror);
}

function createExpressApp(runtime: EdgeRuntime): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(createSecurityMiddleware(runtime));
  app.use(express.json({ limit: '256kb' }));
  return app;
}

function createSecurityMiddleware(runtime: EdgeRuntime): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    const password = runtime.cfg.adminPassword;
    if (!password) return next();
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const provided = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    if (provided && safeEqual(provided, password)) return next();
    return res.set('WWW-Authenticate', 'Basic realm="TMedge algo"').status(401).send('authentication required');
  };
}

function createMutationGuard(): express.RequestHandler {
  return (req, res, next) => {
    if (req.get('x-tm-algo') !== '1') return res.status(403).json({ error: 'missing x-tm-algo header' });
    return next();
  };
}

async function drainRuns(
  algo: AlgoRuntime,
  getPipeline: () => Pipeline,
  isLive: () => boolean,
  getHeldFrame: () => number | undefined,
  broker: ParamBroker,
  send: (message: unknown) => void,
  getQueued: () => string | null,
  setQueued: (reason: string | null) => void,
  canRun: () => boolean,
): Promise<void> {
  while (getQueued() !== null && canRun()) {
    setQueued(null);
    try {
      const result = await algo.run(getPipeline(), { frame: isLive() ? undefined : getHeldFrame() });
      send({ type: 'frame', ...result, dirty: algo.dirtyFor(getPipeline()), pending: broker.changes() });
    } catch (error) {
      send({ type: 'node_error', error: (error as Error).message });
    }
  }
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
