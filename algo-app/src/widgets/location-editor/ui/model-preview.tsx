import { useEffect, useMemo, useRef, useState } from 'react';
import { readDraftModel } from '../../../entities/location-config/index.ts';
import type { AssetCapability, DraftDetail, LocationDocument, ModelTransform } from '../../../entities/location-config/index.ts';
import { modelRootTransform, type ModelSceneDocument } from '../../../features/location-editor/index.ts';
import { ensureLocationModelViewer, type LocationModelViewerElement } from '../model-viewer-loader.ts';

type PreviewState = 'loading' | 'ready' | 'error';

/** One stable viewer for the Room view and the live Details/Sensors companion pane. */
export function ModelPreview({ draft, document, scene, capability, retry, stale, empty, onRetry, onUse2d }: {
  draft: DraftDetail; document: LocationDocument; scene: ModelSceneDocument; capability?: AssetCapability;
  retry: number; stale: boolean; empty: boolean; onRetry(): void; onUse2d(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<LocationModelViewerElement | null>(null);
  const listener = useRef<EventListener | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [moduleRetry, setModuleRetry] = useState(0);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [state, setState] = useState<PreviewState>('loading');
  const [message, setMessage] = useState('Loading 3D preview…');
  const transform = useMemo(() => modelRootTransform(document.modelTransform ?? defaultTransform()), [document.modelTransform]);
  const uses3dViewer = !empty && (scene.source === 'generated' || scene.source === 'custom');
  const readsModel = !empty && scene.source === 'custom' && !!document.modelAssetId;

  useEffect(() => {
    if (!uses3dViewer) { setViewerError(''); setState('ready'); return; }
    if (viewer.current) return;
    let active = true;
    setViewerReady(false);
    setViewerError('');
    void ensureLocationModelViewer().then(() => {
      if (!active) return;
      const element = host.current;
      if (!element) return;
      const customElement = globalThis.document.createElement('tm-location-model-viewer');
      const onViewerState: EventListener = (event) => {
        const detail = (event as CustomEvent<{ state: string; message: string }>).detail;
        if (!detail) return;
        if (detail.state === 'error' && /3d preview could not be started/i.test(detail.message)) {
          setState('error'); setMessage(detail.message); setViewerError('3D preview unavailable. Use the 2D editor or retry the preview.');
          setViewerReady(false); return;
        }
        setState(detail.state === 'error' ? 'error' : detail.state === 'loaded' ? 'ready' : 'loading');
        setMessage(detail.message);
      };
      listener.current = onViewerState;
      customElement.addEventListener('location-model-state', onViewerState);
      viewer.current = customElement;
      element.replaceChildren(customElement);
      setViewerReady(true);
    }).catch(() => {
      if (active) { setState('error'); setViewerError('3D preview unavailable. Use the 2D editor or retry the preview.'); }
    });
    return () => { active = false; };
  }, [uses3dViewer, moduleRetry]);

  useEffect(() => () => {
    const element = viewer.current;
    if (element && listener.current) element.removeEventListener('location-model-state', listener.current);
    element?.remove();
    viewer.current = null;
  }, []);

  useEffect(() => {
    if (!readsModel || !document.modelAssetId) {
      setBuffer(null);
      if (!readsModel) {
        setState(uses3dViewer ? 'loading' : 'ready');
        setMessage(scene.source === 'generated' ? 'Loading built-in room preview…' : '2D floor view selected for this private draft.');
      }
      return;
    }
    if (capability?.source !== 'upload' || !capability.previewAvailable) {
      setBuffer(null); setState('error'); setMessage('This model cannot be previewed through the current private draft.'); return;
    }
    const controller = new AbortController();
    let active = true;
    setBuffer(null); setState('loading'); setMessage('Loading the authorized private GLB preview.');
    void readDraftModel(draft.draftId, document.modelAssetId, controller.signal).then((bytes) => {
      if (active) setBuffer(bytes);
    }).catch(() => {
      if (active) { setState('error'); setMessage('The private model preview could not be loaded. The draft reference is preserved.'); }
    });
    return () => { active = false; controller.abort(); };
  }, [draft.draftId, document.modelAssetId, capability?.source, capability?.previewAvailable, readsModel, retry, scene.source, uses3dViewer]);

  useEffect(() => {
    if (!viewerReady || viewerError) return;
    viewer.current?.setFloor(scene);
    if (scene.source === 'generated') { setState('ready'); setMessage('Built-in room preview ready.'); }
  }, [viewerReady, viewerError, scene, retry]);
  useEffect(() => { if (viewerReady && !viewerError && scene.source === 'custom') viewer.current?.setTransform(transform); }, [viewerReady, viewerError, scene.source, transform]);
  useEffect(() => {
    if (!viewerReady || viewerError || scene.source !== 'custom' || !buffer) return;
    setState('loading');
    void viewer.current?.loadModel(buffer);
  }, [viewerReady, viewerError, scene.source, buffer]);

  const retryViewer = () => {
    const element = viewer.current;
    if (element && listener.current) element.removeEventListener('location-model-state', listener.current);
    element?.remove(); viewer.current = null; listener.current = null;
    setViewerReady(false); setViewerError(''); setModuleRetry((value) => value + 1);
  };
  const status = stale ? 'Showing the last valid 3D preview. Fix the highlighted layout fields to update it.'
    : empty ? 'No valid 3D preview yet. Correct the highlighted layout fields to preview this room.' : message;
  const showFallback = !uses3dViewer || !!viewerError || (readsModel && state === 'error');
  const showError = !!viewerError || (readsModel && state === 'error');
  return <section className="loc-room-preview-panel" aria-label="3D room preview">
    <header className="loc-room-preview-heading"><div><h2>3D room preview</h2>
      {scene.source === 'generated' && <p>Room height · 3.0 m <span aria-hidden="true">·</span> Table height · 0.75 m</p>}
    </div></header>
    <div className="loc-model-viewer-frame" aria-busy={uses3dViewer && (state === 'loading' || !viewerReady)} data-testid="location-room-preview-canvas">
      {showError && <p className="loc-alert" role="alert">3D preview unavailable. Use the 2D editor or retry the preview.</p>}
      {showFallback && <FloorGeometryFallback scene={scene} />}
      <div className="loc-model-viewer" ref={host} hidden={showFallback} role="img" aria-label="Read-only 3D location preview. Move tables, seats, and sensors in the 2D editor. Use the camera controls to orbit and zoom." data-testid="location-model-viewer" data-preview-canvas="true" />
    </div>
    <div className="loc-model-view-controls" aria-label="Camera controls">
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-in" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.zoomIn()}>Zoom in</button>
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-out" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.zoomOut()}>Zoom out</button>
      <span data-testid="location-room-reset-view"><button type="button" className="btn btn-secondary" data-testid="location-model-reset-view" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.resetCamera()}>Reset view</button></span>
      {state === 'error' && <span data-testid="location-room-preview-retry"><button type="button" className="btn btn-ghost" data-testid="location-model-preview-retry" onClick={() => viewerError ? retryViewer() : onRetry()}>Retry 3D preview</button></span>}
      {showError && <span data-testid="location-room-preview-use-2d"><button type="button" className="btn btn-secondary" data-testid="location-model-use-2d" onClick={onUse2d}>Use 2D editor</button></span>}
    </div>
    <p className={`loc-model-preview-status ${state === 'error' || stale || empty ? 'is-error' : ''}`} role={state === 'error' || stale || empty ? 'alert' : 'status'} aria-live="polite" data-testid="location-room-preview-status">{status}</p>
    <SceneLegend scene={scene} />
  </section>;
}

/** Readable text alternative to the preview geometry and private sensor poses. */
function SceneLegend({ scene }: { scene: ModelSceneDocument }) {
  return <div className="loc-model-scene-list" aria-label="3D preview objects" data-testid="location-room-preview-object-list">
    <h3>Room objects</h3>
    {!scene.tables.length && !scene.sensors.length && <p>No tables or placed sensors yet. Add them in the 2D layout and Sensors steps.</p>}
    <ul>{scene.tables.map((table) => <li key={table.id}><b>{table.name}</b> · {table.kind} · {table.seats.length} seats
      {table.seats.length > 0 && <ul>{table.seats.map((seat) => <li key={seat.id}>Seat {seat.id}</li>)}</ul>}
    </li>)}{scene.sensors.map((sensor) => <li key={sensor.uid}><b>{sensor.label}</b> · {sensor.position.y.toFixed(2)} m high · yaw {(sensor.yawRad * 180 / Math.PI).toFixed(1)}°</li>)}</ul>
  </div>;
}

/** 2D equivalent shown for explicit 2D mode, legacy-static, or viewer failure. */
function FloorGeometryFallback({ scene }: { scene: ModelSceneDocument }) {
  return <div className="loc-model-floor-fallback" data-testid="location-model-2d-fallback">
    <h3>{scene.source === '2d' ? '2D floor view selected' : '2D floor geometry'}</h3>
    <svg viewBox={`0 ${-scene.heightM} ${scene.widthM} ${scene.heightM}`} role="img" aria-label="Two-dimensional floor geometry with authored tables, seats and placed sensors" preserveAspectRatio="xMidYMid meet">
      <rect className="loc-model-floor-outline" x="0" y={-scene.heightM} width={scene.widthM} height={scene.heightM} />
      {scene.tables.map((table) => <Footprint key={table.id} table={table} />)}
      {scene.tables.flatMap((table) => table.seats.map((seat) => <circle className="loc-model-floor-seat" key={`${table.id}:${seat.id}`} cx={seat.position.x} cy={seat.position.z} r="0.12" />))}
      {scene.sensors.map((sensor) => <circle className="loc-model-floor-sensor" key={sensor.uid} cx={sensor.position.x} cy={sensor.position.z} r="0.16"><title>{`${sensor.label} · height ${sensor.position.y.toFixed(2)} m`}</title></circle>)}
    </svg>
  </div>;
}

function Footprint({ table }: { table: ModelSceneDocument['tables'][number] }) {
  const footprint = table.footprint;
  if (footprint.type === 'circle') return <circle className="loc-model-floor-table" data-table-id={table.id} cx={footprint.center.x} cy={footprint.center.z} r={footprint.radiusM} />;
  const points = footprint.points.map((point) => `${point.x},${point.z}`).join(' ');
  return footprint.type === 'rect'
    ? <polygon className="loc-model-floor-table" data-table-id={table.id} points={points} />
    : <polygon className="loc-model-floor-table" data-table-id={table.id} points={points} />;
}

function defaultTransform(): ModelTransform {
  return { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } };
}
