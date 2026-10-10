/**
 * Plan A's operations on a person's jobs: submit, refresh, cancel, read the
 * log, and a poller that keeps active jobs current while their owner has a
 * session (HANDOVER.md §6.6 layer 1 and 3, §7).
 *
 * Credentials enter as a Credentials object built from a sealed message, are
 * used for exactly one login, and are wiped the moment the session is up --
 * before any upload or sbatch -- or on any failure, whichever comes first.
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HpcConfig } from '../config.js';
import { renderSbatch } from '../sbatch.js';
import { validateSpec } from '../spec.js';
import { ACTIVE, type HpcProfile, type JobStore, type ProfileStore, type TrainJob } from '../store.js';
import { RateLimiter } from '../../../web/auth.js';
import { loadFingerprint, makeFingerprint, matches, saveFingerprint } from './fingerprint.js';
import { Gateway, GatewayBusy, LockedOut, REAL_DEPS, type GatewayDeps, type Session } from './gateway.js';
import { AuthFailed } from './openconnect.js';
import { Ops, type Op } from './ops.js';
import { SealedInbox, type Credentials } from './sealed.js';
import { SshFailed } from './ssh.js';
import * as slurm from './slurm.js';

const TOOL_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

function findTool(name: string, configured: string | null): string | null {
  for (const p of configured ? [configured] : TOOL_DIRS.map((d) => join(d, name))) {
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Where ssh's control socket and the askpass rendezvous live. A Unix socket
 * path must fit in 108 bytes, and ssh adds ~30 to the directory, so a deep
 * DATA_DIR gets a private directory under the temp dir instead (under
 * systemd's PrivateTmp, a directory no other service can see).
 */
export function runDirFor(root: string): string {
  const dir = join(root, 'run');
  if (dir.length <= 60) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  return mkdtempSync(join(tmpdir(), 'tmhpc-'));
}

/** The shared cluster password did not match its fingerprint: nothing was sent anywhere. */
export class ServerPasswordWrong extends Error {}

/** Words for a person; never an exception's own text, which could be anything. */
export function userMessage(err: unknown): { code: string; message: string } {
  if (err instanceof ServerPasswordWrong) return { code: 'server_password', message: err.message };
  if (err instanceof AuthFailed) return { code: `vpn_${err.code}`, message: err.message };
  if (err instanceof SshFailed) return { code: `ssh_${err.code}`, message: err.message };
  if (err instanceof LockedOut) return { code: 'locked_out', message: err.message };
  if (err instanceof GatewayBusy) return { code: 'busy', message: err.message };
  if (err instanceof slurm.SlurmError) return { code: 'slurm', message: err.message };
  // Ours, not the person's: say so on the server, where the operator looks.
  // Exceptions from fs, net and child_process carry paths and codes, never
  // what was typed.
  console.warn(`[algo] module 02: unexpected ${(err as Error)?.name ?? 'error'}: ${(err as Error)?.message ?? String(err)}`);
  return { code: 'internal', message: 'Something went wrong on the dashboard; nothing more was sent to HKU.' };
}

export class HpcService {
  authorized: (user: string) => boolean = () => true;
  private operationAuthority = new Map<string, () => boolean>();
  bindAuthority(op: Op, valid: () => boolean): void { this.operationAuthority.set(op.id, valid); }
  private checkAuthority(user: string, op?: Op): void { if (!this.authorized(user) || (op && this.operationAuthority.get(op.id)?.() === false)) throw new GatewayBusy('Your admin access has changed; sign in again.'); }
  private credentials = new Map<string, Set<Credentials>>();
  invalidate(user: string): void {
    this.inbox.revoke(user);
    for (const creds of this.credentials.get(user) ?? []) creds.wipe();
    const op = this.ops.running(user);
    if (op) this.hostKeyAnswers.get(op.id)?.(false);
  }
  readonly inbox = new SealedInbox();
  readonly ops = new Ops();
  readonly gateway: Gateway | null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private readonly knownHosts: string;
  readonly fingerprintFile: string;
  /** Wrong shared passwords: the check answers instantly, so it must not be a guessing oracle. */
  private readonly wrongPassword = new RateLimiter(5, 15 * 60_000);
  private readonly tools: { openconnect: string | null; ocproxy: string | null; ssh: string | null };

