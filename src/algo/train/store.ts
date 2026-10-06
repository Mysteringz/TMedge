/**
 * Module 02's jobs: one JSON file of records plus a directory of code per
 * job, under DATA_DIR/algo/train/.
 *
 * The handover draws Postgres here (§8). One process writes this, for a
 * team of a few people and at most MAX_JOBS_PER_USER jobs each, so it keeps
 * the console's existing habit -- atomic private JSON files, as for accounts
 * and pipelines -- and the record shape stays the handover's so moving to a
 * table later is a copy. docs/hpc/decisions.md has the reasoning.
 *
 * Nothing credential-shaped ever enters a record: no PIN, OTP or HPC
 * password exists anywhere in this module until M4, and when it does it
 * lives in a request handler's memory only (HANDOVER.md rule 2).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateJson } from '../../shared/private-file.js';
import type { JobSpec } from './spec.js';

/** HANDOVER.md §8. Only DRAFT is reachable until a backend exists. */
export const JOB_STATUSES = ['DRAFT', 'SUBMITTING', 'SUBMIT_FAILED', 'SUBMITTED', 'PENDING', 'RUNNING',
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'UNKNOWN'] as const;
export type JobStatus = typeof JOB_STATUSES[number];
/** A job that has not left the dashboard can still be edited or thrown away. */
export const EDITABLE: readonly JobStatus[] = ['DRAFT', 'SUBMIT_FAILED'];

export const MAX_JOBS_PER_USER = 100;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CodeInfo {
  kind: 'py' | 'zip';
  /** What the person uploaded, e.g. train.py or project.zip. */
  filename: string;
  bytes: number;
  sha256: string;
  unpackedBytes: number;
  fileCount: number;
  /** Every .py file, relative to the code root: the entrypoint choices. */
  py: string[];
}

export interface TrainJob {
  id: string;
  user: string;
  spec: JobSpec;
  status: JobStatus;
  code: CodeInfo;
  /** The script as rendered when the draft was saved: exactly what would be submitted. */
  sbatch: string;
  createdAt: number;
  updatedAt: number;
  submittedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  slurmJobId: number | null;
  remoteDir: string | null;
  exitCode: number | null;
  lastPolledAt: number | null;
  /** SLURM's own words for the state, e.g. "CANCELLED by 12345". */
  slurmState: string | null;
  elapsedSeconds: number | null;
  node: string | null;
  /** Why the last attempt failed, in words for the person; never a credential. */
  message: string | null;
}

/** Records written before a field existed read as null, not undefined. */
function normalise(j: TrainJob): TrainJob {
  return { ...j, slurmState: j.slurmState ?? null, elapsedSeconds: j.elapsedSeconds ?? null, node: j.node ?? null, message: j.message ?? null };
}

/** Jobs SLURM might still change. */
export const ACTIVE: readonly JobStatus[] = ['SUBMITTED', 'PENDING', 'RUNNING', 'UNKNOWN'];

export class StoreError extends Error {}

function looksLikeJob(j: unknown): j is TrainJob {
  if (typeof j !== 'object' || j === null) return false;
  const o = j as Record<string, unknown>;
  return typeof o.id === 'string' && UUID.test(o.id) && typeof o.user === 'string' &&
    typeof o.status === 'string' && (JOB_STATUSES as readonly string[]).includes(o.status) &&
    typeof o.spec === 'object' && o.spec !== null && typeof o.code === 'object' && o.code !== null &&
    typeof o.sbatch === 'string' && typeof o.createdAt === 'number';
}

