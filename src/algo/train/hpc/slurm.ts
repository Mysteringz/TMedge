/**
 * SLURM on HPC2021, over the person's SSH connection (HANDOVER.md §6.5).
 *
 * Every remote command is a fixed string. The only values in them are job
 * ids (validated integers) and the job's directory, which this server made
 * from a UUID; no string from the job spec ever reaches a remote shell
 * except inside job.sbatch, which sbatch.ts renders and test/train.test.ts
 * proves inert.
 *
 * Remote layout: ~/hpc-dash/jobs/<job uuid>/{code/, job.sbatch, slurm-<id>.out, slurm-<id>.err}.
 * Commands run in the login shell's home directory, so the paths are relative
 * and nothing here needs to know where $HOME is.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { JobStatus } from '../store.js';
import { UUID } from '../store.js';
import type { SshLike } from './ssh.js';
import { childEnv } from './openconnect.js';

export interface SlurmState {
  status: JobStatus;
  /** The raw state, e.g. "CANCELLED by 12345", for the person to read. */
  raw: string;
  /** The scheduler's reason for waiting, when the job is still in squeue. */
  reason: string | null;
  exitCode: number | null;
  elapsedSeconds: number | null;
  node: string | null;
}

export class SlurmError extends Error {}

export const remoteDir = (jobId: string): string => {
  if (!UUID.test(jobId)) throw new SlurmError('bad job id');
  return `hpc-dash/jobs/${jobId}`;
};

const slurmId = (n: number): string => {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 40) throw new SlurmError('bad SLURM job id');
  return String(n);
};

/** `sbatch --parsable` prints "<id>" or "<id>;<cluster>". */
export function parseSbatch(out: string): number | null {
  const m = /^(\d+)(?:;\S*)?\s*$/m.exec(out.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** SLURM's states, folded into the handover's job statuses (§8). */
export function mapState(raw: string): JobStatus {
  const s = raw.trim().split(/\s+/)[0]?.replace(/\+$/, '').toUpperCase() ?? '';
  switch (s) {
    case 'PENDING': case 'REQUEUED': case 'REQUEUE_HOLD': case 'REQUEUE_FED': case 'RESV_DEL_HOLD': case 'CONFIGURING': return 'PENDING';
    case 'RUNNING': case 'COMPLETING': case 'SUSPENDED': case 'STAGE_OUT': case 'RESIZING': case 'SIGNALING': return 'RUNNING';
    case 'COMPLETED': return 'COMPLETED';
    case 'FAILED': case 'NODE_FAIL': case 'BOOT_FAIL': case 'PREEMPTED': case 'REVOKED': return 'FAILED';
    case 'CANCELLED': return 'CANCELLED';
    case 'TIMEOUT': case 'DEADLINE': return 'TIMEOUT';
    case 'OUT_OF_MEMORY': return 'OUT_OF_MEMORY';
    default: return 'UNKNOWN';
  }
}

/** [D-]HH:MM:SS or MM:SS to seconds. */
export function parseElapsed(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [d, h, mi, se] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  return ((d * 24 + h) * 60 + mi) * 60 + se;
}

/**
 * `sacct -j <ids> --format=JobID,State,ExitCode,Elapsed,Start,End,NodeList
 * --parsable2 --noheader`. Steps (.batch, .extern, .0) are skipped; only the
 * allocation line describes the job.
 */
export function parseSacct(out: string): Map<number, SlurmState> {
  const states = new Map<number, SlurmState>();
  for (const line of out.split('\n')) {
    const f = line.split('|');
    if (f.length < 7 || !/^\d+$/.test(f[0]!)) continue;
    const id = Number(f[0]);
    const exit = /^(\d+):(\d+)$/.exec(f[2]!);
    const node = f[6]!.trim();
    states.set(id, {
      status: mapState(f[1]!), raw: f[1]!.trim(), reason: null,
      exitCode: exit ? Number(exit[1]) : null,
      elapsedSeconds: parseElapsed(f[3]!),
      node: node && node !== 'None' && node !== 'None assigned' ? node : null,
    });
  }
  return states;
}

const present = (value: string | undefined): string | null => {
  const text = value?.trim() ?? '';
  return text && !['None', 'None assigned', '(null)', 'N/A'].includes(text) ? text : null;
};

/** `squeue -h -j <ids> -o '%i|%T|%r|%M|%N'`; reasons can contain spaces. */
export function parseSqueue(out: string): Map<number, SlurmState> {
  const states = new Map<number, SlurmState>();
  for (const line of out.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 2 || !/^\d+$/.test(f[0]!)) continue;
    const raw = f[1]!.trim();
    states.set(Number(f[0]), {
      status: mapState(raw), raw, reason: present(f[2]), exitCode: null,
      elapsedSeconds: parseElapsed(f[3] ?? ''), node: present(f[4]),
    });
  }
  return states;
}

/** The first line of a remote error, trimmed, for the person to read. */
const firstLine = (s: string) => s.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300);