  constructor(private readonly cfg: HpcConfig, private readonly store: JobStore, readonly profiles: ProfileStore,
    root: string, deps: GatewayDeps = REAL_DEPS) {
    const a = cfg.planA;
    this.knownHosts = a?.knownHosts ?? join(root, 'known_hosts');
    this.fingerprintFile = join(root, 'ssh-password.json');
    this.tools = {
      openconnect: deps === REAL_DEPS ? findTool('openconnect', a?.tools.openconnect ?? null) : a?.tools.openconnect ?? 'openconnect',
      ocproxy: deps === REAL_DEPS ? findTool('ocproxy', a?.tools.ocproxy ?? null) : a?.tools.ocproxy ?? 'ocproxy',
      ssh: deps === REAL_DEPS ? findTool('ssh', a?.tools.ssh ?? null) : a?.tools.ssh ?? 'ssh',
    };
    this.gateway = a ? new Gateway({
      vpnHost: a.vpnHost, vpnServerCert: a.vpnServerCert, vpnAuthGroup: a.vpnAuthGroup, submitHost: a.submitHost, sshUser: a.sshUser,
      knownHosts: this.knownHosts, runDir: runDirFor(root), idleTtlMs: a.idleTtlSeconds * 1000,
      maxSessions: a.maxSessions, ports: a.socksPorts,
      tools: { openconnect: this.tools.openconnect ?? 'openconnect', ocproxy: this.tools.ocproxy ?? 'ocproxy', ssh: this.tools.ssh ?? 'ssh' },
    }, deps) : null;
  }

  start(): void {
    if (!this.gateway) return;
    this.gateway.start();
    this.poller ??= setInterval(() => void this.poll(), 30_000);
    this.poller.unref();
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    await this.gateway?.stop();
  }

  /**
   * Null when jobs can be sent; otherwise what is missing, for the UI. The
   * host key and the shared password are not on this list: both are set up
   * by the first person to sign in (they confirm the key; their successful
   * login records the password's fingerprint), or by the admin tools.
   */
  unavailable(): string | null {
    const a = this.cfg.planA;
    if (!a) return 'Sending to the cluster is not switched on (backend "none" in config/hpc.json).';
    if (!this.tools.openconnect) return 'openconnect is not installed on this server.';
    if (!this.tools.ocproxy) return 'ocproxy is not installed on this server.';
    if (!this.tools.ssh) return 'ssh is not installed on this server.';
    return null;
  }

  /** What the first sign-in will be asked to set up, for the UI. */
  firstUse(): { hostKey: boolean; password: boolean } {
    const a = this.cfg.planA;
    return {
      hostKey: !!a && !(existsSync(this.knownHosts) && readFileSync(this.knownHosts, 'utf8').split('\n').some((l) => (l.trim().split(/\s+/)[0] ?? '').split(',').includes(a.submitHost))),
      password: !!a && a.sshAuth === 'shared-password' && !loadFingerprint(this.fingerprintFile),
    };
  }

  /** Who and where SSH logs in as, for the sign-in form. */
  sshTarget(): { user: string | null; host: string; auth: 'pin' | 'shared-password' } | null {
    const a = this.cfg.planA;
    return a ? { user: a.sshUser, host: a.submitHost, auth: a.sshAuth } : null;
  }

  /**
   * Before any login: in shared-password mode the typed password must match
   * its fingerprint, and a wrong one ends here, having reached nothing.
   * Returns true when there is no fingerprint to check against yet, or the
   * person said the password changed: then the cluster is the judge, once,
   * and a successful login records the new fingerprint.
   */
  private async checkServerPassword(user: string, creds: Credentials, changed: boolean): Promise<boolean> {
    const a = this.cfg.planA!;
    if (a.sshAuth !== 'shared-password') return false;
    if (creds.sshPasswordGiven() === null) throw new ServerPasswordWrong(`Type the password for ${a.sshUser}@${a.submitHost}.`);
    const fp = loadFingerprint(this.fingerprintFile);
    if (!fp || changed) {
      if (!this.wrongPassword.allow(`unchecked:${user}`)) throw new ServerPasswordWrong('Too many unverified cluster passwords; wait 15 minutes.');
      return true;
    }
    if (!(await matches(creds.sshPasswordGiven()!, fp))) {
      if (!this.wrongPassword.allow(user)) throw new ServerPasswordWrong('Too many wrong cluster passwords; wait 15 minutes.');
      throw new ServerPasswordWrong(`That is not the password for ${a.sshUser}@${a.submitHost}. It was checked here; nothing was sent to HKU or the cluster. If it was changed, tick "the cluster password has changed".`);
    }
    return false;
  }

  /** Host keys waiting on the person's answer, by operation. */
  private hostKeyAnswers = new Map<string, (accept: boolean) => void>();

