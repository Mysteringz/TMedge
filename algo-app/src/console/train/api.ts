import { permissionChanged } from '../../entities/admin-session/index.tsx';
/** Module 02's server: /api/train (src/algo/train/routes.ts, hpc/routes.ts). */
import type { SealTicket } from '../../../../src/shared/hpcseal.js';
import type { TermTicket } from '../../../../src/shared/hpcterm.js';

export interface JobSpec {
  name: string;
  partition: string;
  cpusPerTask: number;
  memGb: number;
  gpus: number;
  timeLimit: string;
  modules: string[];
  condaEnv: string | null;
  entrypoint: string;
  args: string[];
  env: Record<string, string>;
  notifyEmail: boolean;
}

export interface Problem { field: string; message: string }

export type JobStatus = 'DRAFT' | 'SUBMITTING' | 'SUBMIT_FAILED' | 'SUBMITTED' | 'PENDING' | 'RUNNING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'OUT_OF_MEMORY' | 'UNKNOWN';

export interface CodeInfo {
  kind: 'py' | 'zip';
  filename: string;
  bytes: number;
  sha256: string;
  unpackedBytes: number;
  fileCount: number;
  py: string[];
}

export interface Upload extends CodeInfo { id: string; createdAt: number }

export interface Job {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  code: CodeInfo;
  sbatch: string;
  createdAt: number;
  updatedAt: number;
  submittedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  slurmJobId: number | null;
  exitCode: number | null;
  remoteDir: string | null;
  slurmState: string | null;
  elapsedSeconds: number | null;
  node: string | null;
  /** Why the last attempt failed, in words. */
  message: string | null;
}

export interface HpcState {
  available: boolean;
  reason: string | null;
  profile: { hkuUid: string; vpnDomain: string } | null;
  domains: string[];
  idleTtlSeconds: number;
  /** Where SSH logs in: a shared account (with a password typed each time) or the person's own UID. */
  ssh: { user: string | null; host: string; auth: 'pin' | 'shared-password' } | null;
  session: { state: 'none' | 'opening' | 'up'; uid: string | null; expiresInSeconds: number | null };
  lockedForSeconds: number;
  running: string | null;
  /** What the next sign-in will set up: confirm the cluster's host key, record the shared password's fingerprint. */
  firstUse: { hostKey: boolean; password: boolean };
}

export type HpcAction = 'submit' | 'refresh' | 'cancel';
/** The sealed-credential actions: the job ones, and "just sign in" (for the shell). */
export type SignInAction = HpcAction | 'connect';

/** The answer to starting an action: an operation to follow, or why not. */
export interface ActResult { status: number; opId?: string; error?: string; needs?: 'credentials'; retryAfterSeconds?: number }

export interface OpEvent { type: string; data: Record<string, unknown> }

