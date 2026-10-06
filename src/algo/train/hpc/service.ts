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
import { loadFingerprint, matches } from './fingerprint.js';
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
      openconnect: findTool('openconnect', a?.tools.openconnect ?? null),
      ocproxy: findTool('ocproxy', a?.tools.ocproxy ?? null),
      ssh: findTool('ssh', a?.tools.ssh ?? null),
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

  /** Null when jobs can be sent; otherwise what is missing, for the UI. */
  unavailable(): string | null {
    const a = this.cfg.planA;
    if (!a) return 'Submission to HPC2021 is not switched on (backend "none" in config/hpc.json).';
    if (!this.tools.openconnect) return 'openconnect is not installed on this server.';
    if (!this.tools.ocproxy) return 'ocproxy is not installed on this server.';
    if (!this.tools.ssh) return 'ssh is not installed on this server.';
    if (!existsSync(this.knownHosts) || !readFileSync(this.knownHosts, 'utf8').split('\n').some((l) => l.split(/[\s,]/).includes(a.submitHost))) {
      return `${a.submitHost}'s SSH host key is not pinned yet: an admin runs npm run hpc-hostkeys on the server once, with their own HKU login.`;
    }
    if (a.sshAuth === 'shared-password' && !loadFingerprint(this.fingerprintFile)) {
      return `The password for ${a.sshUser}@${a.submitHost} has not been set up: an admin runs npm run hpc-password on the server.`;
    }
    return null;
  }

  /** Who and where SSH logs in as, for the sign-in form. */
  sshTarget(): { user: string | null; host: string; auth: 'pin' | 'shared-password' } | null {
    const a = this.cfg.planA;
    return a ? { user: a.sshUser, host: a.submitHost, auth: a.sshAuth } : null;
  }

  /**
   * Before any login: in shared-password mode the typed password must match
   * its fingerprint. A wrong one ends here, having reached nothing.
   */
  private async checkServerPassword(user: string, creds: Credentials): Promise<void> {
    const a = this.cfg.planA!;
    if (a.sshAuth !== 'shared-password') return;
    const fp = loadFingerprint(this.fingerprintFile);
    if (!fp) throw new GatewayBusy(this.unavailable() ?? 'The shared password is not set up.');
    if (creds.sshPasswordGiven() === null) throw new ServerPasswordWrong(`Type the password for ${a.sshUser}@${a.submitHost}.`);
    if (!(await matches(creds.sshPasswordGiven()!, fp))) {
      if (!this.wrongPassword.allow(user)) throw new ServerPasswordWrong('Too many wrong cluster passwords; wait 15 minutes.');
      throw new ServerPasswordWrong(`That is not the password for ${a.sshUser}@${a.submitHost}. It was checked here; nothing was sent to HKU or the cluster.`);
    }
  }

  domains(): string[] { return this.cfg.planA?.vpnDomains ?? []; }
  idleTtlSeconds(): number { return this.cfg.planA?.idleTtlSeconds ?? 0; }

  vpnUser(p: HpcProfile): string { return `${p.hkuUid}@${p.vpnDomain}`; }

  /** The session to use: the live one, or a new login with `creds`, which are wiped either way. */
  private async session(op: Op, creds: Credentials | null): Promise<Session> {
    const g = this.gateway!;
    try {
      const live = g.live(op.user);
      if (live) { op.emit('session_reused', { uid: live.uid }); return live; }
      if (!creds) throw new GatewayBusy('Your HKU session has ended; sign in again.');
      const profile = this.profiles.get(op.user);
      if (!profile) throw new GatewayBusy('Set your HKU UID first.');
      await this.checkServerPassword(op.user, creds);
      return await g.open(op.user, profile.hkuUid, this.vpnUser(profile), creds, (step) => op.emit(step));
    } finally {
      // The login is over, one way or the other: nothing below needs a secret.
      creds?.wipe();
    }
  }

  /** Applies SLURM's answer to a job record. */
  private apply(job: TrainJob, st: slurm.SlurmState): TrainJob {
    const now = Date.now();
    const terminal = !ACTIVE.includes(st.status) && st.status !== 'SUBMITTED';
    const next: TrainJob = {
      ...job, status: st.status, slurmState: st.raw, exitCode: st.exitCode, elapsedSeconds: st.elapsedSeconds,
      node: st.node, lastPolledAt: now, updatedAt: now,
      startedAt: job.startedAt ?? (st.status === 'RUNNING' || terminal ? now - (st.elapsedSeconds ?? 0) * 1000 : null),
      endedAt: terminal ? job.endedAt ?? now : null,
    };
    this.store.update(next);
    return next;
  }

  private async refreshJobs(s: Session, jobs: TrainJob[]): Promise<TrainJob[]> {
    const withIds = jobs.filter((j) => j.slurmJobId !== null);
    if (withIds.length === 0) return [];
    const states = await slurm.status(s.ssh!, withIds.map((j) => j.slurmJobId!));
    const out: TrainJob[] = [];
    for (const j of withIds) {
      const st = states.get(j.slurmJobId!);
      // sacct can lag a fresh submission by a few seconds: keep what we know.
      const current = this.store.byId(j.id);
      if (st && current) out.push(this.apply(current, st));
    }
    return out;
  }

  /** Submit a saved draft. The job is already SUBMITTING (routes.ts did that synchronously). */
  async submit(op: Op, job: TrainJob, creds: Credentials | null): Promise<void> {
    try {
      const s = await this.session(op, creds);
      await this.gateway!.use(op.user, async () => {
        const v = validateSpec(job.spec, this.cfg, job.code.py);
        if (!v.ok) throw new slurm.SlurmError(`the job spec no longer passes: ${v.problems.map((p) => `${p.field}: ${p.message}`).join('; ')}`);
        const sbatch = renderSbatch(v.spec);
        writeFileSync(join(this.store.jobDir(job.id), 'job.sbatch'), sbatch, { mode: 0o600 });
        op.emit('uploading', { files: job.code.fileCount });
        await slurm.upload(s.ssh!, job.id, this.store.jobDir(job.id));
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
    }
  }

  async refresh(op: Op, job: TrainJob, creds: Credentials | null): Promise<void> {
    try {
      const s = await this.session(op, creds);
      const [updated] = await this.gateway!.use(op.user, () => this.refreshJobs(s, [job]));
      op.finish('done', { status: updated?.status ?? job.status });
    } catch (err) {
      op.finish('error', userMessage(err));
    }
  }

  async cancel(op: Op, job: TrainJob, creds: Credentials | null): Promise<void> {
    try {
      const s = await this.session(op, creds);
      const [updated] = await this.gateway!.use(op.user, async () => {
        await slurm.cancel(s.ssh!, job.slurmJobId!);
        this.store.audit({ user: op.user, action: 'cancel', jobId: job.id, result: `ok slurm ${job.slurmJobId}` });
        return this.refreshJobs(s, [job]);
      });
      op.finish('done', { status: updated?.status ?? job.status });
    } catch (err) {
      op.finish('error', userMessage(err));
    }
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
      if (jobs.length === 0) continue;
      try {
        await g.use(user, (s) => this.refreshJobs(s, jobs), false);
      } catch { /* the session went; the next sign-in catches up */ }
    }
  }
}
