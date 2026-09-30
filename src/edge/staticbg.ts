/**
 * A background that only learns what is there nearly all day.
 *
 * The node's own detector keeps an exponential background with a time
 * constant of about 90 frames. It is built never to absorb a labelled
 * person, but any frame in which a seated person's blob is missed (below
 * min_peak, split oddly, merged with a neighbour) lets those pixels drift
 * into the background, and over one to three hours a student who sits still
 * fades out of the count. Tuning the constant only moves the problem: slow
 * enough to keep a two-hour sitter is too slow to follow the room.
 *
 * This model separates the two by duration rather than speed:
 *
 *   1. Level. Each frame is taken relative to its own median, so the whole
 *      room warming or cooling over the day cancels. People cover a few
 *      percent of the pixels and barely move the median.
 *   2. Buckets. Every `bucketMs` (15 min) the relative samples of that
 *      period are reduced to one per-pixel median: "what this pixel mostly
 *      looked like in this quarter hour".
 *   3. Quantile. The background is the per-pixel `quantile` (20th percentile)
 *      of the buckets in the last `windowMs` (24 h). A pixel is warm in the
 *      background only if it was warm in about 80% of the buckets -- 19 h of
 *      24. A radiator, a server, a lamp that is always on: background. A
 *      student sitting for 1-3 hours, or a whole working day, is warm in far
 *      fewer buckets and stays in the foreground.
 *
 * The price is honest and worth saying: something that is warm for only part
 * of every day (a desktop PC that is on 9-6, afternoon sun on one desk) is
 * never background either, so it looks like a person to the segmenter unless
 * its shape rules it out. And until the window has filled, "most of the time"
 * means most of the time observed so far, so during the first hours a person
 * who has sat there since the start can still be absorbed. The model is saved
 * to disk so that warm-up happens once, not after every restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GRID_SIZE } from './protocol.js';

export interface StaticBackgroundOptions {
  /** Length of one bucket; its per-pixel median is one vote. */
  bucketMs: number;
  /** Buckets older than this no longer vote. */
  windowMs: number;
  /** At most one frame per this long goes into a bucket (1 fps would be 900). */
  sampleMs: number;
  /** Per-pixel quantile over the buckets; 0.2 = warm in >= 80% of them. */
  quantile: number;
  /** Buckets needed before the model is trusted at all. */
  minBuckets: number;
  /** A bucket with fewer samples (the node was mostly offline) does not vote. */
  minSamplesPerBucket: number;
}

export const DEFAULT_STATIC_BACKGROUND: StaticBackgroundOptions = {
  bucketMs: 15 * 60_000,
  windowMs: 24 * 3600_000,
  sampleMs: 10_000,
  quantile: 0.2,
  minBuckets: 4,
  minSamplesPerBucket: 30,
};

interface Bucket {
  /** Start of the bucket, ms since epoch, a multiple of bucketMs. */
  start: number;
  samples: number;
  /** Per-pixel median of (T - frame median), C. */
  rel: Float32Array;
}

export interface StaticBackgroundState {
  ready: boolean;
  /** Buckets currently voting. */
  buckets: number;
  /** Hours of history they span, for "warming up: 3.5 h of 24". */
  hours: number;
  windowHours: number;
}

const FILE_VERSION = 1;

export function median(values: ArrayLike<number>): number {
  const a = Float32Array.from(values).sort();
  const n = a.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? (a[mid] ?? 0) : ((a[mid - 1] ?? 0) + (a[mid] ?? 0)) / 2;
}

/** Linear-interpolated quantile of an ascending array. */
function quantileSorted(a: Float32Array, q: number): number {
  if (a.length === 0) return 0;
  const pos = q * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(a.length - 1, lo + 1);
  return (a[lo] ?? 0) + ((a[hi] ?? 0) - (a[lo] ?? 0)) * (pos - lo);
}

export class StaticBackground {
  private readonly buckets: Bucket[] = [];
  private current: { start: number; samples: Float32Array; n: number } | null = null;
  private lastSampleAt = -Infinity;
  private rel: Float32Array | null = null;
  /** Buckets were loaded from disk and the quantile has not been taken against a frame's clock yet. */
  private stale = false;
  private readonly maxSamples: number;

  /**
   * @param file where the closed buckets are kept across restarts, or null
   *             (tests) to keep them in memory only.
   */
  constructor(readonly file: string | null, readonly opts: StaticBackgroundOptions = DEFAULT_STATIC_BACKGROUND) {
    if (!(opts.quantile > 0 && opts.quantile < 1)) throw new Error('quantile must be between 0 and 1');
    this.maxSamples = Math.ceil(opts.bucketMs / opts.sampleMs) + 1;
    if (file) this.load(file);
  }