/**
 * Copies the job's code and job.sbatch (from `localJobDir`) to its remote
 * directory, replacing what an earlier failed attempt left. tar over the
 * open SSH connection: no second login for SFTP.
 */
export async function upload(ssh: SshLike, jobId: string, localJobDir: string): Promise<void> {
  const dir = remoteDir(jobId);
  const tar = spawn('tar', ['-C', localJobDir, '-cf', '-', 'code', 'job.sbatch'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  let tarErr = '';
  tar.stderr!.on('data', (b: Buffer) => { tarErr += b.toString('utf8'); });
  const r = await ssh.run(`set -e; mkdir -p ${dir}; cd ${dir}; rm -rf code job.sbatch; tar -xf -`, { stdin: tar.stdout!, timeoutMs: 300_000 });
  const tarCode = await new Promise<number>((ok) => (tar.exitCode !== null ? ok(tar.exitCode) : tar.once('close', (c) => ok(c ?? -1))));
  if (tarCode !== 0) throw new SlurmError(`could not pack the code (${firstLine(tarErr)})`);
  if (r.code !== 0) throw new SlurmError(`copying the code to HPC2021 failed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
}

/** sbatch from the job's directory: --output/--error are relative to it (sbatch.ts). */
export async function submit(ssh: SshLike, jobId: string): Promise<number> {
  const r = await ssh.run(`cd ${remoteDir(jobId)} && sbatch --parsable job.sbatch`);
  const id = r.code === 0 ? parseSbatch(r.stdout.toString('utf8')) : null;
  if (id === null) throw new SlurmError(`sbatch refused the job: ${firstLine(r.stderr) || firstLine(r.stdout.toString('utf8')) || `exit ${r.code}`}`);
  return id;
}

/** The live queue wins over lagging accounting, and carries pending reasons. */
export async function status(ssh: SshLike, ids: number[]): Promise<Map<number, SlurmState>> {
  if (ids.length === 0) return new Map();
  const list = ids.map(slurmId).join(',');
  const r = await ssh.run(`sacct -j ${list} --format=JobID,State,ExitCode,Elapsed,Start,End,NodeList --parsable2 --noheader`);
  const fromSacct = r.code === 0 ? parseSacct(r.stdout.toString('utf8')) : new Map<number, SlurmState>();
  const q = await ssh.run(`squeue -h -j ${list} -o '%i|%T|%r|%M|%N'`);
  const fromSqueue = q.code === 0 ? parseSqueue(q.stdout.toString('utf8')) : new Map<number, SlurmState>();
  for (const [id, s] of fromSqueue) fromSacct.set(id, s);
  return fromSacct;
}

/** A batch script's own result, used only after both scheduler queries have no record. */
export function parseExitReport(out: string, id: number): SlurmState | null {
  const match = /^TMEDGE_EXIT_V1\|(\d+)\|(\d{1,3})\|(\d+)\s*$/.exec(out);
  if (!match || match[1] !== slurmId(id)) return null;
  const exitCode = Number(match[2]);
  const elapsedSeconds = Number(match[3]);
  if (exitCode > 255 || !Number.isSafeInteger(elapsedSeconds)) return null;
  const status = exitCode === 0 ? 'COMPLETED' : 'FAILED';
  return { status, raw: status, reason: null, exitCode, elapsedSeconds, node: null };
}

export async function completion(ssh: SshLike, jobId: string, id: number): Promise<SlurmState | null> {
  const file = `${remoteDir(jobId)}/.tmedge-exit-${slurmId(id)}`;
  const r = await ssh.run(`if test -f ${file}; then head -c 256 ${file}; fi`, { maxBytes: 1024 });
  return r.code === 0 ? parseExitReport(r.stdout.toString('utf8'), id) : null;
}

/** The last `maxBytes` of slurm-<id>.out or .err; empty when it does not exist yet. */
export async function tail(ssh: SshLike, jobId: string, id: number, stream: 'out' | 'err', maxBytes = 65536): Promise<string> {
  const n = Math.max(1, Math.min(1024 * 1024, Math.floor(maxBytes)));
  const file = join(remoteDir(jobId), `slurm-${slurmId(id)}.${stream === 'err' ? 'err' : 'out'}`);
  const r = await ssh.run(`test -f ${file} && tail -c ${n} ${file} || true`, { maxBytes: n + 1024 });
  return r.stdout.toString('utf8');
}

export async function cancel(ssh: SshLike, id: number): Promise<void> {
  const r = await ssh.run(`scancel ${slurmId(id)}`);
  if (r.code !== 0) throw new SlurmError(`scancel refused: ${firstLine(r.stderr) || `exit ${r.code}`}`);
}
