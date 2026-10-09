/**
 * Module 02's API, mounted at /api/train behind the algo console's sign-in
 * (HANDOVER.md §9, M1 part: drafts, uploads, validation, sbatch preview).
 *
 * The console's accounts are the dashboard accounts (§6.1), and isolation is
 * per account: every lookup goes through JobStore.get(user, id), so another
 * person's job answers exactly like a job that does not exist.
 *
 * Submit, refresh, cancel and logs (Plan A, the only routes that can carry
 * HKU credentials) are in hpc/routes.ts.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { ConfigError } from '../../edge/registry.js';
import { RateLimiter } from '../../web/auth.js';
import { loadHpcConfig, type HpcConfig } from './config.js';
import { renderSbatch } from './sbatch.js';
import { MAX_ARG_LENGTH, MAX_ARGS, MAX_ENV, MAX_ENV_VALUE, validateSpec } from './spec.js';
import { EDITABLE, JobStore, MAX_JOBS_PER_USER, ProfileStore, StoreError, type CodeInfo, type TrainJob } from './store.js';
import type { GatewayDeps } from './hpc/gateway.js';
import { mountHpc } from './hpc/routes.js';
import { HpcService } from './hpc/service.js';
import { Terminals } from './hpc/terminal.js';
import { MAX_PY_BYTES, MAX_ZIP_ENTRIES, UploadError, Uploads, type Upload } from './uploads.js';

/** The editor shows one file at a time; a megabyte of Python is plenty. */
const MAX_VIEW_BYTES = 1024 * 1024;

export interface TrainOptions {
  /** DATA_DIR/algo/train */
  root: string;
  configPath: string;
  /** The algo console's write guard (the x-tm-algo header). */
  mutating: RequestHandler;
  /** Tests replace openconnect and ssh with fakes. */
  gatewayDeps?: GatewayDeps;
  accountEpoch?: (name: string) => string | null;
  authenticated?: (req: { headers: { cookie?: string } }) => boolean;
  authorized?: (req: { headers: { cookie?: string } }) => boolean;
  /** The console sign-in a request belongs to, so a terminal is bound to it. */
  bindingOf?: (req: { headers: { cookie?: string } }) => string;
}

/** What module 02 adds to the algo server's WebSocket upgrades. */
export interface TrainSockets {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, user: string, binding: string): boolean;
  closeFor(binding: string): void;
}

const codeOf = (u: Upload): CodeInfo => ({
  kind: u.kind, filename: u.filename, bytes: u.bytes, sha256: u.sha256,
  unpackedBytes: u.unpackedBytes, fileCount: u.fileCount, py: u.py,
});

/** What the job list needs; the full record (sbatch, file list) is one GET away. */
const summary = (j: TrainJob) => ({
  id: j.id, name: j.spec.name, status: j.status, partition: j.spec.partition, gpus: j.spec.gpus,
  code: { kind: j.code.kind, filename: j.code.filename }, slurmJobId: j.slurmJobId,
  createdAt: j.createdAt, updatedAt: j.updatedAt,
});

/** A .py file from a code directory, if it is one of `py` and small enough to show. */
function readCode(dir: string, py: readonly string[], path: unknown): { text: string } | { status: number; error: string } {
  if (typeof path !== 'string' || !py.includes(path)) return { status: 404, error: 'no such .py file in this code' };
  const root = resolve(dir);
  const file = resolve(root, ...path.split('/'));
  if (!file.startsWith(root + sep)) return { status: 404, error: 'no such .py file in this code' };
  if (statSync(file).size > MAX_VIEW_BYTES) return { status: 413, error: `${path} is over 1 MB; it runs, but is not shown here` };
  return { text: readFileSync(file, 'utf8') };
}

