/**
 * React boundary for the framework-free Three.js element. Parent: `Spaces`;
 * legacy venues pass mesh-order labels while published descriptors pass a
 * stable-ID floor layout and the shared root-transform convention.
 */
import { useEffect, useRef, useState } from 'react';
import { modelTransformToWorld, type LocationModelTransformInput, type LocationWorldTransform } from '../../src/shared/location-view.js';
import type { TableState } from '../../src/shared/types.js';

function viewerUrl(retry: number): string {
  const stamp = document.querySelector('meta[name="build"]')?.getAttribute('content');
  const path = stamp && /^[0-9a-f]{6,}$/.test(stamp) ? `/vendor/v${stamp}/floor-viewer.js` : '/vendor/floor-viewer.js';
  return retry ? `${path}?retry=${retry}` : path;
}

interface ViewerElement extends HTMLElement {
  resetView?: () => void;
  zoomToSeat?: () => void;
  setZoom?: (t: number) => void;
  getZoom?: () => number;
  retryLoad?: () => void;
}

export interface AuthoredViewerLayout {
  width: number;
  height: number;
  tables: TableState[];
  selectedTableId: string | null;
}

export interface FloorViewerProps {
  src: string;
  room: string;
  columns: number;
  rows: number;
  labels: string[];
  free: string;
  occupied: string;
  dark: string;
  selected: number;
  directions: boolean;
  onPick: (index: number) => void;
  locationLayout?: AuthoredViewerLayout;
  locationTransform?: LocationModelTransformInput;
  onPickTable?: (tableId: string) => void;
}

export default function FloorViewer(props: FloorViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<ViewerElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [zoom, setZoom] = useState(0.5);
  const [loadError, setLoadError] = useState<'viewer' | 'model' | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    let node: ViewerElement | null = null;
    const onPicked = (event: Event) => {
      const detail = (event as CustomEvent<{ index?: number; tableId?: string }>).detail;
      if (typeof detail.tableId === 'string') propsRef.current.onPickTable?.(detail.tableId);
      else if (typeof detail.index === 'number') propsRef.current.onPick(detail.index);
    };
    const onModelError = () => setLoadError('model');
    const onModelReady = () => setLoadError(null);
    void import(/* @vite-ignore */ viewerUrl(retry)).then(() => {
      if (!alive || !host.current) return;
      node = document.createElement('floor-viewer') as ViewerElement;
      node.style.width = '100%';
      node.style.height = '100%';
      node.addEventListener('table-picked', onPicked);
      node.addEventListener('model-error', onModelError);
      node.addEventListener('model-ready', onModelReady);
      host.current.appendChild(node);
      element.current = node;
      setLoadError(null);
      syncAttributes(node, propsRef.current);
    }).catch(() => { if (alive) setLoadError('viewer'); });
    return () => {
      alive = false;
      if (node) {
        node.removeEventListener('table-picked', onPicked);
        node.removeEventListener('model-error', onModelError);
        node.removeEventListener('model-ready', onModelReady);
        node.remove();
      }
      if (element.current === node) element.current = null;
    };
  }, [retry]);

  useEffect(() => {
    if (element.current) syncAttributes(element.current, props);
  }, [props.src, props.room, props.columns, props.rows, props.labels, props.free, props.occupied, props.dark,
    props.selected, props.directions, props.locationLayout, props.locationTransform]);

  useEffect(() => {
    const id = setInterval(() => {
      const current = element.current?.getZoom?.();
      if (typeof current === 'number' && Number.isFinite(current)) {
        const clamped = Math.min(1, Math.max(0, current));
        setZoom((prev) => Math.abs(prev - clamped) > 0.01 ? clamped : prev);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  const retryPreview = () => {
    setLoadError(null);
    if (loadError === 'viewer' || !element.current) setRetry((value) => value + 1);
    else element.current.retryLoad?.();
  };

  return (
    <div className="viewer-host">
      <div data-testid="student-model-viewer-canvas" className="viewer-canvas" ref={host} aria-label="Interactive 3D location model" />
      {loadError && <div className="viewer-error" role="status">
        <span>3D view unavailable. Use the floor map below.</span>
        <button type="button" data-testid="student-model-preview-retry" className="btn btn-secondary" onClick={retryPreview}>Try again</button>
      </div>}
      <label className="zoom">
        <span className="sr-only">Zoom</span>
        <input data-testid="student-model-zoom-control" type="range" min={0} max={1} step={0.01} value={zoom} onChange={(event) => {
          const value = Number(event.target.value);
          setZoom(value);
          element.current?.setZoom?.(value);
        }} />
      </label>
    </div>
  );
}

function syncAttributes(node: ViewerElement, props: FloorViewerProps): void {
  for (const [name, value] of Object.entries({
    src: props.src, room: props.room, columns: String(props.columns), rows: String(props.rows),
    labels: props.labels.join('|'), free: props.free, occupied: props.occupied, dark: props.dark,
    selected: String(props.selected), directions: props.directions ? '1' : '0',
  })) node.setAttribute(name, value);
  if (props.locationLayout && props.locationTransform) {
    node.setAttribute('location-layout', JSON.stringify(props.locationLayout));
    node.setAttribute('model-transform', JSON.stringify(toViewerTransform(props.locationTransform)));
  } else {
    node.removeAttribute('location-layout');
    node.removeAttribute('model-transform');
  }
}

function toViewerTransform(value: LocationModelTransformInput): LocationWorldTransform {
  return modelTransformToWorld(value);
}
