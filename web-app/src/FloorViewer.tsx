/**
 * React boundary for the framework-free Three.js element. Parent: `Spaces`;
 * legacy venues pass mesh-order labels while published descriptors pass a
 * stable-ID floor layout and the shared root-transform convention.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { modelTransformToWorld, type LocationModelTransformInput, type LocationWorldTransform } from '../../src/shared/location-view.js';
import {
  projectSimpleRoomPoint,
  projectSimpleRoomSeat,
  projectSimpleRoomTable,
  SIMPLE_ROOM_SOURCE,
  type SimpleRoomTableFootprint,
} from '../../src/shared/simple-room-geometry.js';
import type { CampusFloor, FurnitureAssignment, SeatSide } from '../../src/shared/types.js';

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

export interface FloorViewerProps {
  src: string | null;
  source: 'generated' | 'custom' | 'legacy' | '2d' | 'none';
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
  floor?: CampusFloor;
  selectedTableId?: string | null;
  locationTransform?: LocationModelTransformInput;
  onPickTable?: (tableId: string) => void;
  retryRequest: number;
  onFailure: () => void;
  onRecovered: () => void;
}

interface ProjectedSeat {
  id: string;
  x: number;
  z: number;
  side: SeatSide;
  occupied: boolean | null;
}

interface ProjectedTable {
  id: string;
  name: string;
  footprint: SimpleRoomTableFootprint;
  status: 'free' | 'full' | 'unknown';
  seats: ProjectedSeat[];
  furniture?: {
    table?: FurnitureAssignment;
    chair?: FurnitureAssignment;
  };
}

interface ProjectedStudentLayout {
  widthM: number;
  depthM: number;
  stale: boolean;
  selectedTableId: string | null;
  tables: ProjectedTable[];
}

export default function FloorViewer(props: FloorViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<ViewerElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [zoom, setZoom] = useState(0.5);
  const [loadError, setLoadError] = useState<'viewer' | 'model' | null>(null);
  const loadErrorRef = useRef(loadError);
  loadErrorRef.current = loadError;
  const [retry, setRetry] = useState(0);
  const lastRetryRequest = useRef(props.retryRequest);
  const layout = useMemo(() => props.floor ? projectStudentLayout(props.floor, props.selectedTableId ?? null) : undefined,
    [props.floor, props.selectedTableId]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    let alive = true;
    let node: ViewerElement | null = null;
    const onPicked = (event: Event) => {
      const detail = (event as CustomEvent<{ index?: number; tableId?: string }>).detail;
      if (typeof detail.tableId === 'string') propsRef.current.onPickTable?.(detail.tableId);
      else if (typeof detail.index === 'number') propsRef.current.onPick(detail.index);
    };
    const onViewerError = () => {
      if (!alive) return;
      setLoadError('viewer');
      propsRef.current.onFailure();
    };
    const onModelError = () => {
      if (!alive) return;
      setLoadError('model');
      propsRef.current.onFailure();
    };
    const onModelReady = () => {
      if (!alive) return;
      setLoadError(null);
      propsRef.current.onRecovered();
    };
    void import(/* @vite-ignore */ viewerUrl(retry)).then(() => {
      if (!alive || !host.current) return;
      node = document.createElement('floor-viewer') as ViewerElement;
      node.style.width = '100%';
      node.style.height = '100%';
      node.addEventListener('table-picked', onPicked);
      node.addEventListener('viewer-error', onViewerError);
      node.addEventListener('viewer-ready', onModelReady);
      node.addEventListener('model-error', onModelError);
      node.addEventListener('model-ready', onModelReady);
      host.current.appendChild(node);
      element.current = node;
      setLoadError(null);
      syncAttributes(node, propsRef.current, layoutRef.current);
    }).catch(() => {
      if (!alive) return;
      setLoadError('viewer');
      propsRef.current.onFailure();
    });
    return () => {
      alive = false;
      if (node) {
        node.removeEventListener('table-picked', onPicked);
        node.removeEventListener('viewer-error', onViewerError);
        node.removeEventListener('viewer-ready', onModelReady);
        node.removeEventListener('model-error', onModelError);
        node.removeEventListener('model-ready', onModelReady);
        node.remove();
      }
      if (element.current === node) element.current = null;
    };
  }, [retry]);

  useEffect(() => {
    if (element.current) syncAttributes(element.current, props, layout);
  }, [props, layout]);

  useEffect(() => { setLoadError(null); }, [props.source, props.src]);

  useEffect(() => {
    if (lastRetryRequest.current === props.retryRequest) return;
    lastRetryRequest.current = props.retryRequest;
    setLoadError(null);
    if (loadErrorRef.current === 'viewer' || !element.current) setRetry((value) => value + 1);
    else element.current.retryLoad?.();
  }, [props.retryRequest]);

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

  return (
    <div className="viewer-host" data-testid={props.source === 'generated' ? 'student-simple-room-viewer' : undefined}>
      <div data-testid="student-model-viewer-canvas" className="viewer-canvas" ref={host}
        aria-label={props.source === 'generated' ? 'Interactive 3D built-in room view' : 'Interactive 3D location model'} />
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

function syncAttributes(node: ViewerElement, props: FloorViewerProps, layout: ProjectedStudentLayout | undefined): void {
  if (props.source === 'generated') node.setAttribute('procedural-room', SIMPLE_ROOM_SOURCE);
  else node.removeAttribute('procedural-room');
  if (layout && (props.source === 'generated' || props.source === 'custom')) {
    node.setAttribute('location-layout', JSON.stringify(layout));
  } else {
    node.removeAttribute('location-layout');
  }
  if (props.source === 'generated' || !props.src) node.removeAttribute('src');
  else node.setAttribute('src', props.src);
  for (const [name, value] of Object.entries({
    room: props.room, columns: String(props.columns), rows: String(props.rows),
    labels: props.labels.join('|'), free: props.free, occupied: props.occupied, dark: props.dark,
    selected: String(props.selected), directions: props.directions ? '1' : '0',
  })) node.setAttribute(name, value);
  if (layout && props.source === 'custom' && props.locationTransform) {
    node.setAttribute('model-transform', JSON.stringify(toViewerTransform(props.locationTransform)));
  } else {
    node.removeAttribute('model-transform');
  }
}

function toViewerTransform(value: LocationModelTransformInput): LocationWorldTransform {
  return modelTransformToWorld(value);
}

function projectStudentLayout(floor: CampusFloor, selectedTableId: string | null): ProjectedStudentLayout {
  const roomCorner = projectSimpleRoomPoint({ x: floor.width, y: floor.height });
  return {
    widthM: Math.abs(roomCorner.x),
    depthM: Math.abs(roomCorner.z),
    stale: floor.stale,
    selectedTableId,
    tables: floor.tables.map((table) => {
      const tableFurniture = table.furnitureOverrides?.table ?? floor.furnitureDefaults?.table;
      const chairFurniture = table.furnitureOverrides?.chair ?? floor.furnitureDefaults?.chair;
      const furniture = tableFurniture || chairFurniture
        ? { ...(tableFurniture ? { table: tableFurniture } : {}), ...(chairFurniture ? { chair: chairFurniture } : {}) }
        : undefined;
      return {
        id: table.id,
        name: table.name,
        footprint: projectSimpleRoomTable({ shape: table.shape, rect: table.rect }),
        status: floor.stale || table.status === 'unknown' || table.free === null
          ? 'unknown'
          : table.free > 0 ? 'free' : 'full',
        seats: table.seats.map((seat) => {
          const point = projectSimpleRoomSeat(seat);
          return { id: seat.id, x: point.x, z: point.z, side: seat.side, occupied: floor.stale ? null : seat.occupied };
        }),
        ...(furniture ? { furniture } : {}),
      };
    }),
  };
}
