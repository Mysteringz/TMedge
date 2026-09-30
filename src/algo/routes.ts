import express, { Router, type RequestHandler } from 'express';
import { CMD_RESET_BACKGROUND } from '../edge/protocol.js';
import type { EdgeRuntime } from '../edge/runtime.js';
import { encodeFrame } from './frames.js';
import { validate } from './graph.js';
import { defaultPipeline, NODE_SPECS, specOf } from './nodes.js';
import type { PairRecorder } from './pairs.js';
import { EDGE_PARAMS, type ParamBroker, REVERT_MS } from './params.js';
import type { AlgoRuntime } from './runtime.js';
import type { Pipeline } from './types.js';
import type { PipelineRepository } from './pipeline-repository.js';

export interface AlgoRouterDependencies {
  runtime: EdgeRuntime;
  algo: AlgoRuntime;
  broker: ParamBroker;
  pairs: PairRecorder;
  pipelines: PipelineRepository;
  mutating: RequestHandler;
  getPipeline(): Pipeline;
  setPipeline(pipeline: Pipeline): void;
  isLive(): boolean;
  heldFrame(): number | undefined;
  setMode(mode: 'live' | 'pause' | 'step', frame?: number): void;
  scheduleRun(reason: string): void;
  issueWebSocketToken(): string;
}

/** Creates debugger HTTP endpoints while keeping the existing API contracts. */
export function createAlgoRouter(dependencies: AlgoRouterDependencies): Router {
  const router = Router();
  router.get('/api/catalogue', (_req, res) => res.json({
    nodes: NODE_SPECS,
    edgeParams: EDGE_PARAMS,
    revertMs: REVERT_MS,
    preview: { available: dependencies.algo.detector.unavailable === null, reason: dependencies.algo.detector.unavailable },
  }));
  router.get('/api/sources', (_req, res) => getSources(res, dependencies));
  router.get('/api/pipeline', (_req, res) => res.json({
    pipeline: dependencies.getPipeline(),
    problems: validate(dependencies.getPipeline()),
    dirty: dependencies.algo.dirtyFor(dependencies.getPipeline()),
    saved: dependencies.pipelines.list(),
  }));
  router.put('/api/pipeline', dependencies.mutating, (req, res) => {
    const pipeline = req.body as Pipeline;
    if (!pipeline || pipeline.version !== 1 || !Array.isArray(pipeline.nodes)) return res.status(400).json({ error: 'not a pipeline' });
    const problems = validate(pipeline);
    if (problems.length > 0) return res.status(400).json({ error: problems[0]?.message, problems });
    dependencies.setPipeline({ ...pipeline, updatedAt: Date.now() });
    dependencies.scheduleRun('pipeline');
    return res.json({ ok: true, pipeline: dependencies.getPipeline() });
  });
  router.post('/api/pipeline/save', dependencies.mutating, (req, res) => {
    const name = safeName((req.body as { name?: string }).name);
    if (!name) return res.status(400).json({ error: 'a name of letters, digits, - and _ please' });
    dependencies.pipelines.save(name, dependencies.getPipeline());
    return res.json({ ok: true, name });
  });
  router.post('/api/pipeline/load', dependencies.mutating, (req, res) => loadPipeline(req, res, dependencies));
  router.post('/api/pipeline/reset', dependencies.mutating, (_req, res) => {
    dependencies.setPipeline(defaultPipeline(dependencies.getPipeline().uid));
    dependencies.scheduleRun('pipeline');
    return res.json({ ok: true, pipeline: dependencies.getPipeline() });
  });
  router.get('/api/frames', (req, res) => {
    const uid = String(req.query.uid ?? dependencies.getPipeline().uid);
    return res.json({ uid, frames: dependencies.algo.frames.timeline(uid) });
  });
  router.get('/api/frame/:frame', (req, res) => {
    const uid = String(req.query.uid ?? dependencies.getPipeline().uid);
    const pair = dependencies.algo.frames.get(uid, Number(req.params.frame));
    if (!pair) return res.status(404).json({ error: 'that frame is no longer in the ring' });
    return res.json({ ...encodeFrame(pair), observed: pair.deviceDetections });
  });
  router.post('/api/run', async (req, res) => {
    const body = (req.body ?? {}) as { frame?: number; only?: string };
    try {
      return res.json(await dependencies.algo.run(dependencies.getPipeline(), { frame: body.frame, only: body.only }));
    } catch (error) {
      return res.status(500).json({ error: (error as Error).message });
    }
  });
  registerParameterRoutes(router, dependencies);
  registerRecorderRoutes(router, dependencies);
  router.get('/api/ws-token', (_req, res) => res.json({ token: dependencies.issueWebSocketToken() }));
  return router;
}

function getSources(res: express.Response, deps: AlgoRouterDependencies): void {
  const health = deps.runtime.nodes();
  res.json({
    nodes: [...deps.runtime.reg.nodes.values()].map((node) => {
      const status = health.find((item) => item.uid === node.uid);
      const floor = deps.runtime.reg.floors.find((item) => item.id === node.floorId);
      return {
        uid: node.uid, label: node.label, floorId: node.floorId, simulated: node.simulated, rgb: node.rgb,
        online: status?.online ?? false, rawEvery: status?.status?.params?.raw_every ?? null,
        frames: deps.algo.frames.list(node.uid).length, published: floor ? floor.visibility === 'public' : false,
      };
    }),
  });
}

