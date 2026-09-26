/**
 * Paired RGB and thermal frames: the training set for the ML locator.
 *
 * The rig on the intern desk carries both a Raspberry Pi camera and an
 * MLX90640 looking at the same scene. The camera can say where a person
 * really is; the thermal array is what has to learn to. Neither is any use
 * for training on its own, and today neither is kept -- RGB lives in memory
 * on the edge and is overwritten every second.
 *
 * So this records pairs, and nothing else. No decoding, no inference, no
 * model: the edge writes the JPEG beside the thermal frame it belongs with
 * and stops there. Computer vision on those pairs happens off the box, where
 * OpenCV and a GPU exist, and only the fitted model comes back. That keeps a
 * 913 MB t3.micro out of the image-processing business and keeps this repo's
 * runtime dependencies at express and ws.
 *
 * What makes a pair trustworthy is the timestamp: an RGB frame is only kept
 * with the thermal frame nearest it in time, and only when that is close
 * enough that a walking person cannot have moved far between them.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameStore } from './frames.js';
import type { DeviceDetection } from './types.js';

/** A person walks about 1.4 m/s; 400 ms is 55 cm, about a seat's width. */
export const MAX_SKEW_MS = 400;
/** At 1 Hz on both cameras, every other second is plenty and halves the disk. */
export const MIN_GAP_MS = 2000;

export interface PairConfig {
  dir: string;
  /** Stop recording when the corpus reaches this. */
  budgetBytes: number;
  /**
   * Frames where the sensor saw nobody are needed too -- a detector trained
   * only on people learns to answer "person" -- but not one a second of them.
   */
  keepEveryEmpty: number;
}

export const DEFAULT_PAIRS: PairConfig = {
  dir: '',
  budgetBytes: 400 * 1024 * 1024,
  keepEveryEmpty: 6,
};

export interface PairSample {
  uid: string;
  at: number;
  /** The thermal frame's own number, so a sample can be traced to the ring. */
  frame: number;
  skewMs: number;
  tMin: number;
  step: number;
  /** 768 levels, base64, exactly as the sensor quantised them. */
  pixels: string;
  /** What the node itself reported for that frame, when it is known. */
  observed: DeviceDetection[] | null;
  mirror: boolean;
}

export interface PairStats {
  samples: number;
  withPeople: number;
  bytes: number;
  oldest: number | null;
  newest: number | null;
  recording: boolean;
  lastSkipped: string | null;
}

export class PairRecorder {
  private readonly cfg: PairConfig;
  private lastAt = new Map<string, number>();
  private emptySeen = 0;
  private counted = { samples: 0, withPeople: 0, bytes: 0, oldest: null as number | null, newest: null as number | null };
  private lastSkipped: string | null = null;
  recording = false;

  constructor(cfg: Partial<PairConfig> & { dir: string }) {
    this.cfg = { ...DEFAULT_PAIRS, ...cfg };
    mkdirSync(this.cfg.dir, { recursive: true });
    this.rescan();
  }

  /** Count what is already on disk, so a restart does not lose the budget. */
  rescan(): void {
    let samples = 0, withPeople = 0, bytes = 0;
    let oldest: number | null = null, newest: number | null = null;
    for (const uid of safeList(this.cfg.dir)) {
      const dir = join(this.cfg.dir, uid);
      for (const f of safeList(dir)) {
        const full = join(dir, f);
        try {
          bytes += statSync(full).size;
        } catch {
          continue;
        }
        if (!f.endsWith('.json')) continue;
        samples += 1;
        const at = Number(f.replace(/\.json$/, '').split('-')[0]);
        if (Number.isFinite(at)) {
          oldest = oldest === null ? at : Math.min(oldest, at);
          newest = newest === null ? at : Math.max(newest, at);
        }
        if (f.includes('-p')) withPeople += 1;
      }
    }
    this.counted = { samples, withPeople, bytes, oldest, newest };
  }

  stats(): PairStats {
    return { ...this.counted, recording: this.recording, lastSkipped: this.lastSkipped };
  }