export interface JobSummary {
  id: string;
  name: string;
  status: JobStatus;
  partition: string;
  gpus: number;
  code: { kind: 'py' | 'zip'; filename: string };
  slurmJobId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TrainConfig {
  verified: boolean;
  source: string;
  partitions: { name: string; maxTime: string; gpu: boolean; maxGpus: number }[];
  defaultPartition: string;
  modules: string[];
  limits: {
    maxPyMb: number; maxUploadMb: number; maxUnpackedMb: number; maxEntries: number; quotaMb: number; maxJobs: number;
    maxArgs: number; maxArgLength: number; maxEnv: number; maxEnvValue: number;
  };
  usage: { bytes: number; jobs: number };
  hpc: { backend: string; available: boolean; reason: string | null };
}

/** A refusal from the server, with per-field problems when it judged a spec. */
export class TrainError extends Error {
  constructor(message: string, readonly problems: Problem[] = [], readonly status = 0) { super(message); }
}

const write = { 'content-type': 'application/json', 'x-tm-algo': '1' };

function signIn(): void {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

async function json<T>(r: Response): Promise<T> {
  // The session ended under us: sign in, then come back here.
  permissionChanged(r.status);
  if (r.status === 401) signIn();
  const body = (await r.json().catch(() => ({}))) as { error?: string; problems?: Problem[] };
  if (!r.ok) throw new TrainError(body.error ?? `HTTP ${r.status}`, body.problems ?? [], r.status);
  return body as T;
}

async function text(r: Response): Promise<string> {
  permissionChanged(r.status);
  if (r.status === 401) signIn();
  if (!r.ok) throw new TrainError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`, [], r.status);
  return r.text();
}

const q = encodeURIComponent;

export const train = {
  config: () => fetch('/api/train/config').then(json<TrainConfig>),
  jobs: () => fetch('/api/train/jobs').then(json<{ jobs: JobSummary[] }>).then((r) => r.jobs),
  job: (id: string) => fetch(`/api/train/jobs/${q(id)}`).then(json<{ job: Job }>).then((r) => r.job),
  jobFile: (id: string, path: string) => fetch(`/api/train/jobs/${q(id)}/file?path=${q(path)}`).then(text),
  uploadFile: (id: string, path: string) => fetch(`/api/train/uploads/${q(id)}/file?path=${q(path)}`).then(text),
  preview: (spec: unknown, py: string[]) =>
    fetch('/api/train/preview', { method: 'POST', headers: write, body: JSON.stringify({ spec, py }) })
      .then(json<{ ok: true; sbatch: string } | { ok: false; problems: Problem[] }>),
  create: (uploadId: string, spec: unknown) =>
    fetch('/api/train/jobs', { method: 'POST', headers: write, body: JSON.stringify({ uploadId, spec }) })
      .then(json<{ job: Job }>).then((r) => r.job),
  update: (id: string, spec: unknown, uploadId?: string) =>
    fetch(`/api/train/jobs/${q(id)}`, { method: 'PUT', headers: write, body: JSON.stringify({ uploadId, spec }) })
      .then(json<{ job: Job }>).then((r) => r.job),
  remove: (id: string) => fetch(`/api/train/jobs/${q(id)}`, { method: 'DELETE', headers: { 'x-tm-algo': '1' } }).then(json<{ ok: boolean }>),
  /** A new draft from one of my jobs' code, with a new spec. */
  copy: (fromJobId: string, spec: unknown) =>
    fetch('/api/train/jobs', { method: 'POST', headers: write, body: JSON.stringify({ fromJobId, spec }) })
      .then(json<{ job: Job }>).then((r) => r.job),

  hpc: () => fetch('/api/train/hpc').then(json<HpcState>),
  ticket: () => fetch('/api/train/hpc/ticket', { method: 'POST', headers: write }).then(json<SealTicket>),
  endSession: () => fetch('/api/train/hpc/session', { method: 'DELETE', headers: { 'x-tm-algo': '1' } }).then(json<{ ok: boolean }>),
  /** 428 is an answer here, not an error: it means "sign in to HKU first". */
  act: async (id: string, action: HpcAction, body: unknown = {}): Promise<ActResult> => {
    const r = await fetch(`/api/train/jobs/${q(id)}/${action}`, { method: 'POST', headers: write, body: JSON.stringify(body) });
    permissionChanged(r.status);
  if (r.status === 401) signIn();
    const out = (await r.json().catch(() => ({}))) as Omit<ActResult, 'status'>;
    return { status: r.status, ...out };
  },
  /** Sign in without a job: 200 {already} with a live session, 202 {opId}, or 428. */
  connect: async (body: unknown = {}): Promise<ActResult & { already?: boolean }> => {
    const r = await fetch('/api/train/hpc/connect', { method: 'POST', headers: write, body: JSON.stringify(body) });
    permissionChanged(r.status);
  if (r.status === 401) signIn();
    return { status: r.status, ...((await r.json().catch(() => ({}))) as Omit<ActResult, 'status'>) };
  },
  answerHostKey: (opId: string, accept: boolean) =>
    fetch(`/api/train/ops/${q(opId)}/hostkey`, { method: 'POST', headers: write, body: JSON.stringify({ accept }) }).then(json<{ ok: boolean }>),
  termTicket: () => fetch('/api/train/hpc/term', { method: 'POST', headers: write }).then(json<TermTicket>),
  log: async (id: string, stream: 'out' | 'err'): Promise<{ status: number; text?: string; error?: string }> => {
    const r = await fetch(`/api/train/jobs/${q(id)}/log?stream=${stream}`);
    permissionChanged(r.status);
  if (r.status === 401) signIn();
    if (r.ok) return { status: r.status, text: await r.text() };
    return { status: r.status, ...((await r.json().catch(() => ({}))) as { error?: string }) };
  },
  /** Follows an operation's Server-Sent Events until "done" or "error". */
  follow: (opId: string, onEvent: (e: OpEvent) => void) => new Promise<OpEvent>((resolve) => {
    const es = new EventSource(`/api/train/ops/${q(opId)}/events`);
    const types = ['vpn_auth', 'vpn_connect', 'vpn_up', 'host_key_scan', 'host_key', 'ssh_auth', 'ssh_up', 'password_recorded',
      'session_reused', 'uploading', 'submitting', 'submitted', 'done', 'error'];
    let last: OpEvent = { type: 'error', data: { message: 'lost the connection to the console' } };
    for (const type of types) {
      es.addEventListener(type, (m) => {
        last = { type, data: JSON.parse((m as MessageEvent<string>).data) as Record<string, unknown> };
        onEvent(last);
        if (type === 'done' || type === 'error') { es.close(); resolve(last); }
      });
    }
    // The server ends the stream after the last event; anything else is a lost connection.
    es.onerror = () => { es.close(); resolve(last); };
  }),

  /**
   * The file is the body. XHR rather than fetch because only XHR reports
   * upload progress, and the console's progress bar should mean something.
   */
  upload: (filename: string, body: Blob, onProgress: (fraction: number) => void) => new Promise<Upload>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/train/uploads?filename=${q(filename)}`);
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.setRequestHeader('x-tm-algo', '1');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      if (x.status === 401) { signIn(); return; }
      let out: { upload?: Upload; error?: string } = {};
      try { out = JSON.parse(x.responseText) as typeof out; } catch { /* a proxy's HTML page */ }
      if (x.status === 201 && out.upload) return resolve(out.upload);
      // Cloudflare answers 413 itself, in HTML, past 100 MB.
      const why = out.error ?? (x.status === 413 ? 'the file is too large to upload' : `HTTP ${x.status}`);
      return reject(new TrainError(why, [], x.status));
    };
    x.onerror = () => reject(new TrainError('the upload did not reach the console'));
    x.send(body);
  }),
};
