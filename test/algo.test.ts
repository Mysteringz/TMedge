/**
 * Claims about the algo debugger: that its graph refuses nonsense, that a
 * frame is paired with the sensor's own answer for that frame, that the
 * preview really is the firmware's detector, and that a live parameter change
 * can always be taken back.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DetectorHost } from '../src/algo/detector.js';
import { FEATURES, featuresOf, locate, type LocatorModel } from '../src/algo/model.js';
import { estimateDesks, DEFAULT_DESK } from '../src/algo/desk.js';
import { FrameStore } from '../src/algo/frames.js';
import { order, validate } from '../src/algo/graph.js';
import { defaultPipeline } from '../src/algo/nodes.js';
import { ParamBroker } from '../src/algo/params.js';
import type { FramePair } from '../src/algo/types.js';
import type { EdgeRuntime } from '../src/edge/runtime.js';
import type { ConsoleDetection, RawFrameMessage } from '../src/shared/types.js';

const UID = '30:ed:a0:cb:f5:f8';
/** The repo root, from dist/test where this runs. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function raw(frame: number, temps: number[]): RawFrameMessage {
  const tMin = Math.min(...temps);
  const step = Math.max(0.01, (Math.max(...temps) - tMin) / 255);
  return {
    uid: UID, frame, tMin, step,
    pixels: temps.map((t) => Math.round((t - tMin) / step)),
    receivedAt: 1_000 + frame,
  };
}

function scene(person: boolean): number[] {
  const f = new Array<number>(768).fill(22);
  if (person) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) f[(9 + dy) * 32 + (12 + dx)] = 31;
    }
  }
  return f;
}

test('the default graph is legal, ordered, and refuses a mistyped connection', () => {
  const p = defaultPipeline(UID);
  assert.deepEqual(validate(p), [], 'the pipeline we ship must be valid');
  const seq = order(p);
  assert.ok(seq, 'a valid graph can be ordered');
  assert.ok(seq.indexOf('bg-1') < seq.indexOf('human-1'), 'background subtraction runs before detection');
  assert.ok(seq.indexOf('proj-1') < seq.indexOf('occ-1'), 'people are placed before they are seated');

  // A thermal frame is not a set of detections, and the editor must say so
  // rather than computing nonsense.
  const bad = structuredClone(p);
  bad.edges.push({
    id: 'bad', sourceNode: 'thermal-1', sourcePort: 'frame', targetNode: 'proj-1', targetPort: 'detections',
  });
  const problems = validate(bad);
  assert.ok(problems.some((x) => /cannot connect thermal to detections/.test(x.message)),
    `expected a type complaint, got ${JSON.stringify(problems)}`);
  // That port was already fed, which is its own complaint: an input with two
  // sources is ambiguous, not a merge.
  assert.ok(problems.some((x) => /already has a source/.test(x.message)));

  const cyclic = structuredClone(p);
  cyclic.edges.push({
    id: 'loop', sourceNode: 'occ-1', sourcePort: 'occupancy', targetNode: 'occ-1', targetPort: 'tables',
  });
  assert.ok(validate(cyclic).some((x) => /cycle|already has a source/.test(x.message)));
});

test('a frame is paired with what the sensor itself decided about it', () => {
  const store = new FrameStore();
  const dets: ConsoleDetection[] = [{
    x: 12, y: 9, area: 9, contrast: 9, peak: 31, heat: 44,
    floorX: 100, floorY: 200, tableId: 'M3', counted: true, persons: 1,
  }];
  // The REPORT for a frame usually arrives before its picture does.
  store.addReport(UID, 77, dets, 1);
  const pair = store.addRaw(raw(77, scene(true)));
  assert.equal(pair.deviceDetections?.length, 1, 'the waiting report found its frame');
  assert.ok((pair.temps[9 * 32 + 12] ?? 0) > 30, 'levels came back as degrees');

  // And the other way round.
  store.addRaw(raw(78, scene(false)));
  store.addReport(UID, 78, [], 1);
  assert.equal(store.get(UID, 78)?.deviceDetections?.length, 0);
  assert.equal(store.historyTo(UID, 78).length, 2, 'history to a frame is everything up to it');
});

test('the preview is the firmware detector, not a second implementation', async (t) => {
  const host = new DetectorHost();
  if (host.unavailable) return t.skip(`no host detector here: ${host.unavailable}`);

  const frames: FramePair[] = [];
  for (let i = 0; i < 30; i++) {
    const temps = Float32Array.from(scene(i >= 25));
    frames.push({ frame: i, uid: UID, receivedAt: i, temps, tMin: 22, step: 0.1, deviceDetections: null, deviceFlags: null });
  }
  const params = {
    min_contrast: 0.6, min_peak: 1.2, noise_k: 4, min_area: 1, max_area: 60,
    bg_tau: 90, bg_frames: 10, split_sep: 1.9,
  };
  const out = await host.run(frames, params, true);
  const last = out[out.length - 1];
  assert.equal(out.length, 30);
  assert.equal(last?.detections.length, 1, 'the person who arrived is detected');
  assert.ok(Math.abs((last?.detections[0]?.x ?? 0) - 12.5) < 1.5, 'and is where we put them');
  assert.equal(last?.foreground?.length, 768, 'planes came back for the viewers');
  assert.ok((last?.background?.[0] ?? 0) > 21 && (last?.background?.[0] ?? 0) < 23, 'background learned the room');

  // A threshold above the person's contrast must lose them: this is the loop
  // the whole dashboard exists for.
  const strict = await host.run(frames, { ...params, min_peak: 20 }, false);
  assert.equal(strict[strict.length - 1]?.detections.length, 0, 'raising min peak drops the blob');
});

test('a live parameter change can always be taken back', async () => {
  const sent: { uid: string; opcode: number; arg0: number; value: number }[] = [];
  let deviceParams: Record<string, number> = { min_contrast: 60, min_peak: 120, raw_every: 0 };
  let opts = { staleMs: 10_000, releaseMs: 20_000, seatRadiusCm: 80, enterWindow: 5, enterMin: 3, mergeCm: 50 };
  const rt = {
    nodes: () => [{ uid: UID, status: { params: deviceParams } }],
    engine: {
      options: () => opts,
      setOptions: (patch: Partial<typeof opts>) => { opts = { ...opts, ...patch }; return opts; },
    },
    ingest: {
      sendCommand: async (uid: string, opcode: number, arg0 = 0, value = 0) => {
        sent.push({ uid, opcode, arg0, value });
        // A real node applies it and says so in its next STATUS.
        if (opcode === 1 && arg0 === 0) deviceParams = { ...deviceParams, min_contrast: value };
      },
    },
  } as unknown as EdgeRuntime;

  const broker = new ParamBroker(rt);
  const change = await broker.apply({
    uid: UID, nodeId: 'bg-1', param: 'min_contrast',
    binding: { kind: 'device', param: 'min_contrast' }, value: 90, by: 'test',
  });
  assert.equal(sent.length, 1, 'the sensor was actually told');
  assert.equal(change.from, 60, 'and we remember what it was');
  assert.ok(change.revertAt > change.at, 'an uncommitted change is on a timer');
  assert.equal(broker.deviceParams(UID).min_contrast, 90);

  // A second edit still reverts to the value the system had before anyone started.
  const again = await broker.apply({
    uid: UID, nodeId: 'bg-1', param: 'min_contrast',
    binding: { kind: 'device', param: 'min_contrast' }, value: 120, by: 'test',
  });
  assert.equal(again.from, 60, 'not to the middle of an experiment');

  await broker.revert(UID, 'min_contrast', 'test');
  assert.equal(broker.deviceParams(UID).min_contrast, 60, 'put back where it was');
  assert.equal(broker.changes().length, 0);

  // Edge parameters are clamped here, not trusted: this one decides what
  // students are told about a real room.
  await assert.rejects(
    broker.apply({ uid: UID, nodeId: 'occ-1', param: 'seatRadiusCm', binding: { kind: 'edge', path: 'occupancy.seatRadiusCm' }, value: 5000, by: 'test' }),
    /between 20 and 300/,
  );
  await broker.apply({ uid: UID, nodeId: 'occ-1', param: 'seatRadiusCm', binding: { kind: 'edge', path: 'occupancy.seatRadiusCm' }, value: 120, by: 'test' });
  assert.equal(opts.seatRadiusCm, 120, 'the running engine changed');
  broker.commit(UID, 'occupancy.seatRadiusCm', 'test');
  assert.equal(broker.changes().length, 0, 'a committed change is off the timer');
  assert.ok(broker.recent().some((e) => e.action === 'commit'), 'and it is in the log');
});

test('the desk estimator proposes tables where people actually sit', () => {
  // Two seat clusters 80 cm apart, as two people either side of one table,
  // and a third patch too faint to count.
  const cols = 40, rows = 24;
  const cells = new Array<number>(cols * rows).fill(0);
  const put = (xCm: number, yCm: number, weight: number) => {
    const c = Math.floor(xCm / 25), r = Math.floor(yCm / 25);
    cells[r * cols + c] = weight;
  };
  put(300, 200, 900);
  put(300, 280, 850);
  put(700, 500, 40);      // below minDwellSeconds
  const tables = [{ id: 'M1', x: 250, y: 200, width: 105, height: 167 }];

  const out = estimateDesks(cells, cols, rows, tables, DEFAULT_DESK);
  assert.equal(out.stages.clusters.length, 2, 'two seats, not one blob and not three');
  assert.equal(out.desks.length, 1, 'both seats vote for one table');
  const desk = out.desks[0];
  assert.ok(desk, 'a table was proposed');
  assert.equal(desk.matches?.tableId, 'M1', 'and it lands on the table that is really there');
  assert.ok((desk.matches?.offsetCm ?? 999) < 80, `within 80 cm, got ${desk.matches?.offsetCm}`);
  assert.ok(desk.confidence > 0, 'with a confidence to argue about');
  // The faint patch is reported as a rejected candidate rather than silently dropped.
  assert.ok(out.stages.candidates.length >= out.desks.length);
});

test('nobody has vendored a second copy of the detector into this repo', () => {
  // The preview is only honest while the debugger runs the firmware's own
  // file. A copy here would drift from the node silently, which is exactly
  // the failure this dashboard is supposed to expose rather than commit.
  const here = execFileSync('git', ['ls-files', 'src'], { cwd: REPO, encoding: 'utf8' });
  assert.ok(!/tm_detector/.test(here), 'TMedge must not contain its own tm_detector');
  assert.ok(existsSync(join(REPO, '..', 'TMsense', 'src', 'tm_detector.cpp')),
    'the debugger needs ../TMsense beside this checkout to build its preview');
});

test('the trainer and the edge compute the same features', (t) => {
  // The weights are fitted in Python and applied in TypeScript. If the two
  // ever compute a different thing from the same frame, a model would mean
  // something else on the edge than it did in training and nothing would
  // say so -- the same trap the wire format has three implementations of,
  // and the same answer: check them against each other on real numbers.
  const temps = new Float32Array(768);
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) temps[y * 32 + x] = 22 + 0.05 * x + 0.3 * Math.sin(x * 0.7) * Math.cos(y * 0.5) + rnd() * 0.16;
  }
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = (10 + dy) * 32 + (19 + dx);
      temps[i] = (temps[i] ?? 0) + 7.5 * Math.exp(-(dx * dx + dy * dy) / 2);
    }
  }

  let reference: number[][];
  try {
    const out = execFileSync('python3', [join(REPO, 'tools', 'train_human_location.py'), '--features'], {
      input: JSON.stringify(Array.from(temps)), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    reference = JSON.parse(out) as number[][];
  } catch (err) {
    return t.skip(`the trainer could not run here (numpy/OpenCV?): ${(err as Error).message.slice(0, 80)}`);
  }

  const mine = featuresOf(temps);
  assert.equal(reference.length, 768);
  assert.equal(reference[0]?.length, FEATURES.length);
  let worst = 0;
  for (let i = 0; i < 768; i++) {
    for (let j = 0; j < FEATURES.length; j++) {
      worst = Math.max(worst, Math.abs((reference[i]?.[j] ?? 0) - (mine[i * FEATURES.length + j] ?? 0)));
    }
  }
  assert.ok(worst < 1e-4, `features drift by ${worst}; the Python and TypeScript versions disagree`);
});

test('the locator finds the warm blob it was pointed at, and nothing in an empty room', () => {
  // Weights by hand rather than trained: this is about the inference path --
  // thresholding, grouping and the centroid -- not about the fit.
  const model: LocatorModel = {
    version: 1, uid: 'test', trainedAt: 0, samples: 0, positives: 0,
    features: [...FEATURES],
    // bias, above_median, local_max3, local_mean5, gradient, row, col
    weights: [-6, 7, 2, 1, 0, 0, 0],
    threshold: 0.6, minArea: 2,
    metrics: { precision: 0, recall: 0, f1: 0, heldOut: 0, medianErrorPx: 0 },
  };

  const empty = new Float32Array(768).fill(22);
  assert.equal(locate(model, empty).detections.length, 0, 'an empty room is empty');

  const one = new Float32Array(768).fill(22);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) one[(14 + dy) * 32 + (7 + dx)] = 30;
  }
  const found = locate(model, one).detections;
  assert.equal(found.length, 1, 'one person, one detection');
  assert.ok(Math.abs((found[0]?.x ?? 0) - 7) < 1.2 && Math.abs((found[0]?.y ?? 0) - 14) < 1.2,
    `placed at ${found[0]?.x},${found[0]?.y} rather than 7,14`);
  assert.ok((found[0]?.confidence ?? 0) > model.threshold);

  // Two people far apart must not become one.
  const two = new Float32Array(one);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) two[(6 + dy) * 32 + (25 + dx)] = 30;
  }
  assert.equal(locate(model, two).detections.length, 2, 'two blobs, two people');
});
