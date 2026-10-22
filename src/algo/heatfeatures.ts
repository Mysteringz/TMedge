/**
 * What the thermal people detector sees: three channels per 24x32 frame.
 *
 *   c0  frame - its own median       where it is warm at all
 *   c1  frame - the edge background  what is not part of the room (staticbg.ts)
 *   c2  frame - the last 5 minutes   what changed recently: an arrival is
 *                                    positive, a chair cooling after someone
 *                                    left is negative
 *
 * All in C, clipped, divided by 4. c2 is a median over 30-second slices *by
 * time*, so it means the same whether a node sends one frame a second, one
 * every few seconds or four a second; until three slices exist it is 0. With
 * no background there are no features, and so no detections: the node is
 * not-ready, never empty.
 *
 * The detector is trained in Python on tools/thermalml/features.py, and
 * test/thermalml.test.ts fails if that and this disagree -- a model fed
 * different numbers on the edge than in training would be wrong in ways no
 * metric would show.
 */
import { GRID_SIZE } from '../edge/protocol.js';
import { median } from '../edge/staticbg.js';

export const SLICE_MS = 30_000;
export const WINDOW_SLICES = 10;
export const MIN_SLICES = 3;
const MAX_PER_SLICE = 120;
const SCALE = 4;
const CLIP: Record<'c0' | 'c1' | 'c2', [number, number]> = { c0: [-4, 12], c1: [-4, 12], c2: [-6, 6] };

/** Per-pixel median of n rows of 768 (as staticbg's bucket median: float32 sort, middle two averaged). */
function columnMedian(rows: Float32Array[]): Float32Array {
  const out = new Float32Array(GRID_SIZE);
  const column = new Float32Array(rows.length);
  for (let p = 0; p < GRID_SIZE; p++) {
    for (let r = 0; r < rows.length; r++) column[r] = rows[r]?.[p] ?? 0;
    out[p] = median(column);
  }
  return out;
}

/** Per-pixel median of (frame - frame median) over the last 5 minutes, from closed 30 s slices. */
export class RecentMedian {
  private start: number | null = null;
  private rows: Float32Array[] = [];
  private slices: { start: number; rel: Float32Array }[] = [];

  add(temps: ArrayLike<number>, at: number): void {
    if (!Number.isFinite(at) || temps.length !== GRID_SIZE || !Array.from(temps).every(Number.isFinite)) return;
    const start = Math.floor(at / SLICE_MS) * SLICE_MS;
    if (this.start !== null && this.start !== start) {
      if (this.rows.length) this.slices.push({ start: this.start, rel: columnMedian(this.rows) });
      this.start = null;
      this.rows = [];
    }
    this.slices = this.slices.filter((s) => s.start >= at - WINDOW_SLICES * SLICE_MS);
    if (this.start === null) this.start = start;
    if (this.rows.length < MAX_PER_SLICE) {
      const level = median(temps);
      const rel = new Float32Array(GRID_SIZE);
      for (let p = 0; p < GRID_SIZE; p++) rel[p] = (temps[p] ?? level) - level;
      this.rows.push(rel);
    }
  }

  recent(): Float32Array | null {
    return this.slices.length < MIN_SLICES ? null : columnMedian(this.slices.map((s) => s.rel));
  }
}

const clip = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v)) / SCALE;

/** (3 x 768) channel-major features for one frame, or null when there is no background. */
export function heatFeatures(temps: ArrayLike<number>, background: ArrayLike<number> | null, recent: ArrayLike<number> | null): Float32Array | null {
  if (!background) return null;
  const level = median(temps);
  const out = new Float32Array(3 * GRID_SIZE);
  for (let p = 0; p < GRID_SIZE; p++) {
    const t = temps[p] ?? level;
    out[p] = clip(t - level, CLIP.c0);
    out[GRID_SIZE + p] = clip(t - (background[p] ?? t), CLIP.c1);
    out[2 * GRID_SIZE + p] = recent ? clip(t - level - (recent[p] ?? 0), CLIP.c2) : 0;
  }
  return out;
}