export function createTrain(opts: TrainOptions): { router: Router; error: string | null; stop(): void; sockets: TrainSockets | null; listJobs(user: string): TrainJob[] | null } {
  const router = express.Router();
  const bindings = new Map<string, { user: string; req: { headers: { cookie?: string } } }>();
  let invalidateUser: (user: string) => void = () => undefined;
  const epochs = new Map<string, string | null>();
  const validateEpoch = (user: string) => {
    const current = opts.accountEpoch?.(user) ?? null;
    if (epochs.has(user) && epochs.get(user) !== current) invalidateUser(user);
    epochs.set(user, current);
  };
  router.use((req, res, next) => {
    validateEpoch(String(res.locals.user));
    if (opts.authorized?.(req)) {
      const binding = opts.bindingOf?.(req) ?? '';
      if (!bindings.has(binding) && bindings.size >= 512) return void res.status(503).json({ error: 'too many live training bindings' });
      bindings.set(binding, { user: String(res.locals.user), req: { headers: { cookie: req.headers.cookie } } });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && opts.authorized && !opts.authorized(req)) return void res.status(403).json({ error: 'Engineer access required.' });
    return next();
  });
  let cfg: HpcConfig | null = null;
  let error: string | null = null;
  try {
    cfg = loadHpcConfig(opts.configPath);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    error = `module 02 is off: ${err.message}`;
  }
  // A broken module 02 must not take the sensors' console down with it: the
  // rest of the algo console starts, and this answers 503 with the reason.
  if (!cfg) {
    router.use((_req, res) => res.status(503).json({ error }));
    return { router, error, stop: () => undefined, sockets: null, listJobs: () => null };
  }
  const config = cfg;
  const store = new JobStore(opts.root);
  const uploads = new Uploads(opts.root, config, store);
  if (store.error) error = store.error;
  else store.sweep();
  const sweeper = setInterval(() => uploads.sweep(), 10 * 60_000);
  sweeper.unref();
  const service = new HpcService(config, store, new ProfileStore(opts.root), opts.root, opts.gatewayDeps);
  service.start();

  const uploadLimiter = new RateLimiter(30, 10 * 60_000);
  const writeLimiter = new RateLimiter(120, 10 * 60_000);
  /** Debounced keystrokes: generous, but still a ceiling. */
  const previewLimiter = new RateLimiter(1200, 10 * 60_000);
  /** Each of these may start an HKU login. */
  const hpcLimiter = new RateLimiter(60, 10 * 60_000);
  service.authorized = (user) => !opts.authorized || ((opts.accountEpoch === undefined || epochs.get(user) === opts.accountEpoch(user)) && [...bindings.values()].some((entry) => entry.user === user && opts.authorized!(entry.req)));
  invalidateUser = (user) => {
    for (const [binding, entry] of bindings) if (entry.user === user) { terminals?.closeFor(binding); bindings.delete(binding); }
    service.invalidate(user); void service.gateway?.close(user);
  };
  const authorityTimer = setInterval(() => {
    for (const user of epochs.keys()) validateEpoch(user);
    for (const [binding, entry] of bindings) if (opts.authorized && !opts.authorized(entry.req)) {
      bindings.delete(binding); terminals?.closeFor(binding); service.invalidate(entry.user);
      if (!service.authorized(entry.user)) void service.gateway?.close(entry.user);
    }
  }, 5000);
  authorityTimer.unref();
  const userOf = (res: Response) => String(res.locals.user);
  const limit = (limiter: RateLimiter): RequestHandler => (_req, res, next) =>
    limiter.allow(userOf(res)) ? next() : void res.status(429).json({ error: 'too many changes; wait a few minutes' });
  const audit = (req: Request, res: Response, action: string, jobId: string | null, result: string) =>
    store.audit({ user: userOf(res), action, jobId, ip: req.ip, userAgent: req.get('user-agent'), result });

  router.use((_req, res, next) => store.error ? void res.status(503).json({ error: store.error }) : next());

  router.get('/config', (_req, res) => {
    const user = userOf(res);
    res.json({
      verified: config.verified, source: config.source,
      partitions: config.partitions.map(({ name, maxTime, gpu, maxGpus }) => ({ name, maxTime, gpu, maxGpus })),
      defaultPartition: config.defaultPartition, modules: config.modules,
      limits: {
        maxPyMb: MAX_PY_BYTES / 1048576, maxUploadMb: config.maxUploadMb, maxUnpackedMb: config.maxUnpackedMb,
        maxEntries: MAX_ZIP_ENTRIES, quotaMb: config.quotaMb, maxJobs: MAX_JOBS_PER_USER,
        maxArgs: MAX_ARGS, maxArgLength: MAX_ARG_LENGTH, maxEnv: MAX_ENV, maxEnvValue: MAX_ENV_VALUE,
      },
      usage: { bytes: store.usage(user) + uploads.usage(user), jobs: store.count(user) },
      hpc: { backend: config.backend, available: service.unavailable() === null, reason: service.unavailable() },
    });
  });

  router.get('/jobs', (_req, res) => res.json({ jobs: store.list(userOf(res)).map(summary) }));

  router.get('/jobs/:id', (req, res) => {
    const job = store.get(userOf(res), String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    return res.json({ job });
  });

  router.get('/jobs/:id/file', (req, res) => {
    const job = store.get(userOf(res), String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    const out = readCode(store.codeDir(job.id), job.code.py, req.query.path);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    return res.type('text/plain; charset=utf-8').send(out.text);
  });

  router.get('/uploads/:id/file', (req, res) => {
    const upload = uploads.get(userOf(res), String(req.params.id));
    if (!upload) return res.status(404).json({ error: 'no such upload (they last an hour)' });
    const out = readCode(uploads.codeDir(upload.id), upload.py, req.query.path);
    if ('error' in out) return res.status(out.status).json({ error: out.error });
    return res.type('text/plain; charset=utf-8').send(out.text);
  });

  router.post('/uploads', opts.mutating, limit(uploadLimiter), async (req, res) => {
    // The body is the file. Anything else (a form, JSON) has been or would be
    // parsed by something that is not the byte meter.
    if (!req.is('application/octet-stream')) {
      return res.set('Connection', 'close').status(415).json({ error: 'send the file as application/octet-stream' });
    }
    try {
      const upload = await uploads.receive(userOf(res), req.query.filename, req);
      audit(req, res, 'upload', null, `ok ${upload.kind} ${upload.bytes}B ${upload.sha256.slice(0, 12)}`);
      const { user: _u, ...out } = upload;
      return res.status(201).json({ upload: out });
    } catch (err) {
      const e = err instanceof UploadError ? err : new UploadError('upload failed', 500);
      audit(req, res, 'upload', null, `refused: ${e.message.slice(0, 200)}`);
      // The rest of the body may still be on its way; do not read it to keep the socket.
      return res.set('Connection', 'close').status(e.status).json({ error: e.message });
    }
  });

  /**
   * Validate and render without saving: the form's live errors and the
   * job.sbatch tab come from the same code that will judge the save, not
   * from a copy in the browser that could drift from it.
   */
  router.post('/preview', opts.mutating, limit(previewLimiter), (req, res) => {
    const body = (req.body ?? {}) as { spec?: unknown; py?: unknown };
    const py = Array.isArray(body.py) && body.py.length <= 1000 && body.py.every((f) => typeof f === 'string') ? body.py as string[] : [];
    const v = validateSpec(body.spec, config, py);
    if (!v.ok) return res.json({ ok: false, problems: v.problems });
    return res.json({ ok: true, sbatch: renderSbatch(v.spec) });
  });

  router.post('/jobs', opts.mutating, limit(writeLimiter), (req, res) => {
    const user = userOf(res);
    const body = (req.body ?? {}) as { uploadId?: unknown; fromJobId?: unknown; spec?: unknown };
    // New code (an upload), or the code of one of this person's jobs: a job
    // that has been sent is a record, and "run it again with 8 CPUs" starts here.
    const upload = typeof body.uploadId === 'string' ? uploads.get(user, body.uploadId) : undefined;
    const from = !upload && typeof body.fromJobId === 'string' ? store.get(user, body.fromJobId) : undefined;
    if (!upload && !from) return res.status(400).json({ error: 'upload the code first (an upload is kept for an hour)' });
    if (store.count(user) >= MAX_JOBS_PER_USER) {
      return res.status(409).json({ error: `you have ${MAX_JOBS_PER_USER} jobs; delete some drafts first` });
    }
    const code = upload ? codeOf(upload) : from!.code;
    if (from && store.usage(user) + uploads.usage(user) + code.unpackedBytes > config.quotaMb * 1024 * 1024) {
      return res.status(413).json({ error: `copying it would pass your ${config.quotaMb} MB of job code; delete old drafts first` });
    }
    const v = validateSpec(body.spec, config, code.py);
    if (!v.ok) return res.status(400).json({ error: 'the job spec needs fixing', problems: v.problems });
    const now = Date.now();
    const job: TrainJob = {
      id: randomUUID(), user, spec: v.spec, status: 'DRAFT', code, sbatch: renderSbatch(v.spec),
      createdAt: now, updatedAt: now, submittedAt: null, startedAt: null, endedAt: null,
      slurmJobId: null, remoteDir: null, exitCode: null, lastPolledAt: null,
      slurmState: null, elapsedSeconds: null, node: null, message: null,
    };
    if (upload) {
      store.create(job, uploads.codeDir(upload.id));
      uploads.adopted(upload.id);
    } else {
      store.createCopy(job, store.codeDir(from!.id));
    }
    audit(req, res, 'create', job.id, from ? `ok copy of ${from.id}` : 'ok');
    return res.status(201).json({ job });
  });

  router.put('/jobs/:id', opts.mutating, limit(writeLimiter), (req, res) => {
    const user = userOf(res);
    const job = store.get(user, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (!EDITABLE.includes(job.status)) return res.status(409).json({ error: `a ${job.status} job cannot be edited; save a new draft instead` });
    const body = (req.body ?? {}) as { uploadId?: unknown; spec?: unknown };
    let upload: Upload | undefined;
    if (body.uploadId !== undefined && body.uploadId !== null) {
      upload = typeof body.uploadId === 'string' ? uploads.get(user, body.uploadId) : undefined;
      if (!upload) return res.status(400).json({ error: 'that upload has expired or is not yours; upload again' });
    }
    const v = validateSpec(body.spec, config, upload ? upload.py : job.code.py);
    if (!v.ok) return res.status(400).json({ error: 'the job spec needs fixing', problems: v.problems });
    const next: TrainJob = {
      ...job, spec: v.spec, sbatch: renderSbatch(v.spec), status: 'DRAFT',
      code: upload ? codeOf(upload) : job.code, updatedAt: Date.now(),
    };
    store.update(next, upload ? uploads.codeDir(upload.id) : undefined);
    if (upload) uploads.adopted(upload.id);
    audit(req, res, 'update', job.id, 'ok');
    return res.json({ job: next });
  });

  router.delete('/jobs/:id', opts.mutating, limit(writeLimiter), (req, res) => {
    const job = store.get(userOf(res), String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (!EDITABLE.includes(job.status)) return res.status(409).json({ error: `a ${job.status} job is kept as a record` });
    store.remove(job);
    audit(req, res, 'delete', job.id, 'ok');
    return res.json({ ok: true });
  });

  mountHpc(router, { service, store, config, mutating: opts.mutating, authorized: opts.authorized, authenticated: opts.authenticated, limit: limit(hpcLimiter), userOf });

  // The shell on the cluster (CONSOLE, "ssh" mode): a one-time ticket here,
  // then a WebSocket upgrade on /train-term that server.ts hands over.
  const terminals = service.gateway ? new Terminals(service.gateway, (user, action, result) => store.audit({ user, action, result }), 'python3', (req) => opts.authorized?.(req) ?? true) : null;
  router.post('/hpc/term', opts.mutating, limit(hpcLimiter), (req, res) => {
    const user = userOf(res);
    if (!terminals || !service.gateway?.live(user)) return res.status(428).json({ error: 'Sign in to HKU to open a terminal.', needs: 'credentials' });
    try {
      return res.json(terminals.issue(user, opts.bindingOf?.(req) ?? ''));
    } catch (err) {
      return res.status(429).json({ error: (err as Error).message });
    }
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof StoreError) return res.status(503).json({ error: err.message });
    return next(err);
  });

  return {
    router, error,
    listJobs: (user) => store.list(user),
    stop: () => { clearInterval(authorityTimer); clearInterval(sweeper); terminals?.closeAll(); void service.stop(); },
    sockets: terminals ? {
      upgrade: (req, socket, head, url, user, binding) => terminals.upgrade(req, socket, head, url, user, binding),
      closeFor: (binding) => terminals.closeFor(binding),
    } : null,
  };
}

/** Where module 02 keeps its files, beside the console's other state. */
export function trainRoot(dataDir: string): string {
  return join(dataDir, 'algo', 'train');
}
