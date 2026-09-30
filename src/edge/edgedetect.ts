/**
 * People from a node's RAW frames, detected here rather than on the node.
 *
 * For a node configured `"detector": "edge"` the node's own REPORT detections
 * are not used: its background forgets people who sit still (see
 * staticbg.ts). This detector subtracts the long-horizon StaticBackground
 * instead, then segments the difference the way the firmware does, with the
 * firmware's default thresholds -- threshold, 8-connected components, split at
 * the peaks of a 3x3-smoothed difference, drop blobs by area and peak -- so
 * the blobs the occupancy engine receives mean the same thing whichever side
 * found them.
 *
 * This is the edge's own detector, not a preview of the node's. The algo
 * debugger still previews `TMsense/src/tm_detector.cpp` for nodes that
 * detect on board; nothing here stands in for that file.
 */
import { GRID_SIZE, MAX_DETECTIONS, REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, REPORT_TRUNCATED, type Detection, type Raw, type Report } from './protocol.js';
import { median, StaticBackground, type StaticBackgroundState } from './staticbg.js';

const W = 32;
const H = 24;
/** Most pixels are background, so their spread is the sensor noise (MAD -> sigma). */
const MAD_TO_SIGMA = 1.4826;
/** The 8-bit serial stream steps in ~0.1 C; a smaller sigma is quantisation, not noise. */
const MIN_SIGMA_C = 0.08;
/** Same as the firmware: past this much foreground the scene moved, not people. */
const GLOBAL_SHIFT_FRACTION = 0.4;
const MAX_PEAKS = 32;

export interface SegmentParams {
  minContrast: number;   // C
  minPeak: number;       // C
  noiseK: number;
  minArea: number;       // px
  maxArea: number;       // px
  splitSep: number;      // px
}

/** The firmware's defaults (tm_detector_default_params), tuned for 110 deg at 3-5 m. */
export const DEFAULT_SEGMENT: SegmentParams = {
  minContrast: 0.6, minPeak: 1.2, noiseK: 4, minArea: 1, maxArea: 60, splitSep: 1.9,
};

export interface Segmentation {
  detections: Detection[];
  globalShift: boolean;
  truncated: boolean;
  threshold: number;
  diff: Float32Array;
  foreground: Uint8Array;
}

/** Find people in `temps` against `background` (both C, 768 row-major). */
export function segment(temps: ArrayLike<number>, background: ArrayLike<number>, p: SegmentParams = DEFAULT_SEGMENT): Segmentation {
  const diff = new Float32Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) diff[i] = (temps[i] ?? 0) - (background[i] ?? 0);

  // The noise estimate is per frame and scene-wide: the model keeps one value
  // per pixel per quarter hour, not a per-pixel variance.
  const mid = median(diff);
  const dev = new Float32Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) dev[i] = Math.abs((diff[i] ?? 0) - mid);
  const sigma = Math.max(MIN_SIGMA_C, MAD_TO_SIGMA * median(dev));
  const threshold = Math.max(p.minContrast, p.noiseK * sigma);

  const foreground = new Uint8Array(GRID_SIZE);
  let cells = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    if ((diff[i] ?? 0) > threshold) { foreground[i] = 1; cells++; }
  }
  const out: Segmentation = { detections: [], globalShift: false, truncated: false, threshold, diff, foreground };
  if (cells > GLOBAL_SHIFT_FRACTION * GRID_SIZE) {
    out.globalShift = true;
    return out;
  }

  const smooth = smoothPositive(diff);
  const visited = new Uint8Array(GRID_SIZE);
  for (let start = 0; start < GRID_SIZE; start++) {
    if (!foreground[start] || visited[start]) continue;
    const members: number[] = [start];
    visited[start] = 1;
    for (let head = 0; head < members.length; head++) {
      const i = members[head] ?? 0;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          if (foreground[j] && !visited[j]) { visited[j] = 1; members.push(j); }
        }
      }
    }
    splitComponent(members, temps, diff, smooth, p, out);
  }
  if (out.detections.length > MAX_DETECTIONS) {
    out.detections.length = MAX_DETECTIONS;
    out.truncated = true;
  }
  return out;
}

function smoothPositive(d: Float32Array): Float32Array {
  const k = [1, 2, 1];
  const out = new Float32Array(GRID_SIZE);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const w = (k[dx + 1] ?? 0) * (k[dy + 1] ?? 0);
          sum += w * Math.max(0, d[ny * W + nx] ?? 0);
          wsum += w;
        }
      }
      out[y * W + x] = sum / wsum;
    }
  }
  return out;
}

