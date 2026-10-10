/**
 * Plan A's endpoints under /api/train (HANDOVER.md §9).
 *
 * Credentials arrive only as `sealed` (src/shared/hpcseal.ts), only on the
 * three actions that may need a new HKU login (submit, refresh, cancel), and
 * only when the person has no live session. Every check that could refuse
 * the request runs before the seal is opened, so a request that is going to
 * fail never decrypts a PIN. Bodies are never logged, and no response
 * carries anything the person typed.
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import type { HpcConfig } from '../config.js';
import { validateSpec } from '../spec.js';
import { ACTIVE, EDITABLE, HKU_UID, type JobStore } from '../store.js';
import { LockedOut } from './gateway.js';
import { SealError, type Credentials } from './sealed.js';
import type { HpcService } from './service.js';

export interface HpcRouteDeps {
  service: HpcService;
  store: JobStore;
  config: HpcConfig;
  mutating: RequestHandler;
  limit: RequestHandler;
  authorized?: (req: Request) => boolean;
  authenticated?: (req: Request) => boolean;
  userOf(res: Response): string;
}

export function mountHpc(router: Router, d: HpcRouteDeps): void {
  const { service, store } = d;

  router.get('/hpc', (_req, res) => {
    const user = d.userOf(res);
    const profile = service.profiles.get(user);
    res.json({
      available: service.unavailable() === null, reason: service.unavailable(),
      profile, domains: service.domains(), idleTtlSeconds: service.idleTtlSeconds(), ssh: service.sshTarget(),
      session: service.gateway?.info(user) ?? { state: 'none', uid: null, expiresInSeconds: null },
      firstUse: service.firstUse(),
      lockedForSeconds: profile && service.gateway ? Math.ceil(service.gateway.lockedFor(user, profile.hkuUid) / 1000) : 0,
      running: service.ops.running(user)?.id ?? null,
    });
  });

  /** A one-time key to seal one sign-in with. */
  router.post('/hpc/ticket', d.mutating, d.limit, (_req, res) => {
    try {
      return res.json(service.inbox.issue(d.userOf(res)));
    } catch (err) {
      return res.status(429).json({ error: (err as Error).message });
    }
  });

  /** A session with no job attached: for the terminal, or the first-use questions. */
  router.post('/hpc/connect', d.mutating, d.limit, (req, res) => {
    const user = d.userOf(res);
    if (service.gateway?.live(user)) return res.json({ already: true });
    const ready = prepare(req, res, 'connect', null);
    if (!ready) return;
    const op = service.ops.create(user, null, 'connect');
    service.bindAuthority(op, () => d.authorized?.(req) ?? true);
    void service.connect(op, ready.creds!, ready.passwordChanged);
    return res.status(202).json({ opId: op.id });
  });

  /** "Trust this host key?" -- answered by the person whose sign-in asked. */
  router.post('/ops/:id/hostkey', d.mutating, (req, res) => {
    const accept = (req.body as { accept?: unknown } | undefined)?.accept === true;
    if (!service.answerHostKey(d.userOf(res), String(req.params.id), accept)) return res.status(404).json({ error: 'nothing is waiting for that answer' });
    return res.json({ ok: true });
  });

  router.delete('/hpc/session', d.mutating, async (_req, res) => {
    await service.gateway?.close(d.userOf(res));
    res.json({ ok: true });
  });

  /**
   * Everything submit/refresh/cancel share: the job, a backend, a session or
   * the means to open one, and no other operation of theirs in flight.
   * Returns the credentials (or null when a session is live) or answers.
   */
  const prepare = (req: Request, res: Response, action: string, jobId: string | null): { creds: Credentials | null; passwordChanged: boolean } | null => {
    const user = d.userOf(res);
    const why = service.unavailable();
    if (why) { res.status(503).json({ error: why }); return null; }
    if (service.ops.running(user)) { res.status(409).json({ error: 'Another HKU action of yours is still running.' }); return null; }
    if (service.gateway!.live(user)) return { creds: null, passwordChanged: false };
    const body = (req.body ?? {}) as { sealed?: unknown; profile?: { hkuUid?: unknown; vpnDomain?: unknown }; passwordChanged?: unknown };
    if (body.profile !== undefined) {
      const uid = body.profile.hkuUid;
      const domain = body.profile.vpnDomain;
      if (typeof uid !== 'string' || !HKU_UID.test(uid)) { res.status(400).json({ error: 'Your HKU UID is 2-32 lowercase letters and digits, without @hku.hk.' }); return null; }
      if (typeof domain !== 'string' || !service.domains().includes(domain)) { res.status(400).json({ error: `VPN domain is one of ${service.domains().join(', ')}.` }); return null; }
      service.profiles.set(user, { hkuUid: uid, vpnDomain: domain });
    }
    const profile = service.profiles.get(user);
    if (!profile || body.sealed === undefined) { res.status(428).json({ error: 'Sign in to HKU to continue.', needs: 'credentials' }); return null; }
    const wait = service.gateway!.lockedFor(user, profile.hkuUid);
    if (wait > 0) { res.status(423).json({ error: new LockedOut(wait).message, retryAfterSeconds: Math.ceil(wait / 1000) }); return null; }
    try {
      return { creds: service.inbox.open(user, body.sealed, action, jobId), passwordChanged: body.passwordChanged === true };
    } catch (err) {
      res.status(400).json({ error: err instanceof SealError ? err.message : 'the sign-in could not be read' });
      return null;
    }
  };

  router.post('/jobs/:id/submit', d.mutating, d.limit, (req, res) => {
    const user = d.userOf(res);
    const job = store.get(user, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (!EDITABLE.includes(job.status)) return res.status(409).json({ error: `a ${job.status} job has been sent already` });
    const v = validateSpec(job.spec, d.config, job.code.py);
    if (!v.ok) return res.status(409).json({ error: 'the saved spec no longer passes; edit and save the draft', problems: v.problems });
    const ready = prepare(req, res, 'submit', job.id);
    if (!ready) return;
    // SUBMITTING now, synchronously: a second click cannot send it twice.
    store.update({ ...job, status: 'SUBMITTING', message: null, updatedAt: Date.now() });
    const op = service.ops.create(user, job.id, 'submit');
    service.bindAuthority(op, () => d.authorized?.(req) ?? true);
    void service.submit(op, job, ready.creds, ready.passwordChanged);
    return res.status(202).json({ opId: op.id });
  });

  router.post('/jobs/:id/refresh', d.mutating, d.limit, (req, res) => {
    const user = d.userOf(res);
    const job = store.get(user, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (job.slurmJobId === null) return res.status(409).json({ error: 'this job has not been sent to HPC2021' });
    const ready = prepare(req, res, 'refresh', job.id);
    if (!ready) return;
    const op = service.ops.create(user, job.id, 'refresh');
    service.bindAuthority(op, () => d.authorized?.(req) ?? true);
    void service.refresh(op, job, ready.creds, ready.passwordChanged);
    return res.status(202).json({ opId: op.id });
  });

  router.post('/jobs/:id/cancel', d.mutating, d.limit, (req, res) => {
    const user = d.userOf(res);
    const job = store.get(user, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (job.slurmJobId === null || !ACTIVE.includes(job.status)) return res.status(409).json({ error: `a ${job.status} job cannot be cancelled` });
    const ready = prepare(req, res, 'cancel', job.id);
    if (!ready) return;
    const op = service.ops.create(user, job.id, 'cancel');
    service.bindAuthority(op, () => d.authorized?.(req) ?? true);
    void service.cancel(op, job, ready.creds, ready.passwordChanged);
    return res.status(202).json({ opId: op.id });
  });

  router.get('/jobs/:id/log', async (req, res) => {
    const user = d.userOf(res);
    const job = store.get(user, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'no such job' });
    if (job.slurmJobId === null) return res.status(409).json({ error: 'this job has not run' });
    if (!service.gateway?.live(user)) return res.status(428).json({ error: 'Sign in to HKU to read the log.', needs: 'credentials' });
    const stream = req.query.stream === 'err' ? 'err' : 'out';
    try {
      return res.type('text/plain; charset=utf-8').send(await service.log(user, job, stream));
    } catch {
      return res.status(502).json({ error: 'could not read the log from HPC2021' });
    }
  });

  /** Server-Sent Events for one operation: everything so far, then live, then closed. */
  router.get('/ops/:id/events', (req, res) => {
    const op = service.ops.get(d.userOf(res), String(req.params.id));
    if (!op) return res.status(404).json({ error: 'no such operation' });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const valid = () => d.authenticated?.(req) ?? true;
    const send = (e: { seq: number; type: string; data: unknown }) => { if (!valid()) { res.end(); return; } res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`); };
    for (const e of op.events) send(e);
    if (op.done) return res.end();
    const ping = setInterval(() => { if (!valid()) { clearInterval(ping); res.end(); return; } res.write(': ping\n\n'); }, 5000);
    const unsubscribe = op.subscribe((e) => {
      send(e);
      if (e.type === 'done' || e.type === 'error') { clearInterval(ping); res.end(); }
    });
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
    return undefined;
  });
}