  /**
   * An RGB frame has arrived. Keep it only if a thermal frame sits close
   * enough in time, and only every MIN_GAP_MS.
   */
  offer(uid: string, jpeg: Buffer, at: number, frames: FrameStore, mirror: boolean): PairSample | null {
    if (!this.recording) return null;
    const since = at - (this.lastAt.get(uid) ?? 0);
    if (since < MIN_GAP_MS) return null;
    if (this.counted.bytes >= this.cfg.budgetBytes) {
      this.lastSkipped = 'the corpus has reached its disk budget';
      return null;
    }

    // Nearest thermal frame in time. Both cameras run at about 1 Hz and are
    // not synchronised, so most RGB frames have a thermal frame within half a
    // second; the ones that do not are dropped rather than guessed at.
    let best: { pair: ReturnType<FrameStore['latest']>; skew: number } | null = null;
    for (const p of frames.list(uid)) {
      const skew = Math.abs(p.receivedAt - at);
      if (!best || skew < best.skew) best = { pair: p, skew };
    }
    if (!best?.pair) {
      this.lastSkipped = 'no thermal frame held for this node (is raw_every 0?)';
      return null;
    }
    if (best.skew > MAX_SKEW_MS) {
      this.lastSkipped = `nearest thermal frame was ${best.skew} ms away, more than ${MAX_SKEW_MS}`;
      return null;
    }

    const people = best.pair.deviceDetections?.length ?? 0;
    if (people === 0 && this.emptySeen++ % this.cfg.keepEveryEmpty !== 0) return null;

    const dir = join(this.cfg.dir, uid.replace(/[^0-9a-f:]/gi, ''));
    mkdirSync(dir, { recursive: true });
    const name = `${at}-${people > 0 ? 'p' : 'e'}${people}`;
    const sample: PairSample = {
      uid,
      at,
      frame: best.pair.frame,
      skewMs: best.skew,
      tMin: best.pair.tMin,
      step: best.pair.step,
      pixels: levelsOf(best.pair.temps, best.pair.tMin, best.pair.step),
      observed: best.pair.deviceDetections,
      mirror,
    };
    try {
      writeFileSync(join(dir, `${name}.jpg`), jpeg);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(sample));
    } catch (err) {
      this.lastSkipped = `could not write the sample: ${(err as Error).message}`;
      return null;
    }
    this.lastAt.set(uid, at);
    this.counted.samples += 1;
    if (people > 0) this.counted.withPeople += 1;
    this.counted.bytes += jpeg.length + 2048;
    this.counted.newest = at;
    if (this.counted.oldest === null) this.counted.oldest = at;
    this.lastSkipped = null;
    return sample;
  }

  /**
   * Drop the oldest samples that show nobody, and only those: a corpus is
   * mostly empty frames, and the ones with a person in them are the scarce
   * half of what a detector has to learn from.
   */
  prune(toBytes = this.cfg.budgetBytes * 0.8): number {
    if (this.counted.bytes <= toBytes) return 0;
    const victims: { path: string; at: number; size: number }[] = [];
    for (const uid of safeList(this.cfg.dir)) {
      const dir = join(this.cfg.dir, uid);
      for (const f of safeList(dir)) {
        if (!/-e0\.(json|jpg)$/.test(f)) continue;
        const at = Number(f.split('-')[0]);
        try {
          victims.push({ path: join(dir, f), at, size: statSync(join(dir, f)).size });
        } catch { /* gone already */ }
      }
    }
    victims.sort((a, b) => a.at - b.at);
    let freed = 0, removed = 0;
    for (const v of victims) {
      if (this.counted.bytes - freed <= toBytes) break;
      try {
        unlinkSync(v.path);
        freed += v.size;
        if (v.path.endsWith('.json')) removed += 1;
      } catch { /* gone already */ }
    }
    this.rescan();
    return removed;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Back to the 0..255 levels the sensor sent, which is all the model needs. */
function levelsOf(temps: Float32Array, tMin: number, step: number): string {
  const b = Buffer.alloc(temps.length);
  for (let i = 0; i < temps.length; i++) {
    b[i] = Math.max(0, Math.min(255, Math.round(((temps[i] ?? tMin) - tMin) / (step || 1))));
  }
  return b.toString('base64');
}
