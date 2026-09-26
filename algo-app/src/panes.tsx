/**
 * Draggable dividers between the panes.
 *
 * The three columns and the output strip are all things people want at
 * different sizes depending on what they are doing: wide canvas while wiring
 * the graph up, tall output while staring at a thermal frame. So the sizes
 * are theirs to set, remembered per browser, and a double-click on a divider
 * puts one back.
 *
 * Sizes live in localStorage because they are a per-viewer convenience and
 * nothing else: losing them costs a drag. Every access is guarded, since a
 * private window or blocked site data makes even reading it throw.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PaneLimits {
  min: number;
  max: number;
  /** Measured from the far edge, so the handle tracks the pointer. */
  fromEnd?: boolean;
}

function load(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(`algo.pane.${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: number): void {
  try {
    localStorage.setItem(`algo.pane.${key}`, String(Math.round(value)));
  } catch {
    /* the layout still works for this session */
  }
}

/** A size the user can drag, remembered across visits. */
export function usePaneSize(key: string, initial: number, limits: PaneLimits) {
  const [size, setSize] = useState(() => load(key, initial));
  const clamp = useCallback((v: number) => Math.min(limits.max, Math.max(limits.min, v)), [limits.min, limits.max]);

  const reset = useCallback(() => {
    setSize(initial);
    save(key, initial);
  }, [initial, key]);

  const set = useCallback((v: number) => setSize(clamp(v)), [clamp]);
  const commit = useCallback((v: number) => {
    const c = clamp(v);
    setSize(c);
    save(key, c);
  }, [clamp, key]);

  // A window that shrinks below the stored size would otherwise leave a pane
  // wider than the screen and no way to reach the divider.
  useEffect(() => {
    const onResize = () => setSize((s) => clamp(s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  return { size, set, commit, reset };
}

export function Divider({ axis, onDrag, onCommit, onNudge, onReset, label }: {
  axis: 'x' | 'y';
  /** Pointer position in client coordinates, while dragging. */
  onDrag: (clientPos: number) => void;
  onCommit: (clientPos: number) => void;
  /** Keyboard moves by a delta, not to a position: a different thing. */
  onNudge: (deltaPx: number) => void;
  onReset: () => void;
  label: string;
}) {
  const dragging = useRef(false);
  return (
    <div
      className={`divider divider-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        // Without this a drag across the flow canvas selects text and the
        // pointer changes shape halfway.
        document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        onDrag(axis === 'x' ? e.clientX : e.clientY);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing-x', 'resizing-y');
        onCommit(axis === 'x' ? e.clientX : e.clientY);
      }}
      // A divider nobody can reach with a keyboard is a divider some people
      // cannot move at all.
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onNudge(-step); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onNudge(step); }
        else if (e.key === 'Home') { e.preventDefault(); onReset(); }
      }}
    />
  );
}
