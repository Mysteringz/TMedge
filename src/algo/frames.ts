/**
 * The frames the debugger works on.
 *
 * A RAW packet and the REPORT of the same frame carry the same `frame`
 * number, so the two can be paired: the picture the sensor saw, and what the
 * sensor itself decided about it. That pairing is the whole basis for trusting
 * this tool -- every other stage can be re-run here, but the device's own
 * answer cannot be reproduced, only observed.
 *
 * Kept in memory, per node, as a ring. Recording every node's RAW to disk
 * would be about 7 GB a day against a 22 GB volume, so the debugger instead
 * turns RAW on for the one node being inspected and keeps the last few
 * minutes of it.
 */
import type { DeviceDetection, FramePair } from './types.js';
import type { ConsoleDetection, RawFrameMessage } from '../shared/types.js';

export const RING_FRAMES = 360;   // 6 minutes at 1 fps, 90 s at 4 fps

interface Ring {
  frames: FramePair[];
  /** REPORTs that arrived before their RAW, by frame number. */
  pending: Map<number, { dets: DeviceDetection[]; flags: number }>;
}

export class FrameStore {
  private readonly rings = new Map<string, Ring>();

  private ring(uid: string): Ring {
    let r = this.rings.get(uid);
    if (!r) {
      r = { frames: [], pending: new Map() };
      this.rings.set(uid, r);
    }
    return r;
  }

  addRaw(msg: RawFrameMessage): FramePair {
    const r = this.ring(msg.uid);
    const temps = new Float32Array(768);
    for (let i = 0; i < 768; i++) temps[i] = msg.tMin + (msg.pixels[i] ?? 0) * msg.step;
    const waiting = r.pending.get(msg.frame);
    r.pending.delete(msg.frame);
    const pair: FramePair = {
      frame: msg.frame,
      uid: msg.uid,
      receivedAt: msg.receivedAt,
      temps,
      tMin: msg.tMin,
      step: msg.step,
      deviceDetections: waiting?.dets ?? null,
      deviceFlags: waiting?.flags ?? null,
    };
    r.frames.push(pair);
    if (r.frames.length > RING_FRAMES) r.frames.shift();
    return pair;
  }

  /**
   * The device's own detections for a frame. They usually arrive before the
   * RAW of the same frame (REPORT is sent every frame, RAW every Nth), so an
   * unmatched one waits briefly for its picture.
   */
  addReport(uid: string, frame: number, dets: ConsoleDetection[], flags: number): void {
    const r = this.ring(uid);
    const mapped: DeviceDetection[] = dets.map((d) => ({
      x: d.x, y: d.y, area: d.area, contrast: d.contrast, peak: d.peak, heat: d.heat,
    }));
    const existing = r.frames.find((f) => f.frame === frame);
    if (existing) {
      existing.deviceDetections = mapped;
      existing.deviceFlags = flags;
      return;
    }
    r.pending.set(frame, { dets: mapped, flags });
    if (r.pending.size > 64) {
      const oldest = Math.min(...r.pending.keys());
      r.pending.delete(oldest);
    }
  }

  list(uid: string): FramePair[] {
    return this.ring(uid).frames;
  }

  /** Newest first is how a timeline is read; the ring is oldest first. */
  latest(uid: string): FramePair | null {
    const f = this.ring(uid).frames;
    return f[f.length - 1] ?? null;
  }

  get(uid: string, frame: number): FramePair | null {
    return this.ring(uid).frames.find((f) => f.frame === frame) ?? null;
  }

  /** Frames up to and including `frame`: what a background EMA has seen. */
  historyTo(uid: string, frame: number): FramePair[] {
    const all = this.ring(uid).frames;
    const i = all.findIndex((f) => f.frame === frame);
    return i < 0 ? all : all.slice(0, i + 1);
  }

  timeline(uid: string): { frame: number; at: number; detections: number | null }[] {
    return this.ring(uid).frames.map((f) => ({
      frame: f.frame,
      at: f.receivedAt,
      detections: f.deviceDetections?.length ?? null,
    }));
  }

  clear(uid: string): void {
    this.rings.delete(uid);
  }

  /** Which nodes have frames, for the source picker. */
  sources(): { uid: string; frames: number; newestAt: number | null }[] {
    return [...this.rings].map(([uid, r]) => ({
      uid,
      frames: r.frames.length,
      newestAt: r.frames[r.frames.length - 1]?.receivedAt ?? null,
    }));
  }
}

/** A frame as the browser receives it: levels, not floats, to keep it small. */
export function encodeFrame(pair: FramePair): {
  frame: number; at: number; tMin: number; step: number; pixels: string;
  min: number; max: number; mean: number;
} {
  let min = Infinity, max = -Infinity, sum = 0;
  const bytes = Buffer.alloc(768);
  for (let i = 0; i < 768; i++) {
    const t = pair.temps[i] ?? 0;
    if (t < min) min = t;
    if (t > max) max = t;
    sum += t;
    bytes[i] = Math.max(0, Math.min(255, Math.round((t - pair.tMin) / (pair.step || 1))));
  }
  return {
    frame: pair.frame,
    at: pair.receivedAt,
    tMin: pair.tMin,
    step: pair.step,
    pixels: bytes.toString('base64'),
    min, max, mean: sum / 768,
  };
}
