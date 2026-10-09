/**
 * ML Training, module 02: write or upload a training script, say what it
 * needs from the HKU cluster (SLURM), keep it as a draft whose job.sbatch is
 * exactly what will be submitted, and send it (docs/hpc/HANDOVER.md, Plan A).
 *
 * Sending signs the person in as themselves: their own HKUVPN login (UID,
 * Portal PIN, one-time code) opens their own tunnel, and SSH logs in to the
 * cluster -- as a shared account with a password typed each time, or as
 * them (train/SignIn.tsx). When the box cannot send yet, the screen says
 * why instead of pretending.
 *
 * The design's results and export cards become the job's state and its
 * spec: this module shows what SLURM reports and makes no numbers up.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { FilePy, FloppyDisk, PaperPlaneRight, Plus, UploadSimple, XMark } from './icons.tsx';
import { Toast, useToast } from './parts.tsx';
import { CodeEditor } from './train/CodeEditor.tsx';
import { train, TrainError, type HpcState, type Job, type JobSpec, type JobSummary, type OpEvent, type Problem, type SignInAction, type TrainConfig } from './train/api.ts';
import { HostKeyPrompt } from './train/HostKey.tsx';
import { ClusterTerminal } from './train/Terminal.tsx';
import { installCspShims } from './train/csp.ts';

// Before CodeMirror or xterm.js draw anything (train/csp.ts).
installCspShims();
import { SignIn } from './train/SignIn.tsx';

const DEFAULT_SCRIPT = `# algo.hkumyseat.com — training job for the HKU cluster (SLURM)
# Runs on a compute node using the selected environment's Python, or python3.
# Requires pandas, scikit-learn and pyarrow, plus an existing --data file.
# Data is not uploaded from here: --data is a path on HPC storage.
import argparse
import os

import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score, f1_score, log_loss
from sklearn.model_selection import train_test_split

FEATURES = ["hour", "weekday", "temp_c", "noise_db", "wifi_clients"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="parquet file on HPC storage")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--lr", type=float, default=0.05)
    args = ap.parse_args()

    # Arguments arrive exactly as typed, so ~ is expanded here, not by a shell.
    df = pd.read_parquet(os.path.expanduser(args.data)).dropna()
    X, y = df[FEATURES], df["occupied"].astype(int)
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)

    model = GradientBoostingClassifier(n_estimators=args.epochs * 20, learning_rate=args.lr, verbose=1)
    model.fit(X_tr, y_tr)

    pred = model.predict(X_te)
    print(f"accuracy {accuracy_score(y_te, pred):.4f}", flush=True)
    print(f"f1       {f1_score(y_te, pred):.4f}", flush=True)
    print(f"val_loss {log_loss(y_te, model.predict_proba(X_te)):.4f}", flush=True)


if __name__ == "__main__":
    main()
`;

/** Per-viewer convenience: an unsaved script survives a reload. Never needed for correctness. */
const STORE_KEY = 'algo_train_v1';
const FILENAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\.py$/;
const EDITABLE = new Set(['DRAFT', 'SUBMIT_FAILED']);
/** States SLURM may still change. */
const ACTIVE = new Set(['SUBMITTED', 'PENDING', 'RUNNING', 'UNKNOWN']);

/** What each step of an HKU action looks like in the console, and how far along the bar it is. */
const STEPS: Record<string, { at?: number; tone: Tone; say(d: Record<string, unknown>): string }> = {
  vpn_auth: { at: 0.1, tone: 'info', say: () => '[vpn]    signing in to HKUVPN as you (one attempt)' },
  vpn_connect: { at: 0.25, tone: 'info', say: () => '[vpn]    accepted · opening your own tunnel' },
  vpn_up: { at: 0.4, tone: 'info', say: () => '[vpn]    tunnel up' },
  host_key_scan: { at: 0.45, tone: 'info', say: () => "[ssh]    first connection: fetching the cluster's host key" },
  host_key: { tone: 'accent', say: () => '[ssh]    confirm the host key to continue (nothing logs in until you do)' },
  password_recorded: { tone: 'info', say: () => '[ssh]    the cluster accepted the password · its fingerprint is kept to check typos next time' },
  ssh_auth: { at: 0.5, tone: 'info', say: () => '[ssh]    signing in to the cluster' },
  ssh_up: { at: 0.6, tone: 'info', say: () => '[ssh]    signed in · your PIN and code are wiped from the server' },
  session_reused: { at: 0.6, tone: 'info', say: () => '[hku]    using your open session · no code needed' },
  uploading: { at: 0.75, tone: 'info', say: (d) => `[upload] copying ${String(d.files ?? '')} file(s) to ~/hpc-dash/jobs/` },
  submitting: { at: 0.9, tone: 'info', say: () => '[sbatch] sbatch --parsable job.sbatch' },
  submitted: { at: 1, tone: 'accent', say: (d) => `[slurm]  accepted as job ${String(d.slurmJobId)}` },
  done: { tone: 'accent', say: (d) => `[done]   ${String(d.status ?? 'ok')}` },
  error: { tone: 'err', say: (d) => `! ${String(d.message ?? 'failed')}` },
};

