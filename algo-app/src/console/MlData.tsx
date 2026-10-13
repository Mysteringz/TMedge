import { useEffect, useRef, useState } from 'react';
import { permissionChanged, useCapability } from '../entities/admin-session/index.tsx';
import { TabList } from './motion.tsx';
import './ml-data.css';

type Tab = 'query' | 'schema' | 'export';
interface Column { name: string; type: string; nullable: boolean; primaryKey: boolean; references: string | null }
interface Table { name: string; kind: 'table' | 'view'; estimatedRows: number | null; bytes: number | null; columns: Column[] }
interface Schema { available: boolean; tables: Table[]; report: boolean; error: string | null }
interface Diagram { available: boolean; generatedAt: number | null; revision: string | null; error: string | null }
interface Result { columns: string[]; rows: unknown[][]; truncated: boolean; elapsedMs: number }
interface Job { id: string; state: 'queued' | 'processing' | 'completed' | 'failed'; tables: string[]; createdAt: number; expiresAt: number; bytes: number; sha256: string | null; error: string | null }
const INITIAL = 'SELECT id, sensor_uid, modality, reference_at\nFROM training.frames\nORDER BY reference_at DESC\nLIMIT 50;';
const SAMPLES = [
  { name: 'Latest frames', sql: INITIAL },
  { name: 'Paired samples', sql: 'SELECT sample_id, sensor_uid, sample_at\nFROM training.ml_samples\nORDER BY sample_at DESC\nLIMIT 50;' },
  { name: 'Latest labels', sql: 'SELECT * FROM training.annotations LIMIT 50;' },
];
async function request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/ml-data${path}`, { signal, ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tm-algo': '1' }, body: JSON.stringify(body),
  }) });
  permissionChanged(response.status);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || 'The request failed. Try again.');
  return value;
}
function size(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B','KiB','MiB','GiB'][unit]}`;
}
function text(value: unknown): string { return value === null ? 'NULL' : typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }

