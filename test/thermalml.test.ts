/**
 * Claims about the bridge between the offline thermal ML tools and the edge.
 * The failures these guard against: the model training against a background
 * the edge would not have computed, a shard read short without anyone
 * noticing, and the "today's detector" baseline drifting from what the edge
 * actually runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { DEFAULT_SEGMENT, EdgeDetector, rawTemps, segment } from '../src/edge/edgedetect.js';
import { GRID_SIZE, TYPE_RAW, type Raw } from '../src/edge/protocol.js';
import { DEFAULT_STATIC_BACKGROUND, median, StaticBackground, type StaticBackgroundOptions } from '../src/edge/staticbg.js';
import { replayAll, replayDayAgainst, type ReplayDay } from '../src/tools/replay.js';
import { listShards, readShard, sensorDir } from '../src/tools/thermal-shards.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RIG = '2c:cf:67:0b:c0:94';
const W = 32;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** One frame as the wire carries it: bytes plus scaling, a heater always on, a person when asked. */
function wireFrame(rand: () => number, person: boolean): { tMin: number; step: number; pixels: Uint8Array } {
  const tMin = 20 + rand() * 0.4;
  const step = 0.02 + rand() * 0.005;
  const pixels = new Uint8Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) {
    const x = i % W, y = Math.floor(i / W);
    let t = 22 + 0.4 * Math.sin(x / 5) + 0.3 * Math.cos(y / 4) + (rand() - 0.5) * 0.3;
    if ((x - 26) ** 2 + (y - 5) ** 2 <= 4) t += 6;
    if (person && (x - 8) ** 2 + (y - 16) ** 2 <= 2) t += 4;
    pixels[i] = Math.max(0, Math.min(255, Math.round((t - tMin) / step)));
  }
  return { tMin, step, pixels };
}

/** A shard file pair exactly as tools/thermalml writes it. */
function writeShard(root: string, uid: string, day: string, locked: boolean, frames: { at: number; tMin: number; step: number; pixels: Uint8Array }[]): void {
  const dir = join(root, ...(locked ? ['locked'] : []), sensorDir(uid));
  mkdirSync(dir, { recursive: true });
  const raw = Buffer.concat(frames.map((f) => Buffer.from(f.pixels)));
  writeFileSync(join(dir, `${day}.thermal.gz`), gzipSync(raw));
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    version: 1, sensor: uid, day, locked, dayStartMs: 0, count: frames.length,
    payloadSha256: createHash('sha256').update(raw).digest('hex'),
    at: frames.map((f) => f.at), frame: frames.map((_, i) => i), tMin: frames.map((f) => f.tMin), step: frames.map((f) => f.step),
    id: frames.map((_, i) => `${day}-${i}`), observed: frames.map(() => null), poses: [], basis: {}, source: {},
  }));
}