function duration(sec: number | null): string {
  if (sec === null) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(x).padStart(2, '0')}s`;
}

const LABELS: Record<string, string> = {
  name: 'Job name', partition: 'Partition', cpusPerTask: 'CPUs', memGb: 'Mem GB', gpus: 'GPUs', timeLimit: 'Time',
  modules: 'Modules', condaEnv: 'Conda env', entrypoint: 'Entrypoint', args: 'Arguments', env: 'Environment', notifyEmail: 'Email',
};

interface Form {
  name: string; partition: string; cpus: string; mem: string; gpus: string; time: string;
  modules: string[]; conda: string; entrypoint: string; args: string; env: string;
}

/**
 * The code a draft runs. A script is edited here (and uploaded on save
 * unless it is what the saved job already has); a zip is a project
 * uploaded whole and shown read-only, one file at a time.
 */
type Source =
  | { kind: 'script'; filename: string; text: string; saved: boolean }
  | { kind: 'zip'; filename: string; py: string[]; uploadId: string | null };

type Tone = 'cmd' | 'info' | 'muted' | 'accent' | 'err';
interface Line { t: string; tone: Tone }

function loadScript(): Source {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { filename?: unknown; text?: unknown } | null;
    if (saved && typeof saved.filename === 'string' && FILENAME.test(saved.filename) && typeof saved.text === 'string') {
      return { kind: 'script', filename: saved.filename, text: saved.text, saved: false };
    }
  } catch { /* private mode, or nothing kept */ }
  return { kind: 'script', filename: 'train.py', text: DEFAULT_SCRIPT, saved: false };
}

function keepScript(s: Source): void {
  try {
    if (s.kind === 'script' && !s.saved) localStorage.setItem(STORE_KEY, JSON.stringify({ filename: s.filename, text: s.text }));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* not essential */ }
}

function defaultForm(cfg: TrainConfig, entrypoint: string): Form {
  return {
    name: 'occupancy_gbc', partition: cfg.defaultPartition, cpus: '4', mem: '16', gpus: '0', time: '2:00:00',
    modules: [], conda: '', entrypoint, args: '--data ~/myseat/seat_occupancy_2026Q3.parquet --epochs 10', env: 'OMP_NUM_THREADS=4',
  };
}

function formOf(s: JobSpec): Form {
  return {
    name: s.name, partition: s.partition, cpus: String(s.cpusPerTask), mem: String(s.memGb), gpus: String(s.gpus),
    time: s.timeLimit, modules: [...s.modules], conda: s.condaEnv ?? '', entrypoint: s.entrypoint,
    args: s.args.join(' '), env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n'),
  };
}

/** The form as the server's spec. Numbers that are not numbers go as typed, for the server to name. */
function specOf(f: Form): { spec: Record<string, unknown>; local: Problem[] } {
  const local: Problem[] = [];
  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : s);
  const env: Record<string, string> = {};
  f.env.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    const eq = line.indexOf('=');
    if (eq < 1) { local.push({ field: 'env', message: `line ${i + 1} is not NAME=value` }); return; }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  });
  return {
    spec: {
      name: f.name.trim(), partition: f.partition, cpusPerTask: int(f.cpus), memGb: int(f.mem), gpus: int(f.gpus),
      timeLimit: f.time.trim(), modules: f.modules, condaEnv: f.conda.trim() || null, entrypoint: f.entrypoint,
      args: f.args.trim() ? f.args.trim().split(/\s+/) : [], env, notifyEmail: false,
    },
    local,
  };
}

const mb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function tagClass(status: string): string {
  if (status === 'NEW' || status === 'DRAFT') return 'tag-neutral';
  if (status === 'COMPLETED') return 'tag-outline';
  if (['FAILED', 'SUBMIT_FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'UNKNOWN'].includes(status)) return 'tag-outline cx-tag-bad';
  return 'tag-accent';
}
function pickEntrypoint(py: string[]): string {
  return py.find((f) => f === 'train.py') ?? py.find((f) => /(^|\/)train[^/]*\.py$/.test(f)) ?? py.find((f) => /(^|\/)main\.py$/.test(f)) ?? py[0] ?? '';
}

export function Train() {
  const [cfg, setCfg] = useState<TrainConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  /** The saved job being edited; null while writing a new draft. */
  const [job, setJob] = useState<Job | null>(null);
  const [source, setSource] = useState<Source>(loadScript);
  const [form, setForm] = useState<Form | null>(null);
  const [viewText, setViewText] = useState('');
  const [tab, setTab] = useState<'code' | 'sbatch' | 'log'>('code');
  const [hpc, setHpc] = useState<HpcState | null>(null);
  const [signIn, setSignIn] = useState<{ action: SignInAction; jobId: string | null; jobName: string | null; then?: 'log' | 'shell' } | null>(null);
  const [acting, setActing] = useState<SignInAction | null>(null);
  const [hostKeyAsk, setHostKeyAsk] = useState<{ opId: string; host: string; keys: { type: string; fingerprint: string }[] } | null>(null);
  /** The CONSOLE shows the dashboard's own log, or a shell on the cluster. */
  const [consoleMode, setConsoleMode] = useState<'log' | 'ssh'>('log');
  /** Bumped to (re)mount the terminal; 0 = none wanted. */
  const [termKey, setTermKey] = useState(0);
  const [logText, setLogText] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ sbatch: string | null; problems: Problem[] }>({ sbatch: null, problems: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'' | 'upload' | 'save' | 'load'>('');
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<Line[]>([{ t: '$ hpc-dash status', tone: 'cmd' }]);
  const [toast, flash] = useToast();
  const logEl = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  const say = useCallback((t: string, tone: Tone = 'info') => setLog((l) => [...l.slice(-300), { t, tone }]), []);
  const py = useMemo(() => (source.kind === 'script' ? [source.filename] : source.py), [source]);
  const pyKey = py.join('\n');

  const refresh = useCallback(async () => {
    const [c, list] = await Promise.all([train.config(), train.jobs()]);
    setCfg(c);
    setJobs(list);
    return { c, list };
  }, []);

  const loadHpc = useCallback(async () => {
    try { const h = await train.hpc(); setHpc(h); return h; } catch { return null; }
  }, []);

  /** The saved record again (state, SLURM id, exit code), leaving the editor and form alone. */
  const reloadJob = useCallback(async (id: string) => {
    try {
      const j = await train.job(id);
      setJob((cur) => (cur?.id === j.id ? j : cur));
      setJobs(await train.jobs());
    } catch { /* it was deleted, or the console is unreachable */ }
  }, []);

  const open = useCallback(async (id: string) => {
    setBusy('load');
    try {
      const j = await train.job(id);
      setJob(j);
      setForm(formOf(j.spec));
      if (j.code.kind === 'py') {
        const text = await train.jobFile(j.id, j.code.filename);
        setSource({ kind: 'script', filename: j.code.filename, text, saved: true });
      } else {
        setSource({ kind: 'zip', filename: j.code.filename, py: j.code.py, uploadId: null });
      }
      setDirty(false);
      setProgress(0);
      setLogText(null);
      setTab('code');
      history.replaceState(null, '', `/train?job=${j.id}`);
      say(`$ open ${j.spec.name} (${j.id.slice(0, 8)})`, 'cmd');
    } catch (e) {
      say(`! ${(e as Error).message}`, 'err');
    } finally {
      setBusy('');
    }
  }, [say]);

  useEffect(() => {
    let gone = false;
    refresh().then(async ({ c, list }) => {
      if (gone) return;
      setForm((f) => f ?? defaultForm(c, source.kind === 'script' ? source.filename : ''));
      if (c.hpc.available) say('[hku]    sending is on: you sign in as yourself when you send, refresh or cancel', 'info');
      else {
        say(`[hku]    sending is not ready: ${c.hpc.reason ?? ''}`, 'accent');
        say('[ok]     drafts, uploads and the exact job.sbatch preview work now', 'info');
      }
      if (!c.verified) say('[config] partitions and modules are placeholders until M0 reads them off the cluster', 'muted');
      say(`[jobs]   ${list.length} saved · ${mb(c.usage.bytes)} of ${c.limits.quotaMb} MB used`, 'muted');
      const want = new URLSearchParams(location.search).get('job');
      if (want && list.some((j) => j.id === want)) await open(want);
    }).catch((e: Error) => { if (!gone) setLoadError(e.message); });
    return () => { gone = true; };
    // Once, on arrival.
  }, []);

  useEffect(() => {
    void loadHpc();
    const t = setInterval(() => void loadHpc(), 20_000);
    return () => clearInterval(t);
  }, [loadHpc]);

  // A job on the cluster: the server polls SLURM while its owner is signed
  // in; this picks up what it found.
  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const t = setInterval(() => void reloadJob(job.id), 15_000);
    return () => clearInterval(t);
  }, [job?.id, job?.status, reloadJob]);

  useEffect(() => { keepScript(source); }, [source]);
  useEffect(() => { if (logEl.current) logEl.current.scrollTop = logEl.current.scrollHeight; }, [log]);

  // The live check: the server's own validator and renderer, a moment after typing stops.
  useEffect(() => {
    if (!cfg || !form) return;
    const { spec, local } = specOf(form);
    const seq = ++previewSeq.current;
    const t = setTimeout(() => {
      train.preview(spec, py).then((r) => {
        if (seq !== previewSeq.current) return;
        setPreview(r.ok ? { sbatch: r.sbatch, problems: local } : { sbatch: null, problems: [...local, ...r.problems] });
      }).catch(() => { /* keep the last answer; saving will say what is wrong */ });
    }, 250);
    return () => clearTimeout(t);
  }, [cfg, form, pyKey]);

  // A project is shown one file at a time: whichever is the entrypoint.
  useEffect(() => {
    if (source.kind !== 'zip' || !form?.entrypoint) return;
    let gone = false;
    const get = source.uploadId ? train.uploadFile(source.uploadId, form.entrypoint) : job ? train.jobFile(job.id, form.entrypoint) : null;
    get?.then((t) => { if (!gone) setViewText(t); }, (e: Error) => { if (!gone) setViewText(`# ${form.entrypoint}: ${e.message}`); });
    return () => { gone = true; };
  }, [source, form?.entrypoint, job]);

  const edit = (patch: Partial<Form>) => { setForm((f) => (f ? { ...f, ...patch } : f)); setDirty(true); };

  const confirmDiscard = () => !dirty || window.confirm('Discard the changes you have not saved?');

  const startNew = (force = false) => {
    if (!cfg || (!force && !confirmDiscard())) return;
    const s: Source = { kind: 'script', filename: 'train.py', text: DEFAULT_SCRIPT, saved: false };
    setJob(null);
    setSource(s);
    setForm(defaultForm(cfg, s.filename));
    setDirty(false);
    setProgress(0);
    setTab('code');
    history.replaceState(null, '', '/train');
    say('$ new draft', 'cmd');
  };

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !cfg) return;
    const name = file.name;
    if (name.endsWith('.py')) {
      if (!FILENAME.test(name)) { say(`! ${name}: name it with letters, digits, _ . - (not starting with . or -)`, 'err'); return; }
      if (file.size > cfg.limits.maxPyMb * 1048576) { say(`! ${name} is over ${cfg.limits.maxPyMb} MB`, 'err'); return; }
      const text = await file.text();
      setSource({ kind: 'script', filename: name, text, saved: false });
      edit({ entrypoint: name });
      setTab('code');
      say(`$ load ${name} · ${mb(file.size)} (uploaded when the draft is saved)`, 'cmd');
      return;
    }
    if (!name.endsWith('.zip')) { say(`! ${name}: upload a .py file or a .zip of your project`, 'err'); return; }
    if (file.size > cfg.limits.maxUploadMb * 1048576) { say(`! ${name} is over ${cfg.limits.maxUploadMb} MB`, 'err'); return; }
    setBusy('upload');
    setProgress(0);
    say(`$ upload ${name} · ${mb(file.size)}`, 'cmd');
    try {
      const up = await train.upload(name, file, setProgress);
      setSource({ kind: 'zip', filename: up.filename, py: up.py, uploadId: up.id });
      edit({ entrypoint: pickEntrypoint(up.py) });
      setTab('code');
      say(`[upload] ${up.fileCount} files · ${up.py.length} .py · unpacked ${mb(up.unpackedBytes)} · sha256 ${up.sha256.slice(0, 12)}`, 'info');
    } catch (err) {
      setProgress(0);
      say(`! ${(err as Error).message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const save = async (): Promise<Job | null> => {
    if (!cfg || !form || busy) return null;
    const { spec, local } = specOf(form);
    say(`$ save draft ${String(spec.name) || '(unnamed)'}`, 'cmd');
    if (local.length > 0) { for (const p of local) say(`! ${LABELS[p.field] ?? p.field}: ${p.message}`, 'err'); return null; }
    setBusy('save');
    try {
      let uploadId: string | undefined;
      if (source.kind === 'script' && !source.saved) {
        setProgress(0);
        const up = await train.upload(source.filename, new Blob([source.text], { type: 'application/octet-stream' }), setProgress);
        uploadId = up.id;
        say(`[upload] ${source.filename} · ${mb(up.bytes)} · sha256 ${up.sha256.slice(0, 12)}`, 'info');
      } else if (source.kind === 'zip' && source.uploadId) {
        uploadId = source.uploadId;
      }
      let saved: Job;
      if (job && EDITABLE.has(job.status)) saved = await train.update(job.id, spec, uploadId);
      else if (uploadId) saved = await train.create(uploadId, spec);
      // A job that was sent is a record: its unchanged code starts a new draft.
      else if (job) saved = await train.copy(job.id, spec);
      else throw new TrainError('write or upload the code first');
      setJob(saved);
      setSource(source.kind === 'script'
        ? { ...source, saved: true }
        : { kind: 'zip', filename: saved.code.filename, py: saved.code.py, uploadId: null });
      setDirty(false);
      setProgress(1);
      history.replaceState(null, '', `/train?job=${saved.id}`);
      say('[check]  spec ok · job.sbatch rendered', 'info');
      say(`[draft]  ${saved.spec.name} saved as ${saved.id.slice(0, 8)}`, 'accent');
      flash(`Draft ${saved.spec.name} saved`);
      await refresh();
      return saved;
    } catch (e) {
      const err = e as TrainError;
      say(`! ${err.message}`, 'err');
      for (const p of err.problems ?? []) say(`!   ${LABELS[p.field] ?? p.field}: ${p.message}`, 'err');
      if (err.problems?.length) setPreview((p) => ({ ...p, problems: err.problems }));
      return null;
    } finally {
      setBusy('');
    }
  };

  /**
   * Starts an HKU action and follows it. A 428 means "sign in first": the
   * sign-in form opens, and it calls this again with sealed credentials.
   */
  const runOp = async (action: SignInAction, id: string | null, name: string | null, body?: unknown, then?: 'log' | 'shell'): Promise<OpEvent | null> => {
    setActing(action);
    try {
      const r = action === 'connect' ? await train.connect(body) : await train.act(id!, action, body);
      if ('already' in r && r.already) return { type: 'done', data: {} };
      if (r.status === 428) { setSignIn({ action, jobId: id, jobName: name, then }); return null; }
      if (r.status !== 202 || !r.opId) { say(`! ${r.error ?? `HTTP ${r.status}`}`, 'err'); return null; }
      const opId = r.opId;
      if (action === 'submit') setProgress(0.02);
      return await train.follow(opId, (e) => {
        if (e.type === 'host_key') {
          setHostKeyAsk({ opId, host: String(e.data.host), keys: (e.data.keys as { type: string; fingerprint: string }[]) ?? [] });
        }
        const step = STEPS[e.type];
        if (!step) return;
        say(step.say(e.data), step.tone);
        if (step.at !== undefined && action === 'submit') setProgress(step.at);
        if (e.type === 'error' && action === 'submit') setProgress(0);
      });
    } finally {
      setActing(null);
      setHostKeyAsk(null);
      await Promise.all([loadHpc(), id ? reloadJob(id) : Promise.resolve()]);
    }
  };

  /** The CONSOLE's ssh mode: a shell now if signed in, or the sign-in first. */
  const openShell = async () => {
    setConsoleMode('ssh');
    if (hpc?.session.state === 'up') { setTermKey((k) => k + 1); return; }
    say(`$ ssh ${target}`, 'cmd');
    const last = await runOp('connect', null, null, undefined, 'shell');
    if (last?.type === 'done') setTermKey((k) => k + 1);
  };

  const send = async () => {
    if (!cfg || !form || busy || acting) return;
    let target = job;
    const unsaved = dirty || (source.kind === 'script' && !source.saved) || (source.kind === 'zip' && source.uploadId !== null);
    if (!target || unsaved || !EDITABLE.has(target.status)) {
      target = await save();
      if (!target) return;
    }
    say(`$ send ${target.spec.name} to ${hpc?.ssh ? `${hpc.ssh.user ?? hpc.session.uid ?? ''}@${hpc.ssh.host}` : 'the cluster'}`, 'cmd');
    await runOp('submit', target.id, target.spec.name);
  };

  const showLog = async (stream: 'out' | 'err' = 'out') => {
    if (!job?.slurmJobId) return;
    const r = await train.log(job.id, stream);
    if (r.status === 428) { setSignIn({ action: 'refresh', jobId: job.id, jobName: job.spec.name, then: 'log' }); return; }
    if (r.text === undefined) { say(`! ${r.error ?? `HTTP ${r.status}`}`, 'err'); return; }
    say(`$ tail slurm-${job.slurmJobId}.${stream}`, 'cmd');
    setLogText(r.text || `# slurm-${job.slurmJobId}.${stream} is empty so far\n`);
    setTab('log');
  };

  const signOutHku = async () => {
    await train.endSession().catch(() => undefined);
    say('$ hku sign-out · tunnel and SSH session closed', 'cmd');
    await loadHpc();
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const remove = async (j: JobSummary) => {
    if (!window.confirm(`Delete the draft ${j.name}? Its code is deleted with it.`)) return;
    try {
      await train.remove(j.id);
      say(`$ delete ${j.name} (${j.id.slice(0, 8)})`, 'cmd');
      if (job?.id === j.id) startNew(true);
      await refresh();
    } catch (e) {
      say(`! ${(e as Error).message}`, 'err');
    }
  };

  if (loadError) {
    return (
      <main className="cx-train">
        <Head status="—" hpc={null} />
        <section className="card elev-sm cx-card"><div className="cx-error">! module 02 could not load: {loadError}</div></section>
      </main>
    );
  }
  if (!cfg || !form) return <main className="cx-train"><Head status="…" hpc={null} /></main>;

  const status = job?.status ?? 'NEW';
  const partition = cfg.partitions.find((p) => p.name === form.partition);
  const bad = new Set(preview.problems.map((p) => p.field));
  const editorText = source.kind === 'script' ? source.text : viewText;
  const lines = editorText.split('\n').length - (editorText.endsWith('\n') ? 1 : 0);
  const shownFile = source.kind === 'script' ? source.filename : `${source.filename} › ${form.entrypoint}`;
  const srun = preview.sbatch?.split('\n').find((l) => l.startsWith('srun '));
  const filled = Math.round(progress * 20);
  const ready = hpc?.available ?? cfg.hpc.available;
  const target = hpc?.ssh ? `${hpc.ssh.user ?? hpc.profile?.hkuUid ?? 'you'}@${hpc.ssh.host}` : 'the cluster';
  const signedIn = hpc?.session.state === 'up';
  const canSend = ready && !busy && !acting;
  const sent = !!job && !EDITABLE.has(job.status);
  const elapsed = job?.elapsedSeconds ?? (job?.startedAt ? Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000) : null);
  const session = hpc?.session.state === 'up' ? hpc.session : null;

  return (
    <main className="cx-train">
      <Head status={status} hpc={hpc} />

      <div className="cx-train-cols">
        {/* left: editor + console */}
        <section className="cx-train-left">
          <div className="card elev-sm cx-panel">
            <div className="cx-bar">
              <span className="cx-file" title={`${shownFile}${source.kind === 'zip' ? ' (a file of an uploaded project: read-only)' : ''}`}>
                <FilePy /><span className="cx-file-name">{shownFile}</span>
                <span className="cx-dim">· {lines} lines{source.kind === 'zip' ? ' · read-only' : ''}{dirty || (source.kind === 'script' && !source.saved && job) ? ' · unsaved' : ''}</span>
              </span>
              <div className="seg cx-tabs" role="tablist" aria-label="Show">
                <label className="seg-opt"><input type="radio" name="tab" checked={tab === 'code'} onChange={() => setTab('code')} />code</label>
                <label className="seg-opt"><input type="radio" name="tab" checked={tab === 'sbatch'} onChange={() => setTab('sbatch')} />job.sbatch</label>
                {logText !== null && <label className="seg-opt"><input type="radio" name="tab" checked={tab === 'log'} onChange={() => setTab('log')} />log</label>}
              </div>
              <input ref={fileInput} type="file" accept=".py,.zip" hidden onChange={pickFile} />
              <button className="btn btn-secondary cx-btn-px" onClick={() => fileInput.current?.click()} disabled={!!busy}
                title={`a .py (≤ ${cfg.limits.maxPyMb} MB) or a .zip of your project (≤ ${cfg.limits.maxUploadMb} MB)`}>
                <UploadSimple />Upload
              </button>
              <button className="btn btn-secondary cx-btn-px" onClick={() => void save()} disabled={!!busy || !!acting}
                title={sent ? 'This job was sent: saving starts a new draft' : 'Save draft (Ctrl/⌘ S)'}>
                <FloppyDisk />{busy === 'save' ? 'Saving…' : sent ? 'Save as new' : 'Save draft'}
              </button>
              <button className="btn btn-primary cx-btn-px" disabled={!canSend} aria-describedby="cx-hpc-why" onClick={() => void send()}
                title={ready ? 'Save if needed, sign in as yourself, and send to the cluster' : hpc?.reason ?? cfg.hpc.reason ?? undefined}>
                <PaperPlaneRight />{acting === 'submit' ? 'Sending…' : 'Send job to train'}
              </button>
            </div>
            <div className="cx-editor">
              <div hidden={tab !== 'code'} className="cx-editor-pane">
                <CodeEditor
                  value={editorText} language="python" readOnly={source.kind === 'zip'} label="Python training script"
                  onChange={(text) => {
                    if (source.kind !== 'script') return;
                    setSource({ ...source, text, saved: false });
                    setDirty(true);
                  }}
                />
              </div>
              <div hidden={tab !== 'sbatch'} className="cx-editor-pane">
                <CodeEditor value={(sent ? job?.sbatch : preview.sbatch) ?? '# job.sbatch appears here once the job spec is valid\n'} language="text" readOnly label="Rendered job.sbatch" />
              </div>
              {logText !== null && (
                <div hidden={tab !== 'log'} className="cx-editor-pane">
                  <CodeEditor value={logText} language="text" readOnly label="Job output" />
                </div>
              )}
            </div>
          </div>

          <div className={`card elev-sm cx-panel cx-console ${consoleMode === 'ssh' ? 'is-ssh' : ''}`}>
            <div className="cx-bar">
              <span className="cx-label">Console</span>
              <div className="seg cx-tabs" role="tablist" aria-label="Console">
                <label className="seg-opt"><input type="radio" name="console" checked={consoleMode === 'log'} onChange={() => setConsoleMode('log')} />log</label>
                <label className="seg-opt" title={`A shell on ${target}, through your own HKU session`}>
                  <input type="radio" name="console" checked={consoleMode === 'ssh'} onChange={() => void openShell()} />ssh {target}
                </label>
              </div>
              <span style={{ marginLeft: 'auto' }} />
              {consoleMode === 'log' && <>
                <div className="cx-progress" aria-hidden="true">
                  {Array.from({ length: 20 }, (_, i) => <span key={i} className={i < filled ? 'on' : ''} />)}
                </div>
                <span className="cx-pct">{Math.round(progress * 100)}%</span>
              </>}
              {consoleMode === 'ssh' && signedIn && termKey > 0 && (
                <button className="btn btn-ghost cx-btn-px" onClick={() => setTermKey((k) => k + 1)} title="Close this shell and open a new one">New shell</button>
              )}
            </div>
            <div className="cx-log" ref={logEl} role="log" aria-live="polite" hidden={consoleMode !== 'log'}>
              {log.map((l, i) => <div key={i} className={`l-${l.tone}`}>{l.t}</div>)}
              <span className="cx-accent cx-blink">█</span>
            </div>
            {consoleMode === 'log' && <div className="cx-log-hint">read-only log · switch to <b>ssh</b> to type commands on {target}</div>}
            {consoleMode === 'ssh' && (signedIn && termKey > 0
              ? <ClusterTerminal key={termKey} target={target} ticket={() => train.termTicket()}
                  onClosed={(why) => { say(`[ssh]    shell closed: ${why}`, 'muted'); void loadHpc(); }} />
              : (
                <div className="cx-term-gate">
                  <div className="cx-kicker" style={{ margin: 0 }}>SSH {target}</div>
                  <p>{!ready ? (hpc?.reason ?? cfg.hpc.reason) : signedIn
                    ? 'You are signed in to HKU. Open a shell on the cluster as your session.'
                    : 'A shell on the cluster, through your own HKUVPN login. Sign in with your UID, Portal PIN, a fresh code and the cluster password.'}</p>
                  <button className="btn btn-primary cx-btn-px" disabled={!ready || !!acting} onClick={() => void openShell()}>
                    {acting === 'connect' ? 'Signing in…' : signedIn ? 'Open shell' : 'Sign in and open shell'}
                  </button>
                </div>
              ))}
          </div>
          {!ready && <p id="cx-hpc-why" className="cx-hint cx-why">{hpc?.reason ?? cfg.hpc.reason}</p>}
        </section>

        {/* right: the job + its spec */}
        <section className="cx-train-right">
          <div className="card elev-sm cx-card">
            <div className="cx-card-head">
              <span className="cx-label">Job</span>
              <span className="cx-head-right">
                <span className="cx-hint">{job ? `${job.spec.name} · ${job.id.slice(0, 8)}` : 'new draft · not saved'}</span>
                <button className="btn btn-ghost cx-icon" onClick={() => startNew()} title="New draft" aria-label="New draft"><Plus /></button>
              </span>
            </div>
            <div className="cx-metrics">
              <Metric label="State" value={status} accent />
              <Metric label="SLURM id" value={job?.slurmJobId != null ? String(job.slurmJobId) : '—'} />
              <Metric label="Elapsed" value={duration(elapsed)} />
              <Metric label="Exit" value={job?.exitCode != null ? String(job.exitCode) : '—'} />
            </div>
            {job?.message && <div className="cx-hint is-err">! {job.message}</div>}
            {job?.slurmReason && <div className="cx-hint">SLURM reason: {job.slurmReason}</div>}
            {job?.slurmJobId != null && (
              <div className="cx-hint">
                {job.lastPolledAt ? `Last checked ${ago(job.lastPolledAt)}` : 'Waiting for the first cluster status check'}
                {!signedIn && ' · Sign in and refresh for the current state'}
              </div>
            )}
            <div className="cx-hint">
              {job?.slurmState && job.slurmState !== job.status ? `${job.slurmState} · ` : ''}
              {job?.node ? `${job.node} · ` : ''}
              {form.cpus} cpu · {form.mem} GB · {form.gpus} gpu · {form.time} on {form.partition}
            </div>
            {job?.slurmJobId != null && (
              <div className="cx-job-actions">
                <button className="btn btn-secondary cx-btn-px" disabled={!!acting} onClick={() => void runOp('refresh', job.id, job.spec.name)}>
                  {acting === 'refresh' ? 'Refreshing…' : 'Refresh'}
                </button>
                <button className="btn btn-secondary cx-btn-px" disabled={!!acting} onClick={() => void showLog('out')}>Log</button>
                <button className="btn btn-secondary cx-btn-px" disabled={!!acting} onClick={() => void showLog('err')}>Stderr</button>
                {ACTIVE.has(job.status) && (
                  <button className="btn btn-ghost cx-btn-px cx-danger" disabled={!!acting}
                    onClick={() => { if (window.confirm(`Cancel ${job.spec.name} (SLURM ${job.slurmJobId}) on the cluster?`)) void runOp('cancel', job.id, job.spec.name); }}>
                    {acting === 'cancel' ? 'Cancelling…' : 'Cancel job'}
                  </button>
                )}
              </div>
            )}
            {session && (
              <div className="cx-session">
                <span className="cx-online" />
                <span>signed in to HKU as <b>{session.uid}</b> · {Math.max(1, Math.round((session.expiresInSeconds ?? 0) / 60))} min left</span>
                <button className="btn btn-ghost cx-btn-px" onClick={() => void signOutHku()}>Sign out of HKU</button>
              </div>
            )}
            <div className="cx-table-scroll" tabIndex={0} role="region" aria-label="Training jobs">
            <table className="table cx-jobs">
              <thead><tr><th style={{ width: 24 }} /><th>Job</th><th>Partition</th><th>State</th><th style={{ textAlign: 'right' }}>Saved</th><th style={{ width: 28 }} /></tr></thead>
              <tbody>
                {jobs.length === 0 && <tr><td /><td colSpan={5} className="cx-dim">no jobs yet — save a draft</td></tr>}
                {jobs.map((j) => {
                  const on = j.id === job?.id;
                  return (
                    <tr key={j.id} className={on ? 'is-on' : ''} onClick={() => { if (!on && confirmDiscard()) void open(j.id); }}>
                      <td><span className="cx-sel" /></td>
                      <td className="cx-mono cx-job-name">{j.name}</td>
                      <td className="cx-mono cx-dim2">{j.partition}{j.gpus > 0 ? ` ·${j.gpus}g` : ''}</td>
                      <td><span className={`tag ${tagClass(j.status)} cx-tag-px`}>{j.status}</span></td>
                      <td className="cx-mono cx-dim2" style={{ textAlign: 'right' }}>{ago(j.updatedAt)}</td>
                      <td>
                        {EDITABLE.has(j.status) && (
                          <button className="btn btn-ghost cx-icon" aria-label={`Delete ${j.name}`} title="Delete draft"
                            onClick={(e) => { e.stopPropagation(); void remove(j); }}><XMark /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <div className="cx-hint">{mb(cfg.usage.bytes)} of {cfg.limits.quotaMb} MB · {cfg.usage.jobs} of {cfg.limits.maxJobs} jobs</div>
          </div>

          <div className="card elev-sm cx-card">
            <div className="cx-card-head">
              <span className="cx-label">Job spec</span>
              {!cfg.verified && <span className="tag tag-accent cx-mono" title={cfg.source}>placeholders · M0</span>}
            </div>
            <div className="cx-fields">
              <Field label="Job name" id="f-name" bad={bad.has('name')}>
                <input id="f-name" className={`input ${bad.has('name') ? 'is-bad' : ''}`} value={form.name} maxLength={40}
                  spellCheck={false} onChange={(e) => edit({ name: e.target.value })} placeholder="occupancy_gbc" />
              </Field>
              <Field label="Entrypoint" id="f-entry" bad={bad.has('entrypoint')}>
                {source.kind === 'script'
                  ? <div id="f-entry" className="input cx-static">{source.filename}</div>
                  : (
                    <select id="f-entry" className={`input ${bad.has('entrypoint') ? 'is-bad' : ''}`} value={form.entrypoint}
                      onChange={(e) => edit({ entrypoint: e.target.value })}>
                      {source.py.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  )}
              </Field>
            </div>
            <div className="field">
              <label id="f-part">Partition</label>
              <div className="cx-seg-row">
                <div className="seg" role="radiogroup" aria-labelledby="f-part">
                  {cfg.partitions.map((p) => (
                    <label key={p.name} className="seg-opt">
                      <input type="radio" name="partition" checked={form.partition === p.name}
                        onChange={() => edit({ partition: p.name, gpus: p.gpu ? (form.gpus === '0' ? '1' : form.gpus) : '0' })} />
                      {p.name}{p.gpu && !/gpu/i.test(p.name) ? ' · gpu' : ''}
                    </label>
                  ))}
                </div>
                {partition && <span className="cx-hint">max {partition.maxTime}{partition.gpu ? ` · ≤ ${partition.maxGpus} gpu` : ''}</span>}
              </div>
            </div>
            <div className="cx-fields cx-fields-4">
              <Field label="CPUs" id="f-cpu" bad={bad.has('cpusPerTask')}>
                <input id="f-cpu" className={`input ${bad.has('cpusPerTask') ? 'is-bad' : ''}`} inputMode="numeric" value={form.cpus} onChange={(e) => edit({ cpus: e.target.value })} />
              </Field>
              <Field label="Mem GB" id="f-mem" bad={bad.has('memGb')}>
                <input id="f-mem" className={`input ${bad.has('memGb') ? 'is-bad' : ''}`} inputMode="numeric" value={form.mem} onChange={(e) => edit({ mem: e.target.value })} />
              </Field>
              <Field label="GPUs" id="f-gpu" bad={bad.has('gpus')}>
                <input id="f-gpu" className={`input ${bad.has('gpus') ? 'is-bad' : ''}`} inputMode="numeric" value={form.gpus}
                  disabled={!partition?.gpu} onChange={(e) => edit({ gpus: e.target.value })} />
              </Field>
              <Field label="Time" id="f-time" bad={bad.has('timeLimit')}>
                <input id="f-time" className={`input ${bad.has('timeLimit') ? 'is-bad' : ''}`} value={form.time} placeholder="H:MM:SS"
                  spellCheck={false} onChange={(e) => edit({ time: e.target.value })} />
              </Field>
            </div>
            {cfg.modules.length > 0 && <div className="field">
              <label id="f-mods">Modules</label>
              <div className="cx-chips" role="group" aria-labelledby="f-mods">
                {cfg.modules.map((m) => (
                  <label key={m} className="seg-opt cx-chip">
                    <input type="checkbox" checked={form.modules.includes(m)}
                      onChange={(e) => edit({ modules: e.target.checked ? [...form.modules, m] : form.modules.filter((x) => x !== m) })} />
                    {m}
                  </label>
                ))}
              </div>
            </div>}
            <div className="cx-fields">
              <Field label="Conda env" id="f-conda" bad={bad.has('condaEnv')}>
                <input id="f-conda" className={`input ${bad.has('condaEnv') ? 'is-bad' : ''}`} value={form.conda} placeholder="(none)"
                  spellCheck={false} onChange={(e) => edit({ conda: e.target.value })} />
              </Field>
            </div>
            <Field label="Arguments" id="f-args" bad={bad.has('args')} hint="split on spaces · each reaches python exactly as typed: no ~ or $VAR expansion">
              <input id="f-args" className={`input ${bad.has('args') ? 'is-bad' : ''}`} value={form.args} placeholder="--epochs 10"
                spellCheck={false} onChange={(e) => edit({ args: e.target.value })} />
            </Field>
            <Field label="Environment" id="f-env" bad={bad.has('env')} hint="one NAME=value per line">
              <textarea id="f-env" className={`input cx-textarea ${bad.has('env') ? 'is-bad' : ''}`} rows={3} value={form.env}
                placeholder="OMP_NUM_THREADS=4" spellCheck={false} onChange={(e) => edit({ env: e.target.value })} />
            </Field>
            <label className="cx-check" title="Needs M0 to show the cluster delivers SLURM mail">
              <input type="checkbox" checked={false} disabled readOnly /> Email me when it ends
              <span className="cx-hint">waits on M0</span>
            </label>
            <div className={`cx-hint ${preview.problems.length ? 'is-err' : 'is-ok'}`} role="status">
              {preview.problems.length
                ? preview.problems.map((p, i) => <div key={i}>! {LABELS[p.field] ?? p.field}: {p.message}</div>)
                : srun ? `→ ${srun}` : '…'}
            </div>
          </div>
        </section>
      </div>
      <Toast text={toast} />
      {signIn && hpc && (
        <SignIn hpc={hpc} action={signIn.action} jobId={signIn.jobId} jobName={signIn.jobName}
          onCancel={() => { setSignIn(null); say('[hku]    sign-in cancelled · nothing was sent', 'muted'); }}
          onSealed={(body) => {
            const s = signIn;
            setSignIn(null);
            void runOp(s.action, s.jobId, s.jobName, body).then((last) => {
              if (last?.type !== 'done') return;
              if (s.then === 'log') void showLog();
              if (s.then === 'shell') { setConsoleMode('ssh'); setTermKey((k) => k + 1); }
            });
          }} />
      )}
      {hostKeyAsk && (
        <HostKeyPrompt host={hostKeyAsk.host} keys={hostKeyAsk.keys} onAnswer={(accept) => {
          const ask = hostKeyAsk;
          setHostKeyAsk(null);
          say(accept ? `[ssh]    host key trusted and pinned for ${ask.host}` : '[ssh]    host key not trusted · nothing pinned, nobody logged in', accept ? 'info' : 'accent');
          void train.answerHostKey(ask.opId, accept).catch(() => undefined);
        }} />
      )}
    </main>
  );
}

function Head({ status, hpc }: { status: string; hpc: HpcState | null }) {
  const up = hpc?.session.state === 'up';
  const label = !hpc ? null : !hpc.available ? 'Not ready' : up ? `Signed in · ${Math.max(1, Math.round((hpc.session.expiresInSeconds ?? 0) / 60))} min`
    : hpc.session.state === 'opening' ? 'Signing in…' : 'Signed out';
  return (
    <header className="cx-train-head">
      <div>
        <div className="cx-kicker">Module 02 · Training</div>
        <h2 className="cx-h2">ML training</h2>
      </div>
      <div className="cx-job">
        {hpc && <>
          <span>hku</span>
          <span className={`tag ${up ? 'tag-accent' : 'tag-neutral'} cx-tag-px`} title={hpc.reason ?? (up ? `signed in as ${hpc.session.uid ?? ''}` : 'you sign in when you send')}>
            {label}
          </span>
        </>}
        <span>job</span><span className={`tag ${tagClass(status)} cx-tag-px`}>{status}</span>
      </div>
    </header>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="cx-metric">
      <span>{label}</span>
      <span className={accent ? 'cx-accent' : ''}>{value}</span>
    </div>
  );
}

function Field({ label, id, bad, hint, children }: { label: string; id: string; bad: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className={`field ${bad ? 'is-bad' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <div className="cx-hint cx-field-hint">{hint}</div>}
    </div>
  );
}