function loadPipeline(req: express.Request, res: express.Response, deps: AlgoRouterDependencies) {
  const name = safeName((req.body as { name?: string }).name);
  const current = deps.getPipeline();
  const loaded = name === 'default' && !deps.pipelines.load('default')
    ? defaultPipeline(current.uid)
    : deps.pipelines.load(name);
  if (!loaded) return res.status(404).json({ error: `no saved pipeline called ${name}` });
  deps.setPipeline(loaded);
  deps.scheduleRun('pipeline');
  return res.json({ ok: true, pipeline: deps.getPipeline() });
}

function registerParameterRoutes(router: Router, deps: AlgoRouterDependencies): void {
  router.get('/api/params', (_req, res) => res.json({
    device: deps.broker.deviceParams(deps.getPipeline().uid), edge: deps.broker.edgeParams(),
    pending: deps.broker.changes(), audit: deps.broker.recent(50),
  }));
  router.post('/api/params/apply', deps.mutating, async (req, res) => {
    const body = (req.body ?? {}) as { nodeId?: string; param?: string; value?: number; uid?: string };
    const pipeline = deps.getPipeline();
    const node = pipeline.nodes.find((item) => item.id === body.nodeId);
    const spec = node ? specOf(node.type) : undefined;
    const parameter = spec?.params.find((item) => item.id === body.param);
    if (!node || !spec || !parameter) return res.status(400).json({ error: 'no such node parameter' });
    if (typeof body.value !== 'number' || !Number.isFinite(body.value)) return res.status(400).json({ error: 'value must be a number' });
    if (body.value < parameter.min || body.value > parameter.max) {
      return res.status(400).json({ error: `${parameter.label} must be between ${parameter.min} and ${parameter.max}` });
    }
    if (parameter.binding.kind === 'local') {
      node.params[parameter.id] = body.value;
      deps.scheduleRun('params');
      return res.json({ ok: true, local: true });
    }
    try {
      const change = await deps.broker.apply({
        uid: body.uid ?? pipeline.uid, nodeId: node.id, param: parameter.id,
        binding: parameter.binding, value: body.value, by: 'algo-dashboard',
      });
      delete node.params[parameter.id];
      deps.scheduleRun('params');
      return res.json({ ok: true, change });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });
  router.post('/api/params/commit', deps.mutating, (req, res) => {
    const { param, uid } = (req.body ?? {}) as { param?: string; uid?: string };
    return res.json({ ok: deps.broker.commit(uid ?? deps.getPipeline().uid, String(param), 'algo-dashboard') });
  });
  router.post('/api/params/revert', deps.mutating, async (req, res) => {
    const { param, uid } = (req.body ?? {}) as { param?: string; uid?: string };
    const ok = await deps.broker.revert(uid ?? deps.getPipeline().uid, String(param), 'algo-dashboard');
    deps.scheduleRun('params');
    return res.json({ ok });
  });
  router.post('/api/params/persist', deps.mutating, async (req, res) => {
    const uid = String((req.body as { uid?: string }).uid ?? deps.getPipeline().uid);
    try {
      await deps.broker.persist(uid, 'algo-dashboard');
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });
}

function registerRecorderRoutes(router: Router, deps: AlgoRouterDependencies): void {
  router.post('/api/node/reset-background', deps.mutating, async (req, res) => {
    const uid = String((req.body as { uid?: string }).uid ?? deps.getPipeline().uid);
    try {
      await deps.runtime.ingest.sendCommand(uid, CMD_RESET_BACKGROUND);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  });
  router.get('/api/nodes/:uid/rgb.jpg', (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    if (!deps.runtime.reg.nodes.get(uid)?.rgb) return res.status(404).end();
    const frame = deps.runtime.rgb.get(uid);
    if (!frame) return res.status(404).end();
    return res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      .set('x-tm-rgb-at', String(frame.at)).send(frame.jpeg);
  });
  router.get('/api/pairs', (_req, res) => res.json({
    ...deps.pairs.stats(), rgbNodes: [...deps.runtime.reg.nodes.values()].filter((node) => node.rgb).map((node) => node.uid),
  }));
  router.post('/api/pairs/record', deps.mutating, (req, res) => {
    const on = (req.body as { on?: boolean }).on === true;
    const rgbNodes = [...deps.runtime.reg.nodes.values()].filter((node) => node.rgb);
    if (on && rgbNodes.length === 0) return res.status(400).json({ error: 'no node on this site has an RGB camera' });
    deps.pairs.setRecording(on);
    return res.json({ ok: true, ...deps.pairs.stats() });
  });
  router.post('/api/pairs/prune', deps.mutating, (_req, res) => {
    const removed = deps.pairs.prune();
    return res.json({ ok: true, removed, ...deps.pairs.stats() });
  });
  router.post('/api/mode', deps.mutating, (req, res) => updateMode(req.body ?? {}, res, deps));
}

function updateMode(bodyValue: unknown, res: express.Response, deps: AlgoRouterDependencies) {
  const body = bodyValue as { mode?: string; frame?: number };
  if (body.mode !== 'live' && body.mode !== 'pause' && body.mode !== 'step') {
    return res.status(400).json({ error: 'mode must be live, pause or step' });
  }
  const frame = body.mode === 'pause' ? body.frame ?? deps.algo.frames.latest(deps.getPipeline().uid)?.frame : body.frame;
  deps.setMode(body.mode, frame);
  deps.scheduleRun('mode');
  return res.json({ ok: true, live: deps.isLive(), frame: deps.heldFrame() });
}

function safeName(value: unknown): string {
  return String(value ?? '').replace(/[^a-z0-9-_]/gi, '');
}
