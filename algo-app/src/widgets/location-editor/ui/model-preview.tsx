import { useEffect, useMemo, useRef, useState } from 'react';
import { readDraftModel } from '../../../entities/location-config/index.ts';
import type { AssetCapability, DraftDetail, LocationDocument, ModelTransform } from '../../../entities/location-config/index.ts';
import { modelRootTransform, modelSceneFromDocument } from '../../../features/location-editor/index.ts';
import { ensureLocationModelViewer, type LocationModelViewerElement } from '../model-viewer-loader.ts';

type PreviewState = 'loading' | 'loaded' | 'error' | 'empty';

/** Authenticated model preview with authored overlays; the parent owns document state and upload/save actions.
 * @example <ModelPreview draft={draft} document={document} onRetry={() => setRetry((n) => n + 1)} />
 */
export function ModelPreview({ draft, document, capability, retry, onRetry }: {
  draft: DraftDetail; document: LocationDocument; capability?: AssetCapability; retry: number; onRetry(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<LocationModelViewerElement | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [moduleRetry, setModuleRetry] = useState(0);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [state, setState] = useState<PreviewState>(document.modelAssetId ? 'loading' : 'empty');
  const [message, setMessage] = useState('');
  const scene = useMemo(() => modelSceneFromDocument(document), [document.widthCm, document.heightCm, document.tables, document.sensorAssignments]);
  const transform = useMemo(() => modelRootTransform(document.modelTransform ?? defaultTransform()), [document.modelTransform]);
  const onViewerState = (event: Event) => {
    const detail = (event as CustomEvent<{ state: string; message: string }>).detail;
    if (!detail) return;
    if (detail.state === 'error' && /3d preview could not be started/i.test(detail.message)) {
      setState('error');
      setMessage(detail.message);
      setViewerError('The 3D preview could not be started in this browser. Retry the viewer.');
      return;
    }
    setState(detail.state === 'loaded' ? 'loaded' : detail.state === 'error' ? 'error' : 'loading');
    setMessage(detail.message);
  };

  useEffect(() => {
    let active = true;
    setViewerReady(false);
    setViewerError('');
    const element = host.current;
    if (!element) return () => { active = false; };
    void ensureLocationModelViewer().then(() => {
      if (!active) return;
      const customElement = globalThis.document.createElement('tm-location-model-viewer');
      viewer.current = customElement;
      customElement.addEventListener('location-model-state', onViewerState);
      // Register before connection; connectedCallback may synchronously report
      // a renderer/WebGL startup failure.
      element.replaceChildren(customElement);
      setViewerReady(true);
    }).catch(() => { if (active) setViewerError('The edge-hosted 3D viewer could not be loaded. Retry the preview.'); });
    return () => {
      active = false;
      viewer.current?.removeEventListener('location-model-state', onViewerState);
      viewer.current?.remove();
      viewer.current = null;
    };
  }, [moduleRetry]);

  useEffect(() => {
    const assetId = document.modelAssetId;
    if (!assetId) { setBuffer(null); setState('empty'); setMessage('No GLB selected. Authored floor overlays remain in the preview.'); return; }
    if (capability?.source !== 'upload' || !capability.previewAvailable) {
      setBuffer(null); setState('error'); setMessage('This model cannot be previewed through the current private draft.'); return;
    }
    const controller = new AbortController();
    let active = true;
    setBuffer(null); setState('loading'); setMessage('Loading the authorized private GLB preview.');
    void readDraftModel(draft.draftId, assetId, controller.signal).then((bytes) => {
      if (!active) return;
      setBuffer(bytes);
    }).catch(() => {
      if (active) { setState('error'); setMessage('The private model preview could not be loaded. The draft reference is preserved.'); }
    });
    return () => { active = false; controller.abort(); };
  }, [draft.draftId, document.modelAssetId, capability?.source, capability?.previewAvailable, retry]);

  useEffect(() => { if (viewerReady) viewer.current?.setFloor(scene); }, [viewerReady, scene]);
  useEffect(() => { if (viewerReady) viewer.current?.setTransform(transform); }, [viewerReady, transform]);
  useEffect(() => {
    if (!viewerReady || !buffer) return;
    setState('loading');
    void viewer.current?.loadModel(buffer);
  }, [viewerReady, buffer]);

  return <section className="loc-model-preview-panel" aria-label="3D model preview">
    <div className="loc-model-viewer-frame" aria-busy={state === 'loading'}>
      {viewerError && <p className="loc-alert" role="alert">{viewerError}</p>}
      <div className="loc-model-viewer" ref={host} role="img" aria-label="3D location preview. Table and sensor overlays stay fixed while the GLB alignment changes."
        aria-hidden={viewerError ? true : undefined} hidden={!!viewerError} data-testid="location-model-viewer" />
    </div>
    <div className="loc-model-view-controls" aria-label="Camera controls">
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-in" disabled={!viewerReady} onClick={() => viewer.current?.zoomIn()}>Zoom in</button>
      <button type="button" className="btn btn-secondary" data-testid="location-model-zoom-out" disabled={!viewerReady} onClick={() => viewer.current?.zoomOut()}>Zoom out</button>
      <button type="button" className="btn btn-secondary" data-testid="location-model-reset-view" disabled={!viewerReady} onClick={() => viewer.current?.resetCamera()}>Reset view</button>
      {state === 'error' && <button type="button" className="btn btn-ghost" data-testid="location-model-preview-retry" onClick={onRetry}>Retry preview</button>}
      {viewerError && <button type="button" className="btn btn-ghost" data-testid="location-model-viewer-retry" onClick={() => { setViewerReady(false); setModuleRetry((value) => value + 1); }}>Retry viewer</button>}
    </div>
    <p className={`loc-model-preview-status ${state === 'error' ? 'is-error' : ''}`} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">{message}</p>
    <SceneLegend document={document} scene={scene} />
  </section>;
}

/** Text equivalent of the preview overlays, preserving stable table and seat labels. */
function SceneLegend({ document, scene }: { document: LocationDocument; scene: ReturnType<typeof modelSceneFromDocument> }) {
  return <div className="loc-model-scene-list" aria-label="3D preview objects">
    <h3>Authored floor overlays</h3>
    {!scene.tables.length && !scene.sensors.length && <p>No tables or placed sensors in this draft.</p>}
    <ul>{scene.tables.map((table, index) => {
      const source = document.tables[index];
      return <li key={table.id}><b>{table.name}</b> · {source?.shape?.type ?? 'legacy rectangle'} · {table.seats.length} seats
        {table.seats.length > 0 && <ul>{table.seats.map((seat) => <li key={seat.id}>Seat {seat.id}</li>)}</ul>}
      </li>;
    })}{scene.sensors.map((sensor, index) => <li key={`${sensor.label}:${index}`}><b>{sensor.label}</b> · current draft pose marker</li>)}</ul>
  </div>;
}

function defaultTransform(): ModelTransform {
  return { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } };
}
