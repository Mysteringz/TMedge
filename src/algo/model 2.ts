/**
 * The learned thermal locator: inference only.
 *
 * Trained off the box by `tools/train_human_location.py`, which reads the
 * RGB/thermal pairs the recorder collected, finds people in the RGB with
 * ordinary computer vision, and fits these weights so the thermal frame
 * alone predicts where they were. What arrives here is a few dozen numbers,
 * so running it costs nothing and adds no dependency: the model is applied
 * per pixel with arithmetic this file can do on its own.
 *
 * Deliberately a small, legible model rather than a network. With a corpus
 * measured in thousands of frames from one room, a large model would mostly
 * memorise that room, and nobody could say why it answered as it did -- which
 * is the opposite of what this dashboard is for. Logistic regression over
 * local thermal features can be read, argued with, and beaten later.
 */
import { GRID_H, GRID_W } from '../shared/geometry.js';

/** The features, in the order the weights expect. Append, never reorder. */
export const FEATURES = ['bias', 'above_median', 'local_max3', 'local_mean5', 'gradient', 'row', 'col'] as const;
export type FeatureName = (typeof FEATURES)[number];

export interface LocatorModel {
  version: 1;
  uid: string;
  trainedAt: number;
  /** How many paired frames it was fitted on, and how many held people. */
  samples: number;
  positives: number;
  features: FeatureName[];
  weights: number[];
  /** Probability above which a pixel is called person. */
  threshold: number;
  /** Connected pixels needed before a blob is reported. */
  minArea: number;
  /** Held-out scores, so the node can show what it is worth. */
  metrics: { precision: number; recall: number; f1: number; heldOut: number; medianErrorPx: number };
  notes?: string;
}

export interface MlDetection {
  x: number;
  y: number;
  area: number;
  /** Mean probability over the blob. */
  confidence: number;
}

export function isModel(v: unknown): v is LocatorModel {
  const m = v as LocatorModel;
  return !!m && m.version === 1 && Array.isArray(m.weights) && Array.isArray(m.features)
    && m.weights.length === m.features.length && typeof m.threshold === 'number';
}

/**
 * numpy's default percentile, to the letter: rank q*(n-1), interpolated
 * between its neighbours. The trainer is numpy and the weights it fits are
 * scaled by these two numbers, so "near enough" here would quietly mean the
 * edge applies the model to differently-scaled features. A test compares the
 * two implementations on a real frame.
 */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const frac = pos - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

/**
 * Per-pixel features from one frame. No background model and no history: the
 * point of this path is to see whether a single frame carries enough to place
 * people, which is the thing the firmware's detector cannot do.
 */
export function featuresOf(temps: Float32Array | number[]): Float32Array {
  const n = GRID_W * GRID_H;
  const at = (x: number, y: number) => (temps[Math.min(GRID_H - 1, Math.max(0, y)) * GRID_W + Math.min(GRID_W - 1, Math.max(0, x))] ?? 0);
  const sorted = Array.from(temps as ArrayLike<number>).sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const spread = Math.max(0.2, quantile(sorted, 0.95) - quantile(sorted, 0.05));

  const out = new Float32Array(n * FEATURES.length);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      const t = at(x, y);
      let max3 = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) max3 = Math.max(max3, at(x + dx, y + dy));
      let sum5 = 0, cells = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { sum5 += at(x + dx, y + dy); cells++; }
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const f = i * FEATURES.length;
      out[f] = 1;                                     // bias
      out[f + 1] = (t - median) / spread;             // above_median
      out[f + 2] = (max3 - median) / spread;          // local_max3
      out[f + 3] = (t - sum5 / cells) / spread;       // local_mean5
      out[f + 4] = Math.hypot(gx, gy) / spread;       // gradient
      out[f + 5] = y / GRID_H - 0.5;                  // row
      out[f + 6] = x / GRID_W - 0.5;                  // col
    }
  }
  return out;
}

/** Probability per pixel, 0..1. */
export function probabilities(model: LocatorModel, temps: Float32Array | number[]): Float32Array {
  const f = featuresOf(temps);
  const k = model.features.length;
  const p = new Float32Array(GRID_W * GRID_H);
  for (let i = 0; i < p.length; i++) {
    let z = 0;
    for (let j = 0; j < k; j++) z += (model.weights[j] ?? 0) * (f[i * k + j] ?? 0);
    p[i] = 1 / (1 + Math.exp(-z));
  }
  return p;
}

/** Threshold the map, group what is left, and call each group a person. */
export function locate(model: LocatorModel, temps: Float32Array | number[]): { detections: MlDetection[]; probs: Float32Array } {
  const probs = probabilities(model, temps);
  const seen = new Int8Array(probs.length);
  const detections: MlDetection[] = [];
  for (let i = 0; i < probs.length; i++) {
    if (seen[i] || (probs[i] ?? 0) < model.threshold) continue;
    // Flood fill, 8-connected, iterative: the grid is small but recursion in
    // a server process is a poor bet either way.
    const stack = [i];
    const cells: number[] = [];
    seen[i] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      cells.push(c);
      const cx = c % GRID_W, cy = Math.floor(c / GRID_W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const ni = ny * GRID_W + nx;
          if (seen[ni] || (probs[ni] ?? 0) < model.threshold) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (cells.length < model.minArea) continue;
    let sx = 0, sy = 0, sw = 0;
    for (const c of cells) {
      const w = probs[c] ?? 0;
      sx += (c % GRID_W) * w;
      sy += Math.floor(c / GRID_W) * w;
      sw += w;
    }
    detections.push({
      x: sx / sw, y: sy / sw, area: cells.length,
      confidence: Math.round((sw / cells.length) * 100) / 100,
    });
  }
  return { detections, probs };
}