export class JobStore {
  private jobs = new Map<string, TrainJob>();
  /**
   * Set when jobs.json exists but cannot be read. Everything then refuses,
   * reads included: a store that "starts fresh" over an unreadable file
   * would overwrite every job with an empty list on the first save.
   */
  readonly error: string | null = null;
  readonly file: string;
  readonly jobsDir: string;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, 'jobs.json');
    this.jobsDir = join(root, 'jobs');
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) return;
    try {
      const list: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(list) || !list.every(looksLikeJob)) throw new Error('not a list of jobs');
      this.jobs = new Map(list.map((j) => [j.id, normalise(j)]));
    } catch (err) {
      this.error = `${this.file} is unreadable (${(err as Error).message}); module 02 is read-only until it is repaired`;
    }
  }

  private check(): void {
    if (this.error) throw new StoreError(this.error);
  }

  private save(): void {
    writePrivateJson(this.file, [...this.jobs.values()]);
  }

  /** A person's jobs, newest first. */
  list(user: string): TrainJob[] {
    this.check();
    return [...this.jobs.values()].filter((j) => j.user === user).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Someone else's job is indistinguishable from no job (404, never 403). */
  get(user: string, id: string): TrainJob | undefined {
    this.check();
    const j = UUID.test(id) ? this.jobs.get(id) : undefined;
    return j && j.user === user ? j : undefined;
  }

  count(user: string): number {
    return this.list(user).length;
  }

  /** Bytes of extracted code a person holds across their jobs. */
  usage(user: string): number {
    return this.list(user).reduce((n, j) => n + j.code.unpackedBytes, 0);
  }

  codeDir(id: string): string {
    if (!UUID.test(id)) throw new StoreError('bad job id');
    return join(this.jobsDir, id, 'code');
  }

  /** Adopts an unpacked upload as the job's code, then records the job. */
  create(job: TrainJob, codeFrom: string): void {
    this.check();
    mkdirSync(join(this.jobsDir, job.id), { mode: 0o700 });
    renameSync(codeFrom, this.codeDir(job.id));
    this.jobs.set(job.id, job);
    this.save();
  }

  /** A new job with a copy of another job's code. */
  createCopy(job: TrainJob, codeOf: string): void {
    this.check();
    mkdirSync(join(this.jobsDir, job.id), { mode: 0o700 });
    cpSync(codeOf, this.codeDir(job.id), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    this.jobs.set(job.id, job);
    this.save();
  }

  /** Replaces a job's record, and its code when `codeFrom` is given. */
  update(job: TrainJob, codeFrom?: string): void {
    this.check();
    if (codeFrom) {
      const dir = this.codeDir(job.id);
      const old = `${dir}.old-${Date.now()}`;
      renameSync(dir, old);
      renameSync(codeFrom, dir);
      rmSync(old, { recursive: true, force: true });
    }
    this.jobs.set(job.id, job);
    this.save();
  }

  remove(job: TrainJob): void {
    this.check();
    this.jobs.delete(job.id);
    this.save();
    rmSync(join(this.jobsDir, job.id), { recursive: true, force: true });
  }

  /** Job directories no record points at: left by a crash between rename and save. */
  sweep(): number {
    if (this.error) return 0;
    let removed = 0;
    for (const name of readdirSync(this.jobsDir)) {
      if (!this.jobs.has(name)) {
        rmSync(join(this.jobsDir, name), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  /** Another person's job too: for the poller, which works per session. */
  byId(id: string): TrainJob | undefined {
    this.check();
    return UUID.test(id) ? this.jobs.get(id) : undefined;
  }

  jobDir(id: string): string {
    if (!UUID.test(id)) throw new StoreError('bad job id');
    return join(this.jobsDir, id);
  }

  /** HANDOVER.md §8 audit_log: who did what to which job. Never a credential. */
  audit(entry: { user: string; action: string; jobId?: string | null; ip?: string; userAgent?: string; result: string }): void {
    try {
      appendFileSync(join(this.root, 'audit.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), ...entry, userAgent: entry.userAgent?.slice(0, 200) })}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn(`[algo] module 02 audit write failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Who each person is at HKU (§6.1 hpc_profiles): their UID and which VPN
 * domain they log in with. Neither is a secret; the PIN never comes here.
 */
export interface HpcProfile { hkuUid: string; vpnDomain: string }
export const HKU_UID = /^[a-z0-9]{2,32}$/;

export class ProfileStore {
  private profiles: Record<string, HpcProfile> = {};
  private readonly file: string;

  constructor(root: string) {
    this.file = join(root, 'profiles.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, HpcProfile>;
      for (const [user, p] of Object.entries(raw)) {
        if (p && typeof p.hkuUid === 'string' && HKU_UID.test(p.hkuUid) && typeof p.vpnDomain === 'string') this.profiles[user] = { hkuUid: p.hkuUid, vpnDomain: p.vpnDomain };
      }
    } catch { /* an unreadable file costs people retyping a UID, nothing more */ }
  }

  get(user: string): HpcProfile | null {
    return Object.hasOwn(this.profiles, user) ? this.profiles[user]! : null;
  }

  set(user: string, p: HpcProfile): void {
    this.profiles = { ...this.profiles, [user]: { hkuUid: p.hkuUid, vpnDomain: p.vpnDomain } };
    writePrivateJson(this.file, this.profiles);
  }
}