  private askHostKey(op: Op, host: string, keys: { type: string; fingerprint: string }[]): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.hostKeyAnswers.delete(op.id); resolve(false); }, 2 * 60_000);
      this.hostKeyAnswers.set(op.id, (accept) => { clearTimeout(t); this.hostKeyAnswers.delete(op.id); resolve(accept); });
      op.emit('host_key', { host, keys: keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })) });
    });
  }

  /** The person's answer to "trust this host key?"; false if nothing was asked of them. */
  answerHostKey(user: string, opId: string, accept: boolean): boolean {
    const op = this.ops.get(user, opId);
    const answer = op ? this.hostKeyAnswers.get(op.id) : undefined;
    if (!answer) return false;
    this.store.audit({ user, action: 'host_key', result: accept ? 'trusted' : 'refused' });
    answer(accept);
    return true;
  }

  domains(): string[] { return this.cfg.planA?.vpnDomains ?? []; }
  idleTtlSeconds(): number { return this.cfg.planA?.idleTtlSeconds ?? 0; }

  vpnUser(p: HpcProfile): string { return `${p.hkuUid}@${p.vpnDomain}`; }

  /** The session to use: the live one, or a new login with `creds`, which are wiped either way. */
  private async session(op: Op, creds: Credentials | null, passwordChanged = false): Promise<Session> {
    const g = this.gateway!;
    let createdSession: Session | null = null;
    if (creds) { const active = this.credentials.get(op.user) ?? new Set<Credentials>(); active.add(creds); this.credentials.set(op.user, active); }
    try {
      this.checkAuthority(op.user, op);
      const live = g.live(op.user);
      if (live) { op.emit('session_reused', { uid: live.uid }); return live; }
      if (!creds) throw new GatewayBusy('Your HKU session has ended; sign in again.');
      const profile = this.profiles.get(op.user);
      if (!profile) throw new GatewayBusy('Set your HKU UID first.');
      const record = await this.checkServerPassword(op.user, creds, passwordChanged);
      this.checkAuthority(op.user, op);
      const s = await g.open(op.user, profile.hkuUid, this.vpnUser(profile), creds, {
        authorized: () => this.authorized(op.user) && this.operationAuthority.get(op.id)?.() !== false,
        onStep: (step) => op.emit(step),
        confirmHostKey: (host, keys) => this.askHostKey(op, host, keys),
      });
      createdSession = s;
      this.checkAuthority(op.user, op);
      if (record) {
        // The cluster just accepted it: this is its fingerprint from now on.
        const fingerprint = await makeFingerprint(creds.sshPasswordGiven()!);
        this.checkAuthority(op.user, op);
        saveFingerprint(this.fingerprintFile, fingerprint);
        this.store.audit({ user: op.user, action: 'cluster_password', result: 'fingerprint recorded after a successful login' });
        op.emit('password_recorded');
      }
      this.checkAuthority(op.user, op);
      return s;
    } catch (error) {
      if (createdSession) await g.close(op.user, createdSession);
      throw error;
    } finally {
      // The login is over, one way or the other: nothing below needs a secret.
      creds?.wipe();
      if (creds) { const active = this.credentials.get(op.user); active?.delete(creds); if (!active?.size) this.credentials.delete(op.user); }
    }
  }

  /** Applies SLURM's answer to a job record. */
  private apply(job: TrainJob, st: slurm.SlurmState): TrainJob {
    const now = Date.now();
    const terminal = !ACTIVE.includes(st.status) && st.status !== 'SUBMITTED';
    const next: TrainJob = {
      ...job, status: st.status, slurmState: st.raw, slurmReason: st.reason, exitCode: st.exitCode, elapsedSeconds: st.elapsedSeconds,
      message: null,
      node: st.node, lastPolledAt: now, updatedAt: now,
      startedAt: job.startedAt ?? (st.status === 'RUNNING' || terminal ? now - (st.elapsedSeconds ?? 0) * 1000 : null),
      endedAt: terminal ? job.endedAt ?? now : null,
    };
    this.store.update(next);
    return next;
  }

  private async refreshJobs(s: Session, jobs: TrainJob[]): Promise<TrainJob[]> {
    const ssh = s.ssh;
    if (!ssh) throw new GatewayBusy('Your cluster connection has ended; sign in again.');
    const withIds = jobs.flatMap((job) => job.slurmJobId === null ? [] : [{ job, id: job.slurmJobId }]);
    if (withIds.length === 0) return [];
    const states = await slurm.status(ssh, withIds.map(({ id }) => id));
    const out: TrainJob[] = [];
    for (const { job: j, id } of withIds) {
      const st = states.get(id) ?? await slurm.completion(ssh, j.id, id);
      const current = this.store.byId(j.id);
      if (st && current) out.push(this.apply(current, st));
      else if (current && ACTIVE.includes(current.status)) {
        // A vanished job is not still pending. Without accounting or a
        // receipt (older scripts), its result cannot be guessed from silence.
        const now = Date.now();
        const next: TrainJob = {
          ...current, status: 'UNKNOWN', slurmState: null, slurmReason: null, exitCode: null,
          lastPolledAt: now, updatedAt: now,
          message: 'Could not confirm this job\'s state from SLURM and no saved exit result was found. Open Log and Stderr to inspect what happened, then refresh again.',
        };
        this.store.update(next);
        out.push(next);
      }
    }
    return out;
  }

  /** Just a session: for the terminal, or to get the first-use questions out of the way. */
  async connect(op: Op, creds: Credentials, passwordChanged: boolean): Promise<void> {
    try {
      const s = await this.session(op, creds, passwordChanged);
      this.checkAuthority(op.user, op);
      op.finish('done', { status: 'CONNECTED', uid: s.uid });
    } catch (err) {
      op.finish('error', userMessage(err));
    } finally { this.operationAuthority.delete(op.id); }
  }

  /** Submit a saved draft. The job is already SUBMITTING (routes.ts did that synchronously). */
  async submit(op: Op, job: TrainJob, creds: Credentials | null, passwordChanged = false): Promise<void> {
    try {
      const s = await this.session(op, creds, passwordChanged);
      await this.gateway!.use(op.user, async () => {
        this.checkAuthority(op.user, op);
        const v = validateSpec(job.spec, this.cfg, job.code.py);
        if (!v.ok) throw new slurm.SlurmError(`the job spec no longer passes: ${v.problems.map((p) => `${p.field}: ${p.message}`).join('; ')}`);
        const sbatch = renderSbatch(v.spec);
        writeFileSync(join(this.store.jobDir(job.id), 'job.sbatch'), sbatch, { mode: 0o600 });
        op.emit('uploading', { files: job.code.fileCount });
        await slurm.upload(s.ssh!, job.id, this.store.jobDir(job.id));
        this.checkAuthority(op.user, op);
        op.emit('submitting');
        const id = await slurm.submit(s.ssh!, job.id);
        const now = Date.now();
        const current = this.store.byId(job.id) ?? job;
        this.store.update({
          ...current, status: 'SUBMITTED', slurmJobId: id, remoteDir: `~/${slurm.remoteDir(job.id)}`, sbatch,
          submittedAt: now, updatedAt: now, message: null,
        });
        this.store.audit({ user: op.user, action: 'submit', jobId: job.id, result: `ok slurm ${id}` });
        op.emit('submitted', { slurmJobId: id });
      });
      op.finish('done', { status: 'SUBMITTED' });
    } catch (err) {
      const m = userMessage(err);
      const current = this.store.byId(job.id);
      if (current && current.status === 'SUBMITTING') {
        this.store.update({ ...current, status: 'SUBMIT_FAILED', message: m.message, updatedAt: Date.now() });
      }
      this.store.audit({ user: op.user, action: 'submit', jobId: job.id, result: `failed ${m.code}` });
      op.finish('error', m);
    } finally { this.operationAuthority.delete(op.id); }
  }

  async refresh(op: Op, job: TrainJob, creds: Credentials | null, passwordChanged = false): Promise<void> {
    try {
      const s = await this.session(op, creds, passwordChanged);
      this.checkAuthority(op.user, op);
      const [updated] = await this.gateway!.use(op.user, () => this.refreshJobs(s, [job]));
      op.finish('done', { status: updated?.status ?? job.status });
    } catch (err) {
      op.finish('error', userMessage(err));
    } finally { this.operationAuthority.delete(op.id); }
  }

  async cancel(op: Op, job: TrainJob, creds: Credentials | null, passwordChanged = false): Promise<void> {
    try {
      const s = await this.session(op, creds, passwordChanged);
      const [updated] = await this.gateway!.use(op.user, async () => {
        this.checkAuthority(op.user, op);
        await slurm.cancel(s.ssh!, job.slurmJobId!);
        this.store.audit({ user: op.user, action: 'cancel', jobId: job.id, result: `ok slurm ${job.slurmJobId}` });
        return this.refreshJobs(s, [job]);
      });
      op.finish('done', { status: updated?.status ?? job.status });
    } catch (err) {
      op.finish('error', userMessage(err));
    } finally { this.operationAuthority.delete(op.id); }
  }

  /** Needs a live session: reading a log never asks for a code by itself. */
  async log(user: string, job: TrainJob, stream: 'out' | 'err'): Promise<string> {
    return this.gateway!.use(user, (s) => slurm.tail(s.ssh!, job.id, job.slurmJobId!, stream));
  }

  /** Layer 1 of §6.6: while someone's session is up, their active jobs stay current. */
  async poll(): Promise<void> {
    const g = this.gateway;
    if (!g) return;
    for (const user of g.users()) {
      const jobs = this.store.list(user).filter((j) => ACTIVE.includes(j.status) && j.slurmJobId !== null);
      if (!this.authorized(user)) { this.inbox.revoke(user); await g.close(user); continue; }
      if (jobs.length === 0) continue;
      try {
        await g.use(user, (s) => this.refreshJobs(s, jobs), false);
      } catch { /* the session went; the next sign-in catches up */ }
    }
  }
}
