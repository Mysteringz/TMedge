/**
 * Claims about detecting on the edge against a background that only learns
 * what is there nearly all day. The failure these guard against: a student
 * who sits still for a couple of hours fading out of the count.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { DEFAULT_SEGMENT, EdgeDetector, segment } from '../src/edge/edgedetect.js';
import { buildRaw, buildReport, GRID_SIZE, parsePacket, REPORT_BACKGROUND_READY, type Raw } from '../src/edge/protocol.js';
import { buildRegistry, ConfigError } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { DEFAULT_STATIC_BACKGROUND, StaticBackground, type StaticBackgroundOptions } from '../src/edge/staticbg.js';
import { identity, KEY, nodesJson, personAt, siteJson } from './fixtures.js';

const W = 32;
const HOUR = 3600_000;
const RIG = '2c:cf:67:0b:c0:94';   // the intern desk rig, owns D1

/** Deterministic noise, so a failure is the same failure on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Patch { x: number; y: number; r: number; dC: number }

/** A room at `ambient` C with a fixed floor pattern, some warm patches and sensor noise. */
function frame(ambient: number, patches: Patch[], rand: () => number): Float32Array {
  const t = new Float32Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) {
    const x = i % W, y = Math.floor(i / W);
    t[i] = ambient + 0.4 * Math.sin(x / 5) + 0.3 * Math.cos(y / 4) + (rand() - 0.5) * 0.3;
    for (const p of patches) {
      const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d2 <= p.r * p.r) t[i] = (t[i] ?? 0) + p.dC * (1 - d2 / (p.r * p.r + 1));
    }
  }
  return t;
}

const HEATER: Patch = { x: 26, y: 5, r: 2, dC: 6 };
const PERSON: Patch = { x: 8, y: 16, r: 1.5, dC: 4 };

/** Background-only options, one frame per sample so a simulated day stays fast. */
const FAST: StaticBackgroundOptions = { ...DEFAULT_STATIC_BACKGROUND };

function blobNear(dets: { x: number; y: number }[], p: Patch): boolean {
  return dets.some((d) => Math.hypot(d.x - (p.x + 0.5), d.y - (p.y + 0.5)) < 2.5);
}

/**
 * A day in the room, one frame per sample period: the heater is on all day,
 * the room warms and cools by 3 C, and the person sits still for the last
 * `sitHours`. Returns the model and the final frame.
 */
function day(sitHours: number, opts = FAST) {
  const rand = rng(7);
  const bg = new StaticBackground(null, opts);
  const t0 = 10 * 24 * HOUR;
  const end = t0 + 24 * HOUR;
  let last: Float32Array = new Float32Array(GRID_SIZE);
  for (let at = t0; at <= end; at += opts.sampleMs) {
    const ambient = 22 + 1.5 * Math.sin(((at - t0) / (24 * HOUR)) * 2 * Math.PI);
    const seated = sitHours > 0 && at >= end - sitHours * HOUR;
    last = frame(ambient, seated ? [HEATER, PERSON] : [HEATER], rand);
    bg.add(last, at);
  }
  return { bg, last, end };
}

function medianOf(a: Float32Array): number {
  const s = Float32Array.from(a).sort();
  return ((s[383] ?? 0) + (s[384] ?? 0)) / 2;
}

test('edge background: someone sitting still for three hours is still found', () => {
  const { bg, last } = day(3);
  const model = bg.backgroundFor(medianOf(last));
  assert.ok(model, 'a day of history is plenty');
  const seg = segment(last, model);
  assert.ok(blobNear(seg.detections, PERSON), `three hours in, still a person: ${JSON.stringify(seg.detections)}`);
});

test('edge background: a heat source that is on all day is subtracted, not counted', () => {
  const { bg, last } = day(0);
  const model = bg.backgroundFor(medianOf(last));
  assert.ok(model);
  const seg = segment(last, model);
  assert.ok(!blobNear(seg.detections, HEATER), 'the heater is part of the room');
  assert.equal(seg.detections.length, 0, `an empty room with a heater and a 3 C daily swing reads empty: ${JSON.stringify(seg.detections)}`);
});

test('edge background: a whole working day at one desk is not learned either', () => {
  // Warm in 9 of 24 hours: far short of the ~80% of buckets it takes.
  const { bg, last } = day(9);
  const model = bg.backgroundFor(medianOf(last));
  assert.ok(model);
  assert.ok(blobNear(segment(last, model).detections, PERSON));
});

test('edge background: a short-memory background would have lost them (why this exists)', () => {
  // The same three hours against a background that follows the last half
  // hour -- what any fast-adapting model converges to for a still person.
  const rand = rng(3);
  const recent = new StaticBackground(null, { ...FAST, windowMs: 0.5 * HOUR, bucketMs: 5 * 60_000, minBuckets: 2, minSamplesPerBucket: 10 });
  let last: Float32Array = new Float32Array(GRID_SIZE);
  for (let at = 0; at <= 3 * HOUR; at += FAST.sampleMs) {
    last = frame(22, [HEATER, PERSON], rand);
    recent.add(last, at);
  }
  const model = recent.backgroundFor(medianOf(last));
  assert.ok(model);
  assert.ok(!blobNear(segment(last, model).detections, PERSON), 'the person has become background');
});

test('edge background: nothing is detected, and nothing claims to be ready, before there is history', () => {
  const det = new EdgeDetector(new StaticBackground(null));
  const raw = parsePacket(buildRaw(identity(RIG), 0, 1, frame(22, [PERSON], rng(1))), { keys: [KEY], allowUnsigned: false }) as Raw;
  const r = det.step(raw, 1000, 25);
  assert.equal(r.detections.length, 0);
  assert.equal(r.flags & REPORT_BACKGROUND_READY, 0, 'not ready, so the table reads unknown rather than empty');
  assert.equal(det.state(1000).ready, false);
});