export function MlData() {
  const canExport = useCapability('training.write');
  const [tab, setTab] = useState<Tab>('query');
  const [schema, setSchema] = useState<Schema | null>(null);
  const [schemaError, setSchemaError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [tableName, setTableName] = useState('');
  const [sql, setSql] = useState(INITIAL);
  const [result, setResult] = useState<Result | null>(null);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [exportError, setExportError] = useState('');
  const [starting, setStarting] = useState(false);
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    const abort = new AbortController(); setSchemaError('');
    void request<Schema>('/schema', abort.signal).then(value => {
      setSchema(value);
      setSelected(old => old.length ? old.filter(name => value.tables.some(t => t.name === name && t.kind === 'table')) : value.tables.filter(t => t.kind === 'table').map(t => t.name));
      setTableName(old => value.tables.some(t => t.name === old) ? old : value.tables[0]?.name ?? '');
    }).catch(error => { if (!abort.signal.aborted) { setSchema(null); setSchemaError((error as Error).message); } });
    return () => abort.abort();
  }, [refresh]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await request<{ jobs: Job[] }>('/exports', abort.signal); if (!abort.signal.aborted) setJobs(value.jobs); }
      catch (error) { if (!abort.signal.aborted) setExportError((error as Error).message); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const tables = schema?.tables ?? [], exportTables = tables.filter(t => t.kind === 'table');
  const table = tables.find(t => t.name === tableName);
  const pending = jobs.some(j => j.state === 'queued' || j.state === 'processing');
  const run = async () => {
    setQuerying(true); setQueryError(''); setResult(null);
    try { setResult(await request<Result>('/query', undefined, { sql })); }
    catch (error) { setQueryError((error as Error).message); }
    finally { setQuerying(false); }
  };
  const generate = async () => {
    setStarting(true); setExportError('');
    try {
      const job = await request<Job>('/exports', undefined, { tables: selected });
      setJobs(old => [job, ...old.filter(j => j.id !== job.id)]);
    } catch (error) { setExportError((error as Error).message); }
    finally { setStarting(false); }
  };
  return <main className="cx-train cx-data">
    <div className="cx-data-heading">
      <div><div className="cx-kicker">Module 02 · ML</div><h1 className="cx-h2">ML database</h1>
        <p className="cx-data-lede">Explore the recordings behind the models. Query, understand the schema, and take a dataset with you.</p></div>
      <span className={`tag ${schema?.available ? 'cx-data-online' : 'tag-neutral'}`}>{schema?.available ? 'Database connected' : schema || schemaError ? 'Database unavailable' : 'Connecting…'}</span>
    </div>
    {(schemaError || schema?.error) && <div className="cx-data-notice" role="alert">{schemaError || schema?.error}<button className="btn btn-ghost" onClick={() => setRefresh(n => n + 1)}>Retry connection</button></div>}
    <div className="cx-data-layout"><div className="cx-data-workspace">
    <TabList className="cx-data-tabs" aria-label="ML data tools">
      {(['query','schema','export'] as const).map(t => <button key={t} id={`data-tab-${t}`} role="tab" aria-selected={tab === t} aria-controls={`data-panel-${t}`} onClick={() => setTab(t)}>
        {{ query: 'SQL console', schema: 'Database schema', export: 'Download data' }[t]}</button>)}
    </TabList>
    <section id={`data-panel-${tab}`} role="tabpanel" aria-labelledby={`data-tab-${tab}`}>
      {tab === 'query' && <div className="cx-data-query">
        <div className="cx-data-panel">
          <div className="cx-data-panel-head"><h2>Query console</h2><span className="cx-hint">Read-only · SELECT / WITH</span></div>
          <div className="cx-data-examples" aria-label="Example queries">{SAMPLES.map(example => <button className="btn btn-ghost" key={example.name} onClick={() => setSql(example.sql)}>{example.name}</button>)}</div>
          <label htmlFor="ml-sql" className="cx-hint">SQL query</label>
          <textarea id="ml-sql" className="input cx-data-sql" spellCheck={false} value={sql} onChange={e => setSql(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !querying && schema?.available) { e.preventDefault(); void run(); } }} />
          <div className="cx-data-query-actions"><span className="cx-hint">200 rows max · 10-second limit · Binary fields show byte counts</span>
            <button className="btn btn-primary" disabled={!schema?.available || querying || !sql.trim()} onClick={() => void run()}>{querying ? 'Running query…' : 'Run query'}</button></div>
          {queryError && <p className="cx-data-error" role="alert">{queryError}</p>}
        </div>
        <div className="cx-data-panel" aria-live="polite" aria-busy={querying}>
          <div className="cx-data-panel-head"><h2>Results</h2>{result && <span className="cx-hint">{result.rows.length} rows · {result.elapsedMs} ms{result.truncated ? ' · Result limited' : ''}</span>}</div>
          {!result ? <p className="cx-data-empty">Run a query to inspect your training data.</p> : result.rows.length === 0 ? <p className="cx-data-empty">The query returned no rows.</p>
            : <div className="cx-table-scroll" tabIndex={0} role="region" aria-label="SQL query results"><table className="cx-data-table"><thead><tr>{result.columns.map((name,i) => <th key={i} scope="col">{name}</th>)}</tr></thead>
              <tbody>{result.rows.map((row,i) => <tr key={i}>{row.map((value,j) => <td key={j} title={text(value)}><span className="cx-data-cell">{text(value)}</span></td>)}</tr>)}</tbody></table></div>}
          {result?.truncated && <p className="cx-hint">Showing a bounded preview. Add a WHERE clause or use Download data for complete tables.</p>}
        </div>
      </div>}
      {tab === 'schema' && <div className="cx-data-schema">
        <div className="cx-data-panel-head"><div><h2>SchemaSpy visualization</h2><p className="cx-hint">Relationships and documentation for the training database.</p></div>
          {schema?.report && <button className="btn btn-secondary" onClick={() => setShowReport(!showReport)}>{showReport ? 'Hide SchemaSpy report' : 'Open SchemaSpy report'}</button>}</div>
        {showReport && schema?.report && <SchemaSpyReport />}
        {!schema?.report && <p className="cx-data-notice">The SchemaSpy report has not been generated yet. Live table definitions are available below.</p>}
        <div className="cx-data-schema-grid">
          <div className="cx-data-panel"><label className="cx-hint" htmlFor="ml-table">Table or view</label>
            <select id="ml-table" className="input" value={tableName} onChange={e => setTableName(e.target.value)} disabled={!tables.length}>{tables.map(t => <option key={t.name} value={t.name}>{t.name} {t.kind === 'view' ? '(view)' : ''}</option>)}</select>
            {table && <dl className="cx-data-stats"><div><dt>Type</dt><dd>{table.kind}</dd></div><div><dt>Estimated rows</dt><dd>{table.estimatedRows?.toLocaleString() ?? '—'}</dd></div><div><dt>Disk size</dt><dd>{size(table.bytes)}</dd></div><div><dt>Columns</dt><dd>{table.columns.length}</dd></div></dl>}
            <p className="cx-hint">Row estimates come from PostgreSQL statistics. Views have no stored row count.</p></div>
          <div className="cx-data-panel"><h2>{table?.name ?? 'Table definitions'}</h2><div className="cx-table-scroll" tabIndex={0} role="region" aria-label="Database columns"><table className="cx-data-table">
            <thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th><th scope="col">References</th></tr></thead>
            <tbody>{table?.columns.map(c => <tr key={c.name}><td><code>{c.name}</code>{c.primaryKey && <span className="tag tag-neutral">PK</span>}</td><td><code>{c.type}</code></td><td>{c.nullable ? 'Yes' : 'No'}</td><td>{c.references ?? '—'}</td></tr>)}</tbody>
          </table></div></div>
        </div>
      </div>}
      {tab === 'export' && <div className="cx-data-export">
        <div className="cx-data-panel"><div className="cx-data-panel-head"><h2>Select tables</h2><button className="btn btn-ghost" onClick={() => setSelected(selected.length === exportTables.length ? [] : exportTables.map(t => t.name))}>{selected.length === exportTables.length ? 'Clear selection' : 'Select all'}</button></div>
          <p className="cx-hint">A ZIP containing dataset.sql and a manifest. Include related tables if you need a restorable dataset. Views are described in the schema browser.</p>
          <div className="cx-data-selectors">{exportTables.map(t => <label key={t.name}><input type="checkbox" checked={selected.includes(t.name)} onChange={e => setSelected(old => e.target.checked ? [...old,t.name] : old.filter(n => n !== t.name))} />
            <span><code>{t.name}</code><small>{t.estimatedRows === null ? 'Row count unavailable' : `~${t.estimatedRows.toLocaleString()} rows`} · {size(t.bytes)}</small></span></label>)}</div>
          {!canExport && <p className="cx-data-notice">Operator, Engineer or Admin access is required to generate an export.</p>}
          <div className="cx-data-query-actions"><span className="cx-hint">{selected.length} tables selected · ZIP files expire 24 hours after completion</span>
            <button className="btn btn-primary" disabled={!canExport || !schema?.available || !selected.length || starting || pending} onClick={() => void generate()}>{starting ? 'Starting export…' : pending ? 'Preparing dataset…' : 'Prepare ZIP'}</button></div>
          {exportError && <p className="cx-data-error" role="alert">{exportError}</p>}
        </div>
        <div className="cx-data-panel"><h2>Your exports</h2><p className="cx-hint">Preparation continues in the background. You can leave this page and return later.</p>
          {jobs.length === 0 ? <p className="cx-data-empty">No exports yet. Select your tables to prepare the first dataset.</p> : <div className="cx-data-jobs" aria-live="polite">{jobs.map(job => <article key={job.id} className="cx-data-job">
            <div className="cx-data-panel-head"><strong>{job.state === 'completed' ? 'Dataset ready' : job.state === 'failed' ? 'Export failed' : 'Preparing dataset…'}</strong><span className="tag tag-neutral">{job.state}</span></div>
            <p>{job.tables.join(', ')}</p><p className="cx-hint">{size(job.bytes)} · Started {new Date(job.createdAt).toLocaleString()}</p>
            {job.error && <p className="cx-data-error">{job.error}</p>}
            {job.state === 'completed' && <><a className="btn btn-primary" href={`/api/ml-data/exports/${encodeURIComponent(job.id)}/download`}>Download ZIP</a><p className="cx-hint">Expires {new Date(job.expiresAt).toLocaleString()}</p><details><summary>SHA-256 checksum</summary><code className="cx-data-hash">{job.sha256}</code></details></>}
          </article>)}</div>}
        </div>
        <DownloadKeysPanel />
      </div>}
    </section>
    </div><DatabaseDiagram /></div>
  </main>;
}

