/**
 * React wrapper around <floor-viewer>, the framework-free 3D map.
 *
 * The element is kept alive across re-renders and fed attributes, because
 * reloading a 40 MB-in-memory model every time a sensor reports would be
 * absurd -- and it is also how the map used to go blank.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * The viewer and three.js are hand-written files outside the bundle, so they
 * keep their names from one deploy to the next -- and a CDN will happily hold
 * last week's copy. The server puts this build's stamp in the shell and mounts
 * the same files under it, so each build asks for a URL nothing has cached.
 */
function viewerUrl(): string {
  const stamp = document.querySelector('meta[name="build"]')?.getAttribute('content');
  return stamp && /^[0-9a-f]{6,}$/.test(stamp) ? `/vendor/v${stamp}/floor-viewer.js` : '/vendor/floor-viewer.js';
}

interface ViewerElement extends HTMLElement {
  resetView?: () => void;
  zoomToSeat?: () => void;
  setZoom?: (t: number) => void;
  getZoom?: () => number;
}

export interface FloorViewerProps {
  src: string;
  room: string;
  columns: number;
  rows: number;
  /** Table names, in the same walk order the plan uses. */
  labels: string[];
  /** 1-based indices, comma separated. */
  free: string;
  occupied: string;
  dark: string;
  /** 1-based index of the table the student picked, or 0. */
  selected: number;
  directions: boolean;
  onPick: (index: number) => void;
}

export default function FloorViewer(props: FloorViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const el = useRef<ViewerElement | null>(null);
  const [zoom, setZoom] = useState(0.5);

  useEffect(() => {
    // The custom element is loaded on demand: the 3D map is one screen, and
    // three.js has no business in the first load of the others.
    void import(/* @vite-ignore */ viewerUrl()).catch(() => undefined);
    if (!el.current) {
      el.current = document.createElement('floor-viewer') as ViewerElement;
      el.current.style.width = '100%';
      el.current.style.height = '100%';
    }
    const node = el.current;
    host.current?.appendChild(node);
    const onPicked = (e: Event) => props.onPick((e as CustomEvent<{ index: number }>).detail.index);
    node.addEventListener('table-picked', onPicked);
    return () => node.removeEventListener('table-picked', onPicked);
    // props.onPick is re-created each render; the listener reads it through the closure.
  });

  // The camera also moves by wheel, by drag and by the two buttons above the
  // map, so the slider follows the camera rather than pretending to own it.
  useEffect(() => {
    const id = setInterval(() => {
      const now = el.current?.getZoom?.();
      if (typeof now === 'number' && Number.isFinite(now)) {
        const clamped = Math.min(1, Math.max(0, now));
        setZoom((prev) => (Math.abs(prev - clamped) > 0.01 ? clamped : prev));
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    node.setAttribute('src', props.src);
    node.setAttribute('room', props.room);
    node.setAttribute('columns', String(props.columns));
    node.setAttribute('rows', String(props.rows));
    node.setAttribute('labels', props.labels.join('|'));
    node.setAttribute('free', props.free);
    node.setAttribute('occupied', props.occupied);
    node.setAttribute('dark', props.dark);
    node.setAttribute('selected', String(props.selected));
    node.setAttribute('directions', props.directions ? '1' : '0');
  }, [props.src, props.room, props.columns, props.rows, props.labels, props.free, props.occupied, props.dark, props.selected, props.directions]);

  return (
    <div className="viewer-host">
      <div className="viewer-canvas" ref={host} />
      <label className="zoom">
        <span className="sr-only">Zoom</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={zoom}
          onChange={(e) => {
            const t = Number(e.target.value);
            setZoom(t);
            el.current?.setZoom?.(t);
          }}
        />
      </label>
    </div>
  );
}
