/**
 * Today's edge detector, run over recorded days:
 *
 *   node dist/src/tools/replay.js --shards data/ml/shards --out data/ml/replay [--sensor uid]
 *
 * A new model is only worth shipping if it beats what the edge already does,
 * on the same frames. That baseline is not a re-implementation: each sensor's
 * frames go, in time order and across days, through the real EdgeDetector
 * (staticbg.ts + edgedetect.ts) exactly as runtime.ts feeds a "detector":
 * "edge" node, and what it found is written per frame. The locked test days
 * are replayed too -- scoring a baseline on them is what they are for -- and
 * their output goes under <out>/locked/ like their shards.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SEGMENT, EdgeDetector } from '../edge/edgedetect.js';
import { GRID_SIZE, REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, TYPE_RAW, type Raw } from '../edge/protocol.js';
import { DEFAULT_STATIC_BACKGROUND, StaticBackground } from '../edge/staticbg.js';
import { listShards, readShard, sensorDir, type ThermalShard } from './thermal-shards.js';

export const REPLAY_VERSION = 1;

/** [x, y, area, contrast, peak, heat], rounded: the file is read for scoring, not re-fed. */
export type ReplayDetection = [number, number, number, number, number, number];

export interface ReplayDay {
  version: number;
  detector: 'edge';
  segment: typeof DEFAULT_SEGMENT;
  background: typeof DEFAULT_STATIC_BACKGROUND;
  sensor: string;
  day: string;
  locked: boolean;
  count: number;
  at: number[];
  ready: (0 | 1)[];
  globalShift: (0 | 1)[];
  dets: ReplayDetection[][];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The packet the node would have sent for this frame; only the pixels, scaling and frame number matter here. */
function rawOf(s: ThermalShard, i: number): Raw {
  return {
    kind: 'raw', type: TYPE_RAW, uid: s.sensor, boot: 0, seq: i, uptimeMs: 0, signed: false,
    frame: s.frame[i] ?? i, tMin: s.tMin[i] ?? 0, step: s.step[i] ?? 0,
    pixels: s.pixels.subarray(i * GRID_SIZE, (i + 1) * GRID_SIZE),
  };
}

/** Run one day through `detector`, which carries its background over from the days before. */
export function replayDay(detector: EdgeDetector, s: ThermalShard): ReplayDay {
  const out: ReplayDay = {
    version: REPLAY_VERSION, detector: 'edge', segment: detector.params, background: detector.background.opts,
    sensor: s.sensor, day: s.day, locked: s.locked, count: s.count, at: s.at, ready: [], globalShift: [], dets: [],
  };
  for (let i = 0; i < s.count; i++) {
    const at = s.at[i] ?? 0;
    const report = detector.step(rawOf(s, i), at, at);
    out.ready.push(report.flags & REPORT_BACKGROUND_READY ? 1 : 0);
    out.globalShift.push(report.flags & REPORT_GLOBAL_SHIFT ? 1 : 0);
    out.dets.push(report.detections.map((d) => [r3(d.x), r3(d.y), d.area, r3(d.contrast), r3(d.peak), r3(d.heat)]));
  }
  return out;
}

/** Replay every shard under `shardsRoot` into `outRoot`; one detector per sensor, days in order. */
export function replayAll(shardsRoot: string, outRoot: string, onlySensor?: string): ReplayDay[] {
  const refs = listShards(shardsRoot, true).filter((r) => !onlySensor || r.sensor === onlySensor);
  const detectors = new Map<string, EdgeDetector>();
  const days: ReplayDay[] = [];
  for (const ref of refs) {
    let det = detectors.get(ref.sensor);
    if (!det) {
      // Memory only: a replay must not read or overwrite an edge's saved background.
      det = new EdgeDetector(new StaticBackground(null, DEFAULT_STATIC_BACKGROUND), DEFAULT_SEGMENT);
      detectors.set(ref.sensor, det);
    }
    const day = replayDay(det, readShard(ref));
    const file = join(outRoot, ...(day.locked ? ['locked'] : []), sensorDir(day.sensor), `${day.day}.edge.json`);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(day));
    renameSync(tmp, file);
    days.push(day);
  }
  return days;
}

/** One line per day: how much of it the detector could judge at all, and how many people it saw. */
export function summarise(d: ReplayDay): string {
  const ready = d.ready.reduce<number>((a, b) => a + b, 0);
  const hist = [0, 0, 0, 0, 0];
  for (let i = 0; i < d.count; i++) {
    if (!d.ready[i]) continue;
    const n = d.dets[i]?.length ?? 0;
    hist[Math.min(n, 4)] = (hist[Math.min(n, 4)] ?? 0) + 1;
  }
  const pct = (n: number, of: number) => (of ? `${Math.round((1000 * n) / of) / 10}%` : '-');
  return `${d.sensor} ${d.day}${d.locked ? ' LOCKED' : ''}: ${d.count} frames, ${pct(ready, d.count)} with a ready background; ` +
    `blobs per ready frame 0/1/2/3/4+: ${hist.map((n) => pct(n, ready)).join(' / ')}`;
}

function main(argv: string[]): number {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shards = arg('--shards');
  const out = arg('--out');
  if (!shards || !out) {
    console.error('usage: node dist/src/tools/replay.js --shards <dir> --out <dir> [--sensor uid]');
    return 2;
  }
  for (const d of replayAll(shards, out, arg('--sensor'))) console.log(summarise(d));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
