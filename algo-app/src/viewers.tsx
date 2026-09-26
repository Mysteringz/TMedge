/**
 * The standard viewers. A node says what type its output is and the right one
 * is chosen here, so a new stage gets a debug view without any UI work --
 * which is the only way a node library stays cheap to extend.
 */
import { useEffect, useRef } from 'react';
import { unpack } from './api.ts';

const W = 32;
const H = 24;

/** Inferno-ish ramp: dark for cold, white-hot for people. */
function heatColour(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  const stops: [number, [number, number, number]][] = [
    [0.0, [10, 8, 30]], [0.25, [70, 20, 100]], [0.5, [165, 45, 85]],
    [0.75, [235, 120, 40]], [1.0, [255, 245, 200]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i] as [number, [number, number, number]];
    const [p0, c0] = stops[i - 1] as [number, [number, number, number]];
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return [255, 245, 200];
}

export interface Blob {
  id: number; x: number; y: number; area: number;
  contrast: number; peak: number; heat: number; confidence?: number;
}

export function GridView({ pixels, colour = 'heat', blobs, observed, scale = 16, labelled, mirror = false }: {
  pixels: Uint8Array | null;
  colour?: 'heat' | 'mask' | 'grey' | 'label';
  blobs?: Blob[];
  observed?: Blob[];
  scale?: number;
  labelled?: boolean;
  /** The sensor is mounted left-right reversed; show the room, not the sensor. */
  mirror?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    if (pixels) {
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const v = (pixels[i] ?? 0) / 255;
        let rgb: [number, number, number];
        if (colour === 'mask') rgb = v > 0 ? [11, 139, 122] : [22, 22, 26];
        else if (colour === 'grey') rgb = [v * 255, v * 255, v * 255];
        else if (colour === 'label') {
          const id = pixels[i] ?? 0;
          rgb = id === 0 ? [22, 22, 26] : hue((id * 67) % 360);
        } else rgb = heatColour(v);
        img.data[i * 4] = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      tmp.getContext('2d')?.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, c.width, c.height);
    }
    // What the sensor itself said, so the two can be compared at a glance.
    for (const b of observed ?? []) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect((b.x - 1.5) * scale, (b.y - 1.5) * scale, 3 * scale, 3 * scale);
      ctx.setLineDash([]);
    }
    for (const b of blobs ?? []) {
      const r = Math.max(1.2, Math.sqrt(b.area / Math.PI));
      ctx.strokeStyle = '#0b8b7a';
      ctx.lineWidth = 2;
      ctx.strokeRect((b.x - r) * scale, (b.y - r) * scale, r * 2 * scale, r * 2 * scale);
      ctx.fillStyle = '#0b8b7a';
      ctx.beginPath();
      ctx.arc(b.x * scale, b.y * scale, 3, 0, Math.PI * 2);
      ctx.fill();
      if (labelled) {
        // Text must not be mirrored with the picture it labels.
        ctx.save();
        if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        ctx.fillStyle = '#e9e7e4';
        ctx.font = '11px ui-monospace, monospace';
        const lx = mirror ? c.width - (b.x + r) * scale - 22 : (b.x + r) * scale + 3;
        ctx.fillText(`#${b.id}`, lx, b.y * scale);
        ctx.restore();
      }
    }
    ctx.restore();
  }, [pixels, colour, blobs, observed, scale, labelled, mirror]);
  return <canvas ref={ref} width={W * scale} height={H * scale} className="grid-canvas" />;
}

function hue(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (0.6 - 0.35 * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1)));
  };
  return [f(0), f(8), f(4)];
}

export function Plane({ data, colour, blobs, observed, labelled, mirror }: {
  data: { pixels: string; min?: number; max?: number } | null;
  colour?: 'heat' | 'mask' | 'grey' | 'label';
  blobs?: Blob[];
  observed?: Blob[];
  labelled?: boolean;
  mirror?: boolean;
}) {
  if (!data) return <div className="empty">no data for this frame</div>;
  return (
    <div>
      <GridView pixels={unpack(data.pixels)} colour={colour} blobs={blobs} observed={observed} labelled={labelled} mirror={mirror} />
      {data.min !== undefined && data.max !== undefined && (
        <div className="scale">{data.min.toFixed(2)} → {data.max.toFixed(2)}</div>
      )}
    </div>
  );
}

export function Histogram({ bins, min, max }: { bins: number[]; min: number; max: number }) {
  const peak = Math.max(1, ...bins);
  return (
    <div>
      <div className="hist">
        {bins.map((v, i) => (
          <div key={i} className="hist-bar" style={{ height: `${(v / peak) * 100}%` }} title={`${v} px`} />
        ))}
      </div>
      <div className="scale">{min.toFixed(1)} °C → {max.toFixed(1)} °C</div>
    </div>
  );
}

export interface HeatJson { cellCm: number; cols: number; rows: number; max: number; cells: number[] }

/** The floor: dwell underneath, tables and people on top. */
export function PlanView({ heat, tables, candidates, points, width, height, clusters }: {
  heat?: HeatJson | null;
  tables?: { id: string; x: number; y: number; width: number; height: number; status?: string; occupied?: number | null }[];
  candidates?: { id: string; x: number; y: number; width: number; height: number; confidence: number; selected: boolean }[];
  points?: { id: number; x: number; y: number }[];
  clusters?: { x: number; y: number; weight: number }[];
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scale = Math.min(720 / Math.max(1, width), 420 / Math.max(1, height));
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.fillStyle = '#16161a';
    ctx.fillRect(0, 0, c.width, c.height);
    if (heat && heat.max > 0) {
      for (let r = 0; r < heat.rows; r++) {
        for (let col = 0; col < heat.cols; col++) {
          const v = (heat.cells[r * heat.cols + col] ?? 0) / heat.max;
          if (v <= 0.01) continue;
          const [rr, gg, bb] = heatColour(v);
          ctx.fillStyle = `rgba(${rr},${gg},${bb},${0.25 + v * 0.6})`;
          ctx.fillRect(col * heat.cellCm * scale, r * heat.cellCm * scale, heat.cellCm * scale, heat.cellCm * scale);
        }
      }
    }
    for (const t of tables ?? []) {
      ctx.strokeStyle = t.status === 'unknown' ? '#6b6b73' : '#9b9797';
      ctx.setLineDash(t.status === 'unknown' ? [4, 3] : []);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(t.x * scale, t.y * scale, t.width * scale, t.height * scale);
      ctx.setLineDash([]);
      ctx.fillStyle = '#c9c6c2';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(t.id, t.x * scale + 3, t.y * scale + 13);
    }
    for (const d of candidates ?? []) {
      ctx.strokeStyle = d.selected ? '#0b8b7a' : 'rgba(235,120,40,0.7)';
      ctx.setLineDash(d.selected ? [] : [5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(d.x * scale, d.y * scale, d.width * scale, d.height * scale);
      ctx.setLineDash([]);
      ctx.fillStyle = d.selected ? '#0b8b7a' : 'rgba(235,120,40,0.9)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`${d.id} ${d.confidence.toFixed(2)}`, d.x * scale + 2, d.y * scale - 3);
    }
    for (const cl of clusters ?? []) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(cl.x * scale, cl.y * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of points ?? []) {
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1b1b1f';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [heat, tables, candidates, points, clusters, scale]);
  return <canvas ref={ref} width={Math.max(1, width * scale)} height={Math.max(1, height * scale)} className="plan-canvas" />;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Table({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <div className="empty">nothing here for this frame</div>;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <table className="tbl">
      <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{cols.map((c) => <td key={c}>{fmt(r[c])}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