function splitComponent(members: number[], temps: ArrayLike<number>, diff: Float32Array, smooth: Float32Array,
  p: SegmentParams, out: Segmentation): void {
  // Local maxima of the smoothed difference; ties go to raster order so a
  // flat-topped blob gives one peak.
  let peaks: number[] = [];
  for (const i of members) {
    const x = i % W, y = (i / W) | 0;
    const v = smooth[i] ?? 0;
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        const w = smooth[j] ?? 0;
        if (w > v || (w === v && j < i)) { isMax = false; break; }
      }
    }
    if (isMax && peaks.length < MAX_PEAKS) peaks.push(i);
  }
  if (peaks.length === 0) return;

  // Strongest first; a peak closer than splitSep to a stronger one is the same person.
  peaks.sort((a, b) => (smooth[b] ?? 0) - (smooth[a] ?? 0));
  const sep2 = p.splitSep * p.splitSep;
  const kept: number[] = [];
  for (const a of peaks) {
    const ax = a % W, ay = (a / W) | 0;
    if (!kept.some((b) => (ax - (b % W)) ** 2 + (ay - ((b / W) | 0)) ** 2 < sep2)) kept.push(a);
  }
  peaks = kept;

  const acc = peaks.map(() => ({ w: 0, x: 0, y: 0, area: 0, peakD: 0, peakT: -Infinity }));
  for (const i of members) {
    const x = i % W, y = (i / W) | 0;
    let best = 0, bestD2 = Infinity;
    peaks.forEach((k, n) => {
      const d2 = (x - (k % W)) ** 2 + (y - ((k / W) | 0)) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    });
    const a = acc[best];
    if (!a) continue;
    const d = diff[i] ?? 0;
    const w = Math.max(0, d);
    a.w += w;
    a.x += w * (x + 0.5);
    a.y += w * (y + 0.5);
    a.area += 1;
    a.peakD = Math.max(a.peakD, d);
    a.peakT = Math.max(a.peakT, temps[i] ?? -Infinity);
  }
  for (const a of acc) {
    if (a.area < p.minArea || a.area > p.maxArea || a.peakD < p.minPeak || a.w <= 0) continue;
    out.detections.push({ x: a.x / a.w, y: a.y / a.w, area: a.area, contrast: a.peakD, peak: a.peakT, heat: a.w });
  }
}

/** Decode a RAW packet's pixels to C. */
export function rawTemps(raw: Raw): Float32Array {
  const t = new Float32Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) t[i] = raw.tMin + (raw.pixels[i] ?? 0) * raw.step;
  return t;
}

/**
 * One node's edge detection: RAW in, a REPORT out that the occupancy engine
 * cannot tell from the node's own -- except that it is honest about
 * readiness: until the StaticBackground is trusted the REPORT carries no
 * detections and no BACKGROUND_READY flag, so the node's tables read
 * unknown rather than empty.
 */
export class EdgeDetector {
  readonly background: StaticBackground;
  last: Segmentation | null = null;

  constructor(background: StaticBackground, readonly params: SegmentParams = DEFAULT_SEGMENT) {
    this.background = background;
  }

  step(raw: Raw, at: number, ta: number): Report {
    const temps = rawTemps(raw);
    // Learn from the frame first: the frame's own vote is one sample among
    // hundreds per bucket and cannot hide a person in it.
    this.background.add(temps, at);
    let lo = Infinity, hi = -Infinity;
    for (const v of temps) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const bg = this.background.backgroundFor(median(temps));
    const seg = bg ? segment(temps, bg, this.params) : null;
    this.last = seg;
    let bgMean = 0;
    if (bg) { for (const v of bg) bgMean += v; bgMean /= GRID_SIZE; }
    const flags = (bg ? REPORT_BACKGROUND_READY : 0)
      | (seg?.globalShift ? REPORT_GLOBAL_SHIFT : 0)
      | (seg?.truncated ? REPORT_TRUNCATED : 0);
    return {
      kind: 'report',
      type: raw.type,
      uid: raw.uid,
      boot: raw.boot,
      seq: raw.seq,
      uptimeMs: raw.uptimeMs,
      signed: raw.signed,
      frame: raw.frame,
      ta,
      sceneMin: lo,
      sceneMax: hi,
      bgMean,
      flags,
      detections: seg?.detections ?? [],
    };
  }

  state(now: number): StaticBackgroundState {
    return this.background.state(now);
  }
}
