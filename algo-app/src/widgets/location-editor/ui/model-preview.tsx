import { useEffect, useMemo, useRef, useState } from 'react';
import { readDraftModel } from '../../../entities/location-config/index.ts';
import type { AssetCapability, DraftDetail, FurnitureSlots, LocationDocument, ModelTransform } from '../../../entities/location-config/index.ts';
import { modelRootTransform, type ModelSceneDocument } from '../../../features/location-editor/index.ts';
import { ensureLocationModelViewer, type LocationModelViewerElement } from '../model-viewer-loader.ts';

type PreviewState = 'loading' | 'ready' | 'error';
export type FurniturePreviewScene = Omit<ModelSceneDocument, 'tables'> & {
  tables: Array<ModelSceneDocument['tables'][number] & { furniture?: FurnitureSlots }>;
};

/** One stable viewer for the Room view and the live Details/Sensors companion pane. */
export function ModelPreview({ draft, document, scene, capability, retry, stale, empty, furnitureBuffers, onLoadFurnitureAsset, onRetry, onUse2d }: {
  draft: DraftDetail; document: LocationDocument; scene: FurniturePreviewScene; capability?: AssetCapability;
  furnitureBuffers: ReadonlyMap<string, ArrayBuffer>; onLoadFurnitureAsset(assetId: string): Promise<ArrayBuffer>;
  retry: number; stale: boolean; empty: boolean; onRetry(): void; onUse2d(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<LocationModelViewerElement | null>(null);
  const listener = useRef<EventListener | null>(null);
  const furnitureListener = useRef<EventListener | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [moduleRetry, setModuleRetry] = useState(0);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [state, setState] = useState<PreviewState>('loading');
  const [message, setMessage] = useState('Loading 3D preview…');
  const [furnitureLoadingIds, setFurnitureLoadingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [furnitureErrorIds, setFurnitureErrorIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeFurnitureIds = useRef<ReadonlySet<string>>(new Set());
  const transform = useMemo(() => modelRootTransform(document.modelTransform ?? defaultTransform()), [document.modelTransform]);
  const uses3dViewer = !empty && (scene.source === 'generated' || scene.source === 'custom');
  const readsModel = !empty && scene.source === 'custom' && !!document.modelAssetId;
  const furnitureAssetIds = useMemo(() => scene.source === 'generated' || scene.source === 'custom'
    ? [...new Set(scene.tables.flatMap((table) => [table.furniture?.table?.assetId, table.furniture?.chair?.assetId].filter((id): id is string => !!id)))].sort()
    : [], [scene.source, scene.tables]);
  const furnitureAssetKey = furnitureAssetIds.join('|');
  const hasCustomFurnitureOverlay = scene.source === 'custom' && scene.tables.some((table) => !!table.furniture?.table
    || !!table.furniture?.chair && table.seats.length > 0);
  activeFurnitureIds.current = new Set(furnitureAssetIds);

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
      const onFurnitureState: EventListener = (event) => {
        const detail = (event as CustomEvent<{ assetId: string; state: 'loading' | 'loaded' | 'error' }>).detail;
        if (!detail || !activeFurnitureIds.current.has(detail.assetId)) return;
        setFurnitureLoadingIds((current) => {
          const next = new Set(current);
          if (detail.state === 'loading') next.add(detail.assetId); else next.delete(detail.assetId);
          return next;
        });
        setFurnitureErrorIds((current) => {
          const next = new Set(current);
          if (detail.state === 'error') next.add(detail.assetId); else next.delete(detail.assetId);
          return next;
        });
      };
      listener.current = onViewerState;
      furnitureListener.current = onFurnitureState;
      customElement.addEventListener('location-model-state', onViewerState);
      customElement.addEventListener('location-model-furniture-state', onFurnitureState);
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
    if (element && furnitureListener.current) element.removeEventListener('location-model-furniture-state', furnitureListener.current);
    element?.remove();
    viewer.current = null; listener.current = null; furnitureListener.current = null;
  }, []);

  useEffect(() => {
    let active = true;
    const missing = furnitureAssetIds.filter((assetId) => !furnitureBuffers.has(assetId));
    const available = new Set(furnitureAssetIds.filter((assetId) => furnitureBuffers.has(assetId)));
    setFurnitureLoadingIds((current) => new Set([...([...current].filter((id) => furnitureAssetIds.includes(id))), ...missing]));
    setFurnitureErrorIds((current) => new Set([...current].filter((id) => furnitureAssetIds.includes(id) && !missing.includes(id))));
    if (available.size) {
      setFurnitureLoadingIds((current) => new Set([...current].filter((id) => !available.has(id))));
    }
    for (const assetId of missing) {
      void onLoadFurnitureAsset(assetId).then(() => {
        if (!active) return;
        setFurnitureLoadingIds((current) => { const next = new Set(current); next.delete(assetId); return next; });
      }).catch(() => {
        if (!active) return;
        setFurnitureLoadingIds((current) => { const next = new Set(current); next.delete(assetId); return next; });
        setFurnitureErrorIds((current) => new Set([...current, assetId]));
      });
    }
    return () => { active = false; };
  }, [furnitureAssetKey, furnitureBuffers, onLoadFurnitureAsset, retry]);

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
  useEffect(() => {
    if (!viewerReady || viewerError) return;
    const assets = furnitureAssetIds.flatMap((assetId) => {
      const buffer = furnitureBuffers.get(assetId);
      return buffer ? [{ assetId, buffer }] : [];
    });
    viewer.current?.setFurnitureAssets(assets);
  }, [viewerReady, viewerError, furnitureAssetKey, furnitureBuffers, retry]);
  useEffect(() => { if (viewerReady && !viewerError && scene.source === 'custom') viewer.current?.setTransform(transform); }, [viewerReady, viewerError, scene.source, transform]);
  useEffect(() => {
    if (!viewerReady || viewerError || scene.source !== 'custom' || !buffer) return;
    setState('loading');
    void viewer.current?.loadModel(buffer);
  }, [viewerReady, viewerError, scene.source, buffer]);

  const retryViewer = () => {
    const element = viewer.current;
    if (element && listener.current) element.removeEventListener('location-model-state', listener.current);
    if (element && furnitureListener.current) element.removeEventListener('location-model-furniture-state', furnitureListener.current);
    element?.remove(); viewer.current = null; listener.current = null;
    furnitureListener.current = null;
    setViewerReady(false); setViewerError(''); setModuleRetry((value) => value + 1);
  };
  const furnitureError = furnitureErrorIds.size > 0;
  const furnitureLoading = furnitureLoadingIds.size > 0;
  const status = stale ? 'Showing the last valid 3D preview. Fix the highlighted layout fields to update it.'
    : empty ? 'No valid 3D preview yet. Correct the highlighted layout fields to preview this room.'
      : furnitureError ? `A shared furniture model could not be previewed. The assignment stays on the draft; ${scene.source === 'generated' ? 'the built-in room keeps its generated primitive fallback.' : 'the custom room is unchanged.'} Retry preview.`
        : furnitureLoading ? 'Loading furniture model…' : message;
  const showFallback = !uses3dViewer || !!viewerError || (readsModel && state === 'error');
  const showError = !!viewerError || (readsModel && state === 'error');
  return <section className="loc-room-preview-panel" aria-label="3D room preview">
    <header className="loc-room-preview-heading"><div><h2>3D room preview</h2>
      {scene.source === 'generated' && <p>Room height · 3.0 m {scene.tables.some((table) => !table.furniture?.table) && <><span aria-hidden="true">·</span> Generated table fallback · 0.75 m</>}</p>}
    </div></header>
    {hasCustomFurnitureOverlay && <p className="loc-furniture-warning" role="note" data-testid="location-custom-furniture-warning">Custom room GLBs should omit table and chair geometry where furniture overlays are assigned. Check this preview for duplicates; publishing is not blocked.</p>}
    <div className="loc-model-viewer-frame" aria-busy={uses3dViewer && (state === 'loading' || !viewerReady || furnitureLoading)} data-testid="location-room-preview-canvas">
      {showError && <p className="loc-alert" role="alert">3D preview unavailable. Use the 2D editor or retry the preview.</p>}
      {showFallback && <FloorGeometryFallback scene={scene} />}
      <div className="loc-model-viewer" ref={host} hidden={showFallback} role="img" aria-label="Read-only 3D location preview. Move tables, seats, and sensors in the 2D editor. Use the camera controls to orbit and zoom." data-testid="location-model-viewer" data-preview-canvas="true" />
    </div>
    <div className="loc-model-view-controls" aria-label="Camera controls">
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-in" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.zoomIn()}>Zoom in</button>
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-out" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.zoomOut()}>Zoom out</button>
      <span data-testid="location-room-reset-view"><button type="button" className="btn btn-secondary" data-testid="location-model-reset-view" disabled={!viewerReady || showFallback} onClick={() => viewer.current?.resetCamera()}>Reset view</button></span>
      {(state === 'error' || furnitureError) && <span data-testid="location-room-preview-retry"><button type="button" className="btn btn-ghost" data-testid="location-model-preview-retry" onClick={() => viewerError ? retryViewer() : onRetry()}>Retry 3D preview</button></span>}
      {showError && <span data-testid="location-room-preview-use-2d"><button type="button" className="btn btn-secondary" data-testid="location-model-use-2d" onClick={onUse2d}>Use 2D editor</button></span>}
    </div>
    <p className={`loc-model-preview-status ${state === 'error' || furnitureError || stale || empty ? 'is-error' : ''}`} role={state === 'error' || furnitureError || stale || empty ? 'alert' : 'status'} aria-live="polite" data-testid="location-room-preview-status">{status}</p>
    <SceneLegend scene={scene} />
  </section>;
}

/** Readable text alternative to the preview geometry and private sensor poses. */
function SceneLegend({ scene }: { scene: FurniturePreviewScene }) {
  return <div className="loc-model-scene-list" aria-label="3D preview objects" data-testid="location-room-preview-object-list">
    <h3>Room objects</h3>
    {!scene.tables.length && !scene.sensors.length && <p>No tables or placed sensors yet. Add them in the 2D layout and Sensors steps.</p>}
    <ul>{scene.tables.map((table) => <li key={table.id}><b>{table.name}</b> · {table.kind} · {table.seats.length} seats
      {table.furniture?.table && <span> · shared table model assigned</span>}{table.furniture?.chair && <span> · chair model assigned to all seats</span>}
      {table.seats.length > 0 && <ul>{table.seats.map((seat) => <li key={seat.id}>Seat {seat.id}</li>)}</ul>}
    </li>)}{scene.sensors.map((sensor) => <li key={sensor.uid}><b>{sensor.label}</b> · {sensor.position.y.toFixed(2)} m high · yaw {(sensor.yawRad * 180 / Math.PI).toFixed(1)}°</li>)}</ul>
  </div>;
}

/** 2D equivalent shown for explicit 2D mode, legacy-static, or viewer failure. */
function FloorGeometryFallback({ scene }: { scene: FurniturePreviewScene }) {
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