test('the trainer computes the same background as the edge, frame for frame', (t) => {
  // The detector is trained on "frame minus background" and run against the
  // background staticbg.ts keeps on the edge. If the Python port drifted, a
  // model would mean something else in production than in training.
  const opts: StaticBackgroundOptions = { bucketMs: 60_000, windowMs: 10 * 60_000, sampleMs: 2_000, quantile: 0.2, minBuckets: 3, minSamplesPerBucket: 5 };
  const rand = rng(7);
  const frames = [];
  for (let s = 0; s < 16 * 60; s += 1.7) frames.push({ at: Math.round(1_790_000_000_000 + s * 1000), ...wireFrame(rand, s > 9 * 60) });
  const probe = frames.map((_, i) => i).filter((i) => i % 37 === 0 || i === frames.length - 1);

  let reference: { i: number; ready: boolean; bg: number[] | null }[];
  const input = join(mkdtempSync(join(tmpdir(), 'staticbg-')), 'frames.json');
  writeFileSync(input, JSON.stringify({ opts, probe, frames: frames.map((f) => ({ at: f.at, tMin: f.tMin, step: f.step, pixels: Buffer.from(f.pixels).toString('base64') })) }));
  try {
    const out = execFileSync('python3', ['-m', 'tools.thermalml.staticbg', input], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    reference = JSON.parse(out) as typeof reference;
  } catch (err) {
    if (process.env.CI) throw err;
    return t.skip(`the Python tools could not run here (numpy?): ${(err as Error).message.slice(0, 80)}`);
  }

  const bg = new StaticBackground(null, opts);
  const probes = new Set(probe);
  let worst = 0, readyProbes = 0, k = 0;
  frames.forEach((f, i) => {
    const temps = rawTemps({ tMin: f.tMin, step: f.step, pixels: f.pixels } as Raw);
    bg.add(temps, f.at);
    if (!probes.has(i)) return;
    const mine = bg.backgroundFor(median(temps));
    const theirs = reference[k++];
    assert.equal(theirs?.i, i);
    assert.equal(theirs?.ready, mine !== null, `readiness differs at frame ${i}`);
    if (!mine || !theirs?.bg) return;
    readyProbes++;
    for (let p = 0; p < GRID_SIZE; p++) worst = Math.max(worst, Math.abs((mine[p] ?? 0) - (theirs.bg[p] ?? 0)));
  });
  assert.ok(readyProbes >= 5, 'the sequence must get far enough for the background to be compared');
  assert.ok(worst < 1e-5, `backgrounds drift by ${worst} C; the Python port and staticbg.ts disagree`);
});

test('a shard that does not match its own index is refused, not read short', () => {
  const root = mkdtempSync(join(tmpdir(), 'shards-'));
  const rand = rng(3);
  writeShard(root, RIG, '2026-10-06', false, [0, 1, 2].map((i) => ({ at: i * 1000, ...wireFrame(rand, false) })));
  const [ref] = listShards(root, false);
  assert.ok(ref);
  assert.equal(readShard(ref).count, 3);
  const doc = JSON.parse(readFileSync(ref.json, 'utf8')) as { count: number };
  doc.count = 2;
  writeFileSync(ref.json, JSON.stringify(doc));
  assert.throws(() => readShard(ref), /bytes, expected/);
});

test('the locked test days are listed only when asked for', () => {
  const root = mkdtempSync(join(tmpdir(), 'shards-'));
  const rand = rng(4);
  writeShard(root, RIG, '2026-09-26', true, [{ at: 0, ...wireFrame(rand, false) }]);
  writeShard(root, RIG, '2026-10-06', false, [{ at: 0, ...wireFrame(rand, false) }]);
  assert.deepEqual(listShards(root, false).map((r) => r.day), ['2026-10-06']);
  assert.deepEqual(listShards(root, true).map((r) => [r.day, r.locked]), [['2026-09-26', true], ['2026-10-06', false]]);
});

test('the replay baseline finds exactly what the edge detector finds, across days', () => {
  // Two days back to back: the background warms up on the first and must be
  // carried into the second, as it is on a running edge.
  const shards = mkdtempSync(join(tmpdir(), 'shards-'));
  const out = mkdtempSync(join(tmpdir(), 'replay-'));
  const rand = rng(5);
  const day1 = [], day2 = [];
  const t0 = 1_791_300_000_000;
  for (let s = 0; s < 2 * 3600; s += 10) day1.push({ at: t0 + s * 1000, ...wireFrame(rand, false) });
  for (let s = 2 * 3600; s < 3 * 3600; s += 10) day2.push({ at: t0 + s * 1000, ...wireFrame(rand, s > 2.5 * 3600) });
  writeShard(shards, RIG, '2026-10-06', false, day1);
  writeShard(shards, RIG, '2026-10-07', false, day2);

  const days = replayAll(shards, out);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-06', '2026-10-07']);

  const live = new EdgeDetector(new StaticBackground(null, DEFAULT_STATIC_BACKGROUND), DEFAULT_SEGMENT);
  const all = [...day1, ...day2];
  const replayed = days.flatMap((d) => d.dets);
  const ready = days.flatMap((d) => d.ready);
  all.forEach((f, i) => {
    const raw: Raw = { kind: 'raw', type: TYPE_RAW, uid: RIG, boot: 0, seq: i, uptimeMs: 0, signed: false, frame: i, tMin: f.tMin, step: f.step, pixels: f.pixels };
    const report = live.step(raw, f.at, f.at);
    assert.equal(replayed[i]?.length, report.detections.length, `frame ${i}: replay and edge disagree on the count`);
    report.detections.forEach((d, j) => {
      assert.ok(Math.abs((replayed[i]?.[j]?.[0] ?? -1) - d.x) < 1e-3 && Math.abs((replayed[i]?.[j]?.[1] ?? -1) - d.y) < 1e-3);
    });
  });
  assert.equal(ready[0], 0, 'nothing is judged before the background has an hour of history');
  assert.equal(ready[ready.length - 1], 1);
  assert.ok((replayed[replayed.length - 1]?.length ?? 0) >= 1, 'the person who sat down on day two is found');

  const file = JSON.parse(readFileSync(join(out, sensorDir(RIG), '2026-10-07.edge.json'), 'utf8')) as ReplayDay;
  assert.equal(file.count, day2.length);
  assert.deepEqual(file.segment, DEFAULT_SEGMENT);
});

test('a test day scored against a fixed background runs the edge segmenter against exactly that background', () => {
  // The locked days are scored against the rig's empty-room reference, not a
  // re-implementation: every frame must give what segment() gives against
  // (frame median + reference), and every frame counts as judged.
  const shards = mkdtempSync(join(tmpdir(), 'shards-'));
  const rand = rng(9);
  const frames = [0, 1, 2, 3].map((i) => ({ at: i * 3000, ...wireFrame(rand, i >= 2) }));
  writeShard(shards, RIG, '2026-09-29', true, frames);
  const [ref] = listShards(shards, true);
  assert.ok(ref);
  const rel = new Float32Array(GRID_SIZE);
  for (let p = 0; p < GRID_SIZE; p++) {
    const x = p % W, y = Math.floor(p / W);
    rel[p] = 0.4 * Math.sin(x / 5) + 0.3 * Math.cos(y / 4) + ((x - 26) ** 2 + (y - 5) ** 2 <= 4 ? 6 : 0);
  }
  const day = replayDayAgainst(readShard(ref), rel, 'test');
  assert.deepEqual(day.ready, [1, 1, 1, 1]);
  assert.deepEqual(day.background, { fixed: 'test' });
  frames.forEach((f, i) => {
    const temps = rawTemps({ tMin: f.tMin, step: f.step, pixels: f.pixels } as Raw);
    const level = median(temps);
    const expected = segment(temps, temps.map((_, p) => level + (rel[p] ?? 0)));
    assert.equal(day.dets[i]?.length, expected.detections.length, `frame ${i}`);
  });
  assert.equal(day.dets[0]?.length, 0, 'the always-on heater is in the reference, so an empty room is empty');
  assert.ok((day.dets[3]?.length ?? 0) >= 1, 'the person is found');
});