test('edge background: the model survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-bg-'));
  const file = join(dir, 'node.json');
  const opts: StaticBackgroundOptions = { ...FAST, minBuckets: 2 };
  const a = new StaticBackground(file, opts);
  const rand = rng(5);
  let at = 0;
  for (; at <= 45 * 60_000; at += opts.sampleMs) a.add(frame(22, [HEATER], rand), at);
  assert.equal(a.state(at).ready, true);
  const b = new StaticBackground(file, opts);
  assert.equal(b.state(at).ready, true, 'no second warm-up after a restart');
  assert.equal(b.state(at).buckets, a.state(at).buckets);
});

test('edge background: a mistyped detector is refused at startup', () => {
  const n = nodesJson() as { nodes: Record<string, unknown>[] };
  const rig = n.nodes.find((x) => x.uid === RIG);
  assert.ok(rig);
  rig.detector = 'egde';
  assert.throws(() => buildRegistry(siteJson(), n), (e: unknown) => e instanceof ConfigError && /detector/.test(e.message));
  delete rig.detector;
  assert.equal(buildRegistry(siteJson(), n).nodes.get(RIG)?.detector, 'node', 'the node detects unless told otherwise');
});

function runtime(detector: 'node' | 'edge', prepare?: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tmedge-'));
  prepare?.(dataDir);
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir, recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  const n = nodesJson() as { nodes: Record<string, unknown>[] };
  const rig = n.nodes.find((x) => x.uid === RIG);
  assert.ok(rig);
  rig.detector = detector;
  return new EdgeRuntime(cfg, buildRegistry(siteJson(), n));
}

function d1(rt: EdgeRuntime) {
  return rt.engine.snapshot(Date.now()).floors.find((f) => f.id === 'iw-intern-demo')?.tables.find((t) => t.id === 'D1');
}

/** A flat, ready background file for the rig, as if it had been learning all day. */
function readyBackground(dataDir: string): void {
  const now = Date.now();
  const bucketMs = DEFAULT_STATIC_BACKGROUND.bucketMs;
  const buckets = Array.from({ length: 8 }, (_, k) => ({
    start: Math.floor(now / bucketMs) * bucketMs - (k + 1) * bucketMs,
    samples: 90,
    rel: new Array<number>(GRID_SIZE).fill(0),
  }));
  mkdirSync(join(dataDir, 'background'), { recursive: true });
  writeFileSync(join(dataDir, 'background', `${RIG.replace(/:/g, '')}.json`), JSON.stringify({ version: 1, bucketMs, buckets }));
}

test('edge detection: an edge node is counted from its picture, not from its own REPORT', () => {
  const rt = runtime('edge', readyBackground);
  const reg = rt.reg;
  const pose = reg.nodes.get(RIG)?.pose;
  const seat = reg.tables.get('D1')?.seats[0];
  assert.ok(pose && seat);
  const where = personAt(pose, seat.x, seat.y);
  const id = identity(RIG);
  for (let f = 1; f <= 6; f++) {
    // The node claims nobody is there -- the verdict of a background that has
    // absorbed a still person. Its picture says otherwise.
    rt.ingest.handle(buildReport(id, f * 1000, { frame: f, ta: 25, sceneMin: 21, sceneMax: 27, bgMean: 22, flags: REPORT_BACKGROUND_READY, detections: [] }), '10.0.0.5');
    const temps = frame(22, [{ x: Math.floor(where.x), y: Math.floor(where.y), r: 1.5, dC: 4 }], rng(f));
    rt.ingest.handle(buildRaw(id, f * 1000, f, temps), '10.0.0.5');
  }
  const t = d1(rt);
  assert.ok(t, 'D1');
  assert.ok((t.occupied ?? 0) >= 1, `the still person is counted: ${JSON.stringify(t)}`);
  const h = rt.nodes().find((x) => x.uid === RIG);
  assert.equal(h?.detector, 'edge');
  assert.equal(h?.edgeBackground?.ready, true);
});

test('edge detection: a node that still detects on board ignores the edge model entirely', () => {
  const rt = runtime('node', readyBackground);
  const id = identity(RIG);
  for (let f = 1; f <= 6; f++) rt.ingest.handle(buildRaw(id, f * 1000, f, frame(22, [PERSON], rng(f))), '10.0.0.5');
  assert.equal(rt.edgeDetectors.size, 0, 'no edge model for an on-board node');
  assert.equal(d1(rt)?.occupied, null, 'RAW alone moves nothing for it: no REPORT, so unknown');
});

test('edge detection: while the edge model is warming up the desk is unknown, never empty', () => {
  const rt = runtime('edge');
  const id = identity(RIG);
  for (let f = 1; f <= 6; f++) rt.ingest.handle(buildRaw(id, f * 1000, f, frame(22, [PERSON], rng(f))), '10.0.0.5');
  assert.equal(d1(rt)?.occupied, null);
  assert.equal(rt.nodes().find((x) => x.uid === RIG)?.edgeBackground?.ready, false);
});

test('edge detection: segmentation keeps the firmware thresholds', () => {
  // One faint warm pixel below min_peak is noise, one clear person is one detection.
  const bg = new Float32Array(GRID_SIZE).fill(22);
  const t = Float32Array.from(bg);
  t[5 * W + 5] = 22 + DEFAULT_SEGMENT.minPeak * 0.8;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) t[(15 + dy) * W + 20 + dx] = 26;
  const seg = segment(t, bg);
  assert.equal(seg.detections.length, 1);
  assert.equal(seg.detections[0]?.area, 4);
});