  /** Feed one frame of temperatures (C, 768, row-major) seen at `at`. */
  add(temps: ArrayLike<number>, at: number): void {
    if (this.stale) this.recompute(at);
    const start = Math.floor(at / this.opts.bucketMs) * this.opts.bucketMs;
    if (this.current && this.current.start !== start) this.close(at);
    if (at - this.lastSampleAt < this.opts.sampleMs) return;
    if (!this.current) this.current = { start, samples: new Float32Array(this.maxSamples * GRID_SIZE), n: 0 };
    if (this.current.n >= this.maxSamples) return;
    this.lastSampleAt = at;
    const level = median(temps);
    const base = this.current.n * GRID_SIZE;
    for (let i = 0; i < GRID_SIZE; i++) this.current.samples[base + i] = (temps[i] ?? level) - level;
    this.current.n += 1;
  }

  /**
   * The background for a frame whose median is `level`, or null while the
   * model is not trusted yet. Absolute temperatures, C.
   */
  backgroundFor(level: number): Float32Array | null {
    if (!this.rel) return null;
    const out = new Float32Array(GRID_SIZE);
    for (let i = 0; i < GRID_SIZE; i++) out[i] = level + (this.rel[i] ?? 0);
    return out;
  }

  state(now: number): StaticBackgroundState {
    if (this.stale) this.recompute(now);
    const voting = this.voting(now);
    const first = voting[0]?.start ?? now;
    return {
      ready: this.rel !== null,
      buckets: voting.length,
      hours: voting.length ? Math.round(((now - first) / 3600_000) * 10) / 10 : 0,
      windowHours: this.opts.windowMs / 3600_000,
    };
  }

  private voting(now: number): Bucket[] {
    return this.buckets.filter((b) => b.start >= now - this.opts.windowMs);
  }

  private close(now: number): void {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.n < this.opts.minSamplesPerBucket) return;
    const rel = new Float32Array(GRID_SIZE);
    const column = new Float32Array(cur.n);
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let s = 0; s < cur.n; s++) column[s] = cur.samples[s * GRID_SIZE + i] ?? 0;
      rel[i] = median(column);
    }
    this.buckets.push({ start: cur.start, samples: cur.n, rel });
    this.recompute(now);
    if (this.file) this.save(this.file);
  }

  private recompute(now: number): void {
    this.stale = false;
    // Forget what can no longer vote, so memory stays at one window.
    const keep = this.voting(now);
    this.buckets.splice(0, this.buckets.length, ...keep);
    if (keep.length < this.opts.minBuckets) {
      this.rel = null;
      return;
    }
    const rel = new Float32Array(GRID_SIZE);
    const column = new Float32Array(keep.length);
    for (let i = 0; i < GRID_SIZE; i++) {
      keep.forEach((b, k) => { column[k] = b.rel[i] ?? 0; });
      column.sort();
      rel[i] = quantileSorted(column, this.opts.quantile);
    }
    this.rel = rel;
  }

  private save(file: string): void {
    const doc = {
      version: FILE_VERSION,
      bucketMs: this.opts.bucketMs,
      buckets: this.buckets.map((b) => ({ start: b.start, samples: b.samples, rel: Array.from(b.rel, (v) => Math.round(v * 100) / 100) })),
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc));
      renameSync(tmp, file);
    } catch (e) {
      // Losing the file costs a warm-up after the next restart; it must not
      // cost the detections of this one.
      console.error(`[edge] could not save background ${file}: ${(e as Error).message}`);
    }
  }

  private load(file: string): void {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return;   // no file yet, or unreadable: start warming up
    }
    const d = doc as { version?: unknown; bucketMs?: unknown; buckets?: unknown };
    // A different bucket length would mix votes of different weights.
    if (d.version !== FILE_VERSION || d.bucketMs !== this.opts.bucketMs || !Array.isArray(d.buckets)) return;
    for (const b of d.buckets as { start?: unknown; samples?: unknown; rel?: unknown }[]) {
      if (typeof b.start !== 'number' || typeof b.samples !== 'number' || !Array.isArray(b.rel) || b.rel.length !== GRID_SIZE) continue;
      if (!(b.rel as unknown[]).every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      this.buckets.push({ start: b.start, samples: b.samples, rel: Float32Array.from(b.rel as number[]) });
    }
    this.buckets.sort((a, b) => a.start - b.start);
    // Which buckets still vote depends on the time of the first frame, not
    // on when the file was read.
    this.stale = true;
  }
}
