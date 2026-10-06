/** Firmware source, builds and pilot-first OTA, in the console's own design. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { firmwareSourcePath } from '../../../src/shared/firmware-upload.ts';
import { ArrowRight, UploadSimple } from './icons.tsx';
import { eligibleNodes, targetOf, updatesApi } from './updates/api.ts';
import type { FirmwareView, Rollout, UpdateLayout, UpdateNode, UpdateTarget } from './updates/api.ts';
import './updates/updates.css';

const sizeOf = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
const dateOf = (at: number | null) => at === null ? '—' : new Date(at).toLocaleString();
const isRunning = (rollout: Rollout | null | undefined) => !!rollout && rollout.stage !== 'done' && rollout.stage !== 'stopped';
const errorOf = (error: unknown) => error instanceof Error ? error.message : String(error);
type Confirmation = { kind: 'start'; buildId: string; version: string; target: UpdateTarget; nodes: UpdateNode[] } | { kind: 'stop' };

export function Updates() {
  const [view, setView] = useState<FirmwareView | null>(null);
  const [layout, setLayout] = useState<UpdateLayout>({ floors: [] });
  const [nodes, setNodes] = useState<UpdateNode[]>([]);
  const [statusError, setStatusError] = useState('');
  const [actionError, setActionError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState('');
  const [projectError, setProjectError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [activity, setActivity] = useState('');
  const [buildOutput, setBuildOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [buildId, setBuildId] = useState('');
  const [targetValue, setTargetValue] = useState('all');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const log = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [next, nextLayout, state] = await Promise.all([
      updatesApi.firmware(signal), updatesApi.layout(signal), updatesApi.nodes(signal),
    ]);
    if (signal?.aborted) return;
    setView(next);
    if (next.building?.log.length) setBuildOutput(next.building.log.join('\n'));
    setLayout(nextLayout);
    setNodes(state.nodes.filter((node) => node.registered));
    setStatusError('');
    setBuildId((current) => next.builds.some((build) => build.id === current && build.state === 'ready')
      ? current : next.builds.find((build) => build.state === 'ready')?.id ?? '');
  }, []);

  // Poll after each response, so a slow edge never accumulates requests.
  // Cleanup also stops a folder upload when its owner leaves this module.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setStatusError(errorOf(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); operation.current?.abort(); operation.current = null; };
  }, [refresh]);

  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);

  // Retain the tail after the server clears a successful build job.
  const buildLog = view?.building?.log.join('\n') || buildOutput;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [buildLog, activity]);

  const ready = view?.builds.filter((build) => build.state === 'ready') ?? [];
  const building = view?.building;
  const buildingActive = !!building && !building.error && (!building.lifecycle || ['accepted', 'running'].includes(building.lifecycle));
  const running = isRunning(view?.rollout);
  const target = targetOf(targetValue);
  const chosen = eligibleNodes(nodes, target);
  const available = eligibleNodes(nodes, { kind: 'all' });
  const selectedBuild = ready.find((build) => build.id === buildId);
  const dataReady = !!view && !statusError;
  const buildLabel = uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}`
    : buildingActive ? 'Building on the edge' : building ? 'Build failed' : 'Ready to build';

  function selectFolder(selected: FileList | null) {
    const all = [...(selected ?? [])];
    const sources = all.filter((file) => firmwareSourcePath(file.webkitRelativePath || file.name) !== null);
    setFolder(all[0]?.webkitRelativePath.split('/')[0] ?? '');
    setFiles(sources);
    setActivity('');
    setBuildOutput('');
    setActionError('');
    setProjectError(!sources.some((file) => firmwareSourcePath(file.webkitRelativePath || file.name) === 'platformio.ini')
      ? 'Choose the project root containing platformio.ini, src, and include.'
      : !sources.some((file) => firmwareSourcePath(file.webkitRelativePath || file.name)?.startsWith('src/'))
        ? 'This folder has no C/C++ source files in src.' : '');
  }

  async function uploadAndBuild() {
    if (operation.current || !dataReady || buildingActive || !files.length || projectError) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setActionError('');
    setBuildOutput('');
    setUploadProgress({ done: 0, total: files.length });
    setActivity(`Uploading ${files.length} source files from ${folder}…`);
    try {
      const { uploadId } = await updatesApi.upload(controller.signal);
      for (const [index, file] of files.entries()) {
        await updatesApi.file(uploadId, file.webkitRelativePath || file.name, await file.arrayBuffer(), controller.signal);
        setUploadProgress({ done: index + 1, total: files.length });
        setActivity(`Uploaded ${index + 1}/${files.length} source files.`);
      }
      await updatesApi.build(uploadId, controller.signal);
      setActivity('Build accepted. The edge is compiling the firmware; this may take a few minutes.');
      await refresh(controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) setStatusError(errorOf(error));
      });
    } catch (error) {
      if (!controller.signal.aborted) { setActionError(errorOf(error)); setActivity(`Upload / build failed: ${errorOf(error)}`); }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setUploadProgress(null); operation.current = null; }
    }
  }

  async function confirmAction() {
    if (!confirmation || operation.current || !dataReady) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setActionError('');
    try {
      if (confirmation.kind === 'start') await updatesApi.rollout(confirmation.buildId, confirmation.target, controller.signal);
      else await updatesApi.stop(controller.signal);
      setConfirmation(null);
      await refresh(controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) setStatusError(errorOf(error));
      });
    } catch (error) {
      if (!controller.signal.aborted) { setActionError(errorOf(error)); setConfirmation(null); }
    } finally {
      if (!controller.signal.aborted) { setBusy(false); operation.current = null; }
    }
  }

  return (
    <main className="cx-train cx-updates">
      <header className="cx-train-head">
        <div>
          <div className="cx-kicker">&gt; MODULE 04 / FIRMWARE</div>
          <h1 className="cx-h2">Updates</h1>
          <p className="cx-up-lede">Build from source. Prove it on one node. Then roll it out.</p>
        </div>
        <span className={`tag ${statusError ? 'tag-outline cx-tag-bad' : 'tag-neutral'} cx-tag-px`} role="status">
          <span className={`cx-sq ${dataReady ? 'cx-up-online' : ''}`} />
          {statusError ? 'EDGE UNREACHABLE' : view ? 'CONNECTED TO EDGE' : 'CONNECTING…'}
        </span>
      </header>

      {statusError && <div className="cx-up-alert" role="alert">Cannot refresh updates: {statusError} Retrying automatically.</div>}
      {actionError && <div className="cx-up-alert" role="alert">{actionError}</div>}

      <section className="cx-up-stats" aria-label="Update overview">
        <Metric label="READY IMAGES" value={view ? String(ready.length).padStart(2, '0') : '—'} detail={view ? `${sizeOf(view.diskBytes)} stored on this edge` : 'Loading image library'} />
        <Metric label="AVAILABLE NODES" value={view ? String(available.length).padStart(2, '0') : '—'} detail="Online with an update route" />
        <Metric label="ROLLOUT" value={view?.rollout ? stageLabel(view.rollout.stage) : 'IDLE'} detail={view?.rollout ? `${view.rollout.nodes.filter((node) => node.state === 'confirmed').length}/${view.rollout.nodes.length} nodes confirmed` : 'No update in progress'} />
      </section>

      <div className="cx-up-cols">
        <div className="cx-up-column">
          <section className="card elev-sm cx-card" aria-labelledby="up-build-title">
            <PanelHead step="01" title="Upload & build" id="up-build-title" />
            <p className="cx-up-copy">Choose the TMsense project folder to compile a new firmware image on the edge.</p>
            <div className={`cx-up-source ${folder ? 'is-selected' : ''}`}>
              <UploadSimple />
              <div><strong>{folder || 'Select a project folder'}</strong><span>{folder ? `${files.length} release files · ${sizeOf(files.reduce((total, file) => total + file.size, 0))}` : 'platformio.ini + src/ + include/'}</span></div>
              <input ref={input} type="file" multiple {...{ webkitdirectory: '', directory: '' }} hidden aria-label="TMsense project folder"
                onChange={(event) => selectFolder(event.target.files)} />
              <button className="btn btn-secondary cx-btn-px" disabled={busy || buildingActive} onClick={() => input.current?.click()}>{folder ? 'Change folder' : 'Browse folder'}</button>
            </div>
            <p className="cx-hint">Release build: <code>tmflash</code>. Local provisioning files and generated output are excluded.</p>
            {projectError && <p className="cx-hint is-err" role="alert">{projectError}</p>}
            {view && !view.pio && <p className="cx-hint is-err">The firmware build worker is not configured on this edge. Existing images can still be rolled out.</p>}
            <div className="cx-up-actions">
              <button className="btn btn-primary cx-btn-px" disabled={!dataReady || !view?.pio || busy || buildingActive || !files.length || !!projectError}
                onClick={() => void uploadAndBuild()}><UploadSimple />{uploadProgress ? 'Uploading…' : buildingActive ? 'Building…' : 'Upload and build'}</button>
              <span className="cx-hint" role="status">{buildLabel}</span>
            </div>
            {uploadProgress && <progress className="cx-up-upload-progress" max={uploadProgress.total} value={uploadProgress.done} aria-label="Source upload progress" />}
            <div className="cx-up-terminal">
              <div className="cx-up-terminal-head"><span className="cx-label">BUILD OUTPUT</span><span className="cx-hint">{buildingActive && building ? `${Math.max(0, Math.round((Date.now() - building.startedAt) / 1000))}s elapsed` : 'tmflash / release'}</span></div>
              <pre ref={log} className="cx-up-log" aria-label="Build output">{uploadProgress ? activity : buildLog || activity || '> Select source to start a build.\n> Build output will appear here.'}</pre>
              {building?.error && <p className="cx-hint is-err cx-up-log-error" role="alert">{building.error}</p>}
            </div>
          </section>

          <section className="card elev-sm cx-card" aria-labelledby="up-library-title">
            <div className="cx-card-head"><h2 id="up-library-title" className="cx-label">IMAGE LIBRARY</h2><span className="cx-hint">Stored on this edge</span></div>
            {!view ? <p className="cx-hint">Loading images…</p> : !view.builds.length
              ? <div className="cx-up-empty"><span className="cx-mono">No firmware images yet.</span><p>Upload a project above to build your first image.</p></div>
              : <div className="cx-up-table-wrap"><table className="table cx-up-images">
                <thead><tr><th>Version / image</th><th>Size</th><th>Built</th><th>Use</th></tr></thead>
                <tbody>{view.builds.map((build) => <tr key={build.id} className={build.id === buildId ? 'is-on' : ''}>
                  <td><strong className="cx-mono">{build.version}</strong><span className="cx-hint" title={`SHA-256: ${build.sha256}`}>{build.id}</span>{build.state !== 'ready' && <span className="cx-hint is-err">{build.error || build.state}</span>}</td>
                  <td className="cx-mono">{sizeOf(build.size)}</td><td className="cx-hint">{dateOf(build.builtAt)}</td>
                  <td><button className={`btn ${build.id === buildId ? 'btn-primary' : 'btn-secondary'} cx-btn-px`} disabled={build.state !== 'ready' || busy || running}
                    onClick={() => setBuildId(build.id)} aria-label={`Select image ${build.id}`} aria-pressed={build.id === buildId}>{build.id === buildId ? 'Selected' : 'Select'}</button></td>
                </tr>)}</tbody>
              </table></div>}
          </section>
        </div>

        <div className="cx-up-column">
          <section className="card elev-sm cx-card" aria-labelledby="up-rollout-title">
            <PanelHead step="02" title="Roll out" id="up-rollout-title" />
            <p className="cx-up-copy">Choose a built image and the nodes to update.</p>
            <div className="field"><label htmlFor="up-image">FIRMWARE IMAGE</label><select id="up-image" className="input" value={buildId} disabled={!dataReady || busy || running || !ready.length} onChange={(event) => setBuildId(event.target.value)}>
              {!ready.length && <option value="">No ready images</option>}{ready.map((build) => <option key={build.id} value={build.id}>{build.version} · {build.id} · {sizeOf(build.size)}</option>)}
            </select></div>
            <div className="field"><label htmlFor="up-target">UPDATE TARGET</label><select id="up-target" className="input" value={targetValue} disabled={!dataReady || busy || running} onChange={(event) => setTargetValue(event.target.value)}>
              <option value="all">Every node ({available.length} available)</option>
              {layout.floors.map((floor) => <option key={floor.id} value={`floor:${floor.id}`}>{floor.name} ({eligibleNodes(nodes, { kind: 'floor', floorId: floor.id }).length} available)</option>)}
              {nodes.map((node) => <option key={node.uid} value={`node:${node.uid}`}>{node.label} ({node.uid}){eligibleNodes([node], { kind: 'all' }).length ? '' : ' — unavailable'}</option>)}
            </select></div>
            <div className="cx-up-plan">
              <span className="tag tag-outline cx-tag-px">PILOT FIRST</span>
              <p>{!chosen.length ? 'No online node with an update route matches this target.'
                : chosen.length === 1 ? <><strong>{chosen[0]?.label}</strong> is the only target.</>
                  : <><strong>{chosen[0]?.label}</strong> goes first. The other {chosen.length - 1} node{chosen.length === 2 ? '' : 's'} follow after it proves healthy.</>}</p>
              <span className="cx-hint">The pilot must report the new image, a working sensor, and an accepted packet. A failed pilot stops the rollout.</span>
            </div>
            <button className="btn btn-primary cx-btn-px cx-up-start" disabled={!dataReady || !selectedBuild || !chosen.length || busy || running}
              onClick={() => selectedBuild && setConfirmation({ kind: 'start', buildId, version: selectedBuild.version, target, nodes: chosen })}>
              {running ? 'Rollout in progress' : `Start update${chosen.length ? ` · ${chosen.length} node${chosen.length === 1 ? '' : 's'}` : ''}`}<ArrowRight />
            </button>
          </section>

          <section className="card elev-sm cx-card" aria-labelledby="up-progress-title">
            <div className="cx-card-head"><h2 id="up-progress-title" className="cx-label">ROLLOUT PROGRESS</h2>
              {running && <button className="btn btn-secondary cx-danger cx-btn-px" disabled={busy || !dataReady} onClick={() => setConfirmation({ kind: 'stop' })}>Stop rollout</button>}
            </div>
            {view?.rollout ? <RolloutProgress rollout={view.rollout} />
              : <div className="cx-up-empty"><span className="cx-mono">Standing by.</span><p>Start an update to follow each node from download to confirmation.</p></div>}
          </section>

          {!!view?.history.length && <section className="card elev-sm cx-card" aria-labelledby="up-history-title">
            <h2 id="up-history-title" className="cx-label">RECENT UPDATES</h2>
            {view.history.slice(0, 5).map((past) => <div key={past.id} className="cx-up-history">
              <div><span className="cx-mono">{past.version}</span><span className="cx-hint">{dateOf(past.startedAt)} · {past.nodes.filter((node) => node.state === 'confirmed').length}/{past.nodes.length} confirmed</span></div>
              <span className="tag tag-neutral cx-tag-px">{stageLabel(past.stage)}</span>
            </div>)}
          </section>}
        </div>
      </div>

      <dialog ref={dialog} className="cx-up-confirm" onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)} aria-labelledby="up-confirm-title">
        <div className="card cx-card">
          <div className="cx-kicker">&gt; CONFIRM UPDATE</div>
          <h2 id="up-confirm-title">{confirmation?.kind === 'stop' ? 'Stop this rollout?' : 'Ready to update?'}</h2>
          {confirmation?.kind === 'start' ? <><p>Update {confirmation.nodes.length} node{confirmation.nodes.length === 1 ? '' : 's'} to <strong className="cx-mono">{confirmation.version}</strong>?</p>
            <p className="cx-hint">Image {confirmation.buildId}<br />Pilot: {confirmation.nodes[0]?.label} ({confirmation.nodes[0]?.uid})</p>
            <p className="cx-up-copy">{confirmation.nodes.length > 1 ? 'The remaining nodes follow only after the pilot comes back healthy.' : 'This node must come back healthy to confirm the update.'}</p></>
            : <p className="cx-up-copy">Nodes already flashing will finish. Nodes still queued will be left alone.</p>}
          <div className="cx-up-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmation(null)}>Back</button>
            <button className="btn btn-primary cx-btn-px" disabled={busy || !dataReady || (confirmation?.kind === 'start' && running)} onClick={() => void confirmAction()}>{busy ? 'Working…' : confirmation?.kind === 'stop' ? 'Stop rollout' : 'Start update'}<ArrowRight /></button></div>
        </div>
      </dialog>
    </main>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="cx-up-metric"><span className="cx-label">{label}</span><strong>{value}</strong><span className="cx-hint">{detail}</span></div>;
}
function PanelHead({ step, title, id }: { step: string; title: string; id: string }) {
  return <div className="cx-up-panel-head"><span className="cx-up-step">{step}</span><h2 id={id}>{title}</h2></div>;
}
function stageLabel(stage: Rollout['stage']) {
  return { pilot: 'PILOT', rest: 'ROLLING OUT', done: 'COMPLETE', stopped: 'STOPPED' }[stage];
}
function RolloutProgress({ rollout }: { rollout: Rollout }) {
  const confirmed = rollout.nodes.filter((node) => node.state === 'confirmed').length;
  return <>
    <div className="cx-up-rollout-head"><strong className="cx-mono">{rollout.version}</strong><span className={`tag ${rollout.stage === 'stopped' ? 'tag-outline cx-tag-bad' : 'tag-accent'} cx-tag-px`}>{stageLabel(rollout.stage)}</span></div>
    <div className="cx-up-stages" aria-label={`Rollout stage: ${stageLabel(rollout.stage)}`}>
      {['Pilot', 'Remaining nodes', 'Complete'].map((label, index) => <span key={label} className={(rollout.stage === 'done' || index === 0 && rollout.stage !== 'stopped' || index === 1 && rollout.stage === 'rest') ? 'is-on' : ''}>{String(index + 1).padStart(2, '0')} / {label}</span>)}
    </div>
    <p className="cx-hint" role="status">{rollout.note} · {confirmed}/{rollout.nodes.length} confirmed</p>
    <div className="cx-up-nodes">{rollout.nodes.map((node, index) => {
      const percent = node.state === 'confirmed' ? 100 : Math.min(100, Math.max(0, node.percent));
      return <div className={`cx-up-node ${node.state === 'failed' ? 'is-failed' : ''}`} key={node.uid}>
        <div className="cx-up-node-head"><strong>{node.label}</strong>{index === 0 && <span className="cx-up-pilot">PILOT</span>}<span className={`cx-mono ${node.state === 'confirmed' ? 'cx-up-good' : ''}`}>{node.state} · {percent}%</span></div>
        <div className="cx-hint">{node.uid}</div>
        <progress max={100} value={percent} aria-label={`${node.label} update progress`} />
        {node.error && <p className="cx-hint is-err">{node.error}</p>}
      </div>;
    })}</div>
  </>;
}
