/** Module 02's server: /api/train (src/algo/train/routes.ts). */

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
}

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
  if (r.status === 401) signIn();
  const body = (await r.json().catch(() => ({}))) as { error?: string; problems?: Problem[] };
  if (!r.ok) throw new TrainError(body.error ?? `HTTP ${r.status}`, body.problems ?? [], r.status);
  return body as T;
}

async function text(r: Response): Promise<string> {
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
