/**
 * ML Training, module 02: write or upload a training script, say what it
 * needs from HKU HPC2021, and keep it as a draft whose job.sbatch is exactly
 * what would be submitted (docs/hpc/HANDOVER.md, milestone M1).
 *
 * Sending a job to HPC2021 is not here yet, and the screen says so instead
 * of pretending: the handover makes the M0 feasibility spike a hard gate
 * before anything touches HKU's VPN or login nodes, and a console that
 * showed invented job states would be believed. The send button is drawn,
 * disabled, where the design puts it, and the reason is on screen.
 *
 * The design's results and export cards become the job's state and its
 * spec: there are no accuracies to show until jobs run, and this module
 * does not make any up.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { FilePy, FloppyDisk, PaperPlaneRight, Plus, UploadSimple, XMark } from './icons.tsx';
import { Toast, useToast } from './parts.tsx';
import { CodeEditor } from './train/CodeEditor.tsx';
import { train, TrainError, type Job, type JobSpec, type JobSummary, type Problem, type TrainConfig } from './train/api.ts';

const DEFAULT_SCRIPT = `# algo.hkumyseat.com — training job for HKU HPC2021 (SLURM)
# Runs on a compute node as: srun python train.py <arguments>
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
  const [tab, setTab] = useState<'code' | 'sbatch'>('code');
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
      if (c.hpc.available) say('[hpc]    HPC2021 submission is on', 'info');
      else {
        say('[hpc]    submission to HPC2021 is not switched on yet: it waits on the M0 feasibility gate', 'accent');
        say('[ok]     drafts, uploads and the exact job.sbatch preview work now', 'info');
      }
      if (!c.verified) say('[config] partitions and modules are placeholders until M0 reads them off HPC2021', 'muted');
      say(`[jobs]   ${list.length} saved · ${mb(c.usage.bytes)} of ${c.limits.quotaMb} MB used`, 'muted');
      const want = new URLSearchParams(location.search).get('job');
      if (want && list.some((j) => j.id === want)) await open(want);
    }).catch((e: Error) => { if (!gone) setLoadError(e.message); });
    return () => { gone = true; };
    // Once, on arrival.
  }, []);

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

  const save = async () => {
    if (!cfg || !form || busy) return;
    const { spec, local } = specOf(form);
    say(`$ save draft ${String(spec.name) || '(unnamed)'}`, 'cmd');
    if (local.length > 0) { for (const p of local) say(`! ${LABELS[p.field] ?? p.field}: ${p.message}`, 'err'); return; }
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
      if (!cfg.hpc.available) say('[hpc]    not sent: HPC2021 submission waits on M0', 'muted');
      flash(`Draft ${saved.spec.name} saved`);
      await refresh();
    } catch (e) {
      const err = e as TrainError;
      say(`! ${err.message}`, 'err');
      for (const p of err.problems ?? []) say(`!   ${LABELS[p.field] ?? p.field}: ${p.message}`, 'err');
      if (err.problems?.length) setPreview((p) => ({ ...p, problems: err.problems }));
    } finally {
      setBusy('');
    }
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
  const canSend = cfg.hpc.available && !busy;
  const elapsed = job?.startedAt ? Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000) : null;

  return (
    <main className="cx-train">
      <Head status={status} hpc={cfg.hpc} />

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
              </div>
              <input ref={fileInput} type="file" accept=".py,.zip" hidden onChange={pickFile} />
              <button className="btn btn-secondary cx-btn-px" onClick={() => fileInput.current?.click()} disabled={!!busy}
                title={`a .py (≤ ${cfg.limits.maxPyMb} MB) or a .zip of your project (≤ ${cfg.limits.maxUploadMb} MB)`}>
                <UploadSimple />UPLOAD
              </button>
              <button className="btn btn-secondary cx-btn-px" onClick={() => void save()} disabled={!!busy} title="Save draft (Ctrl/⌘ S)">
                <FloppyDisk />{busy === 'save' ? 'SAVING…' : 'SAVE DRAFT'}
              </button>
              <button className="btn btn-primary cx-btn-px" disabled={!canSend} aria-describedby="cx-hpc-why"
                title={cfg.hpc.available ? 'Send to HPC2021' : cfg.hpc.reason ?? undefined}>
                <PaperPlaneRight />SEND JOB TO TRAIN
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
                <CodeEditor value={preview.sbatch ?? '# job.sbatch appears here once the job spec is valid\n'} language="text" readOnly label="Rendered job.sbatch" />
              </div>
            </div>
          </div>

          <div className="card elev-sm cx-panel">
            <div className="cx-bar">
              <span className="cx-label" style={{ marginRight: 'auto' }}>CONSOLE</span>
              <div className="cx-progress" aria-hidden="true">
                {Array.from({ length: 20 }, (_, i) => <span key={i} className={i < filled ? 'on' : ''} />)}
              </div>
              <span className="cx-pct">{Math.round(progress * 100)}%</span>
            </div>
            <div className="cx-log" ref={logEl} role="log" aria-live="polite">
              {log.map((l, i) => <div key={i} className={`l-${l.tone}`}>{l.t}</div>)}
              <span className="cx-accent cx-blink">█</span>
            </div>
          </div>
          {!cfg.hpc.available && <p id="cx-hpc-why" className="cx-hint cx-why">{cfg.hpc.reason}</p>}
        </section>

        {/* right: the job + its spec */}
        <section className="cx-train-right">
          <div className="card elev-sm cx-card">
            <div className="cx-card-head">
              <span className="cx-label">JOB</span>
              <span className="cx-head-right">
                <span className="cx-hint">{job ? `${job.spec.name} · ${job.id.slice(0, 8)}` : 'new draft · not saved'}</span>
                <button className="btn btn-ghost cx-icon" onClick={() => startNew()} title="New draft" aria-label="New draft"><Plus /></button>
              </span>
            </div>
            <div className="cx-metrics">
              <Metric label="State" value={status} accent />
              <Metric label="SLURM id" value={job?.slurmJobId != null ? String(job.slurmJobId) : '—'} />
              <Metric label="Elapsed" value={elapsed === null ? '—' : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`} />
              <Metric label="Exit" value={job?.exitCode != null ? String(job.exitCode) : '—'} />
            </div>
            <div className="cx-hint">
              {form.cpus} cpu · {form.mem} GB · {form.gpus} gpu · {form.time} on {form.partition}
            </div>
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
            <div className="cx-hint">{mb(cfg.usage.bytes)} of {cfg.limits.quotaMb} MB · {cfg.usage.jobs} of {cfg.limits.maxJobs} jobs</div>
          </div>

          <div className="card elev-sm cx-card">
            <div className="cx-card-head">
              <span className="cx-label">JOB SPEC</span>
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
            <div className="field">
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
            </div>
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
            <label className="cx-check" title="Needs M0 to show HPC2021 delivers SLURM mail, and your HKU UID">
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
    </main>
  );
}

function Head({ status, hpc }: { status: string; hpc: TrainConfig['hpc'] | null }) {
  return (
    <header className="cx-train-head">
      <div>
        <div className="cx-kicker">&gt; MODULE 02</div>
        <h2 className="cx-h2">ML Training</h2>
      </div>
      <div className="cx-job">
        {hpc && <>
          <span>hpc2021</span>
          <span className={`tag ${hpc.available ? 'tag-accent' : 'tag-neutral'} cx-tag-px`} title={hpc.reason ?? undefined}>
            {hpc.available ? 'CONNECTED' : 'NOT CONNECTED'}
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