interface DownloadKey { id: string; label: string; createdAt: number; expiresAt: number }
const SAVE_KEY = "mkdir -p ~/thermalml && read -rs -p 'Download key: ' K && (umask 077; printf %s \"$K\" > ~/thermalml/download.key) && unset K && echo && echo saved";

/**
 * Keys for training jobs: a job on the cluster (module 02) uses one to fetch
 * your exports from this page, and nothing else. Shown once; revocable here.
 */
function DownloadKeysPanel() {
  const [keys, setKeys] = useState<DownloadKey[]>([]);
  const [available, setAvailable] = useState(true);
  const [label, setLabel] = useState('iw-g2 training');
  const [hours, setHours] = useState(24);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    try { const value = await request<{ available: boolean; keys: DownloadKey[] }>('/keys'); setAvailable(value.available); setKeys(value.keys); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    setBusy(true); setError(''); setMade(null);
    try { const value = await request<DownloadKey & { key: string }>('/keys', undefined, { label, hours }); setMade(value.key); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setError('');
    const response = await fetch(`/api/ml-data/keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-tm-algo': '1' } });
    permissionChanged(response.status);
    if (!response.ok) setError(((await response.json().catch(() => ({}))) as { error?: string }).error || 'The key could not be revoked.');
    await load();
  };
  if (!available) return null;
  return <div className="cx-data-panel"><div className="cx-data-panel-head"><h2>Download keys for training jobs</h2><span className="tag tag-neutral">read-only</span></div>
    <p className="cx-hint">A job on the training cluster uses a key to download <em>your</em> exports from this page — nothing else: no queries, no new exports, nobody else's data. It stops working when it expires, when you revoke it, or when your password changes.</p>
    <div className="cx-data-query-actions">
      <label className="cx-hint" htmlFor="ml-key-label">Label</label>
      <input id="ml-key-label" className="input" value={label} maxLength={60} onChange={e => setLabel(e.target.value)} />
      <select className="input" aria-label="Key lifetime" value={hours} onChange={e => setHours(Number(e.target.value))}>
        <option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select>
      <button className="btn btn-primary" disabled={busy || !label.trim()} onClick={() => void create()}>{busy ? 'Creating…' : 'Create key'}</button>
    </div>
    {made && <div className="cx-data-notice" role="status">
      <p><strong>Copy this key now — it will not be shown again.</strong></p>
      <code className="cx-data-hash">{made}</code>
      <button className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(made)}>Copy key</button>
      <p className="cx-hint">On the cluster (02 ML Training → ssh console), run this and paste the key when asked. It is not shown on screen or kept in the shell history:</p>
      <code className="cx-data-hash">{SAVE_KEY}</code>
      <button className="btn btn-ghost" onClick={() => setMade(null)}>Done</button>
    </div>}
    {error && <p className="cx-data-error" role="alert">{error}</p>}
    {keys.length === 0 ? <p className="cx-data-empty">No download keys.</p> : <div className="cx-data-jobs">{keys.map(k => <article key={k.id} className="cx-data-job">
      <div className="cx-data-panel-head"><strong>{k.label}</strong><button className="btn btn-ghost" onClick={() => void revoke(k.id)}>Revoke</button></div>
      <p className="cx-hint">Created {new Date(k.createdAt).toLocaleString()} · expires {new Date(k.expiresAt).toLocaleString()}</p>
    </article>)}</div>}
  </div>;
}

function DatabaseDiagram() {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [error, setError] = useState('');
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await request<Diagram>('/schema/diagram', abort.signal);
        if (!abort.signal.aborted) { setDiagram(value); setError(''); setImageError(false); }
      } catch (failure) { if (!abort.signal.aborted) setError((failure as Error).message); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 15_000);
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  useEffect(() => setImageError(false), [diagram?.revision]);
  return <aside className="cx-data-diagram cx-data-panel" aria-label="Database relationship diagram">
    <div className="cx-data-panel-head"><h2>Database relationships</h2><span className="tag tag-neutral">Graphviz</span></div>
    <p className="cx-hint">Tables and foreign keys from SchemaSpy. Updates automatically when the database changes.</p>
    {diagram?.available && !imageError ? <a className="cx-data-diagram-image" href={`/api/ml-data/schema/diagram/image?v=${encodeURIComponent(diagram.revision ?? '')}`} target="_blank" rel="noopener noreferrer" aria-label="Open full-size database relationship diagram">
      <img src={`/api/ml-data/schema/diagram/image?v=${encodeURIComponent(diagram.revision ?? '')}`} alt="Graphviz diagram of training database tables and foreign-key relationships" onError={() => setImageError(true)} />
    </a> : <p className="cx-data-empty">{error || diagram?.error || (imageError ? 'The diagram could not be loaded. It will retry after the next update.' : 'Loading diagram…')}</p>}
    {diagram?.generatedAt && <p className="cx-hint">Updated {new Date(diagram.generatedAt).toLocaleString()}</p>}
    {diagram?.available && <p className="cx-hint">Select the diagram to view it at full size.</p>}
    {diagram?.available && error && <p className="cx-data-error" role="status">{error} Showing the last published diagram.</p>}
  </aside>;
}

function SchemaSpyReport() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState('/api/ml-data/schema/report/');
  useEffect(() => {
    const navigateReport = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object'
        || !('type' in event.data) || !('url' in event.data) || event.data.type !== 'schemaspy-navigate' || typeof event.data.url !== 'string') return;
      try {
        const url = new URL(event.data.url);
        if (url.origin === location.origin && url.pathname.startsWith('/api/ml-data/schema/report/') && !url.username && !url.password && !url.search) setSrc(url.pathname + url.hash);
      } catch { /* Ignore anything outside the report's own navigation. */ }
    };
    window.addEventListener('message', navigateReport);
    return () => window.removeEventListener('message', navigateReport);
  }, []);
  return <iframe ref={frame} className="cx-data-report" src={src} title="SchemaSpy database visualization" sandbox="allow-scripts" />;
}
