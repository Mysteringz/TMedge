import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ingest } from '../src/edge/ingest.js';
import { ReplayStore } from '../src/edge/replay.js';
import { buildReport, CMD_SAVE_PARAMS, CMD_SET_PARAM, REPORT_BACKGROUND_READY } from '../src/edge/protocol.js';
import { requestUrl } from '../src/shared/http.js';
import { FrameStore } from '../src/algo/frames.js';
import { validate } from '../src/algo/graph.js';
import { defaultPipeline } from '../src/algo/nodes.js';
import { FEATURES, isModel } from '../src/algo/model.js';
import { ParamBroker } from '../src/algo/params.js';
import { DEFAULT_STATIC_BACKGROUND, StaticBackground } from '../src/edge/staticbg.js';
import type { EdgeRuntime } from '../src/edge/runtime.js';
import { KEY } from './fixtures.js';

const UID = '30:ed:a0:cb:f5:f8';

test('signed replay and command cursors survive an edge restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'replay-')), 'replay.jsonl');
  const opts = { port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY, cursorPath: path, now: () => 1000000 };
  const first = new Ingest(opts);
  const identity = { uid: UID, boot: 5, seq: 8, key: KEY };
  const packet = buildReport(identity, 1, { frame: 1, ta: 22, sceneMin: 22, sceneMax: 22, bgMean: 22, flags: REPORT_BACKGROUND_READY, detections: [] });
  assert.equal(first.handle(packet, '10.0.0.1').ok, true);
  const seq = first.allocateCommandSeq();
  const restarted = new Ingest(opts);
  assert.equal(restarted.handle(packet, '10.0.0.1').ok, false);
  assert.equal(restarted.allocateCommandSeq(), seq + 1);
  assert.equal(restarted.resetCursor(UID), true);
  assert.equal(new Ingest(opts).handle(packet, '10.0.0.1').ok, true);
});

test('a damaged replay journal fails closed rather than resetting trust', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'replay-')), 'replay.jsonl');
  writeFileSync(path, '["cmd",1]\n["partial"');
  assert.throws(() => new ReplayStore(path), /incomplete/);
});

test('durable admission batches disk sync, keeps the event loop responsive, and rejects concurrent duplicates', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'replay-async-')), 'replay.jsonl');
  let finish: (() => void) | undefined, syncing = 0, reports = 0;
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false },
    commandKey: KEY, cursorPath: path, journalSync: () => { syncing++; return new Promise<void>((resolve) => { finish = resolve; }); } });
  ing.on('report', () => reports++);
  const report = (uid: string) => buildReport({ uid, boot: 1, seq: 1, key: KEY }, 1,
    { frame: 1, ta: 22, sceneMin: 22, sceneMax: 22, bgMean: 22, flags: REPORT_BACKGROUND_READY, detections: [] });
  const packet = report(UID);
  const accepted = ing.handleDurable(packet, '10.0.0.1');
  const duplicate = ing.handleDurable(packet, '10.0.0.2');
  const other = ing.handleDurable(report('11:12:13:14:15:16'), '10.0.0.3');
  for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(finish, 'the async sync reached its worker');
  assert.equal(syncing, 1, 'two nodes share a durable batch');
  assert.equal(reports, 0, 'no occupancy events precede durable storage');
  assert.equal(ing.links.size, 0, 'no routes precede durable storage');
  await new Promise((r) => setImmediate(r));
  finish();
  const results = await Promise.all([accepted, duplicate, other]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(ing.links.get(UID)?.address, '10.0.0.1');
  assert.equal(reports, 2);
  assert.equal(new ReplayStore(path).cursors.get(UID)?.seq, 1);
  await ing.stop();
});

test('a failed durable batch emits no report and latches admission closed', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'replay-async-')), 'replay.jsonl');
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false },
    commandKey: KEY, cursorPath: path, journalSync: async () => { throw new Error('disk unavailable'); } });
  let reports = 0;
  ing.on('report', () => reports++);
  const packet = buildReport({ uid: UID, boot: 1, seq: 1, key: KEY }, 1,
    { frame: 1, ta: 22, sceneMin: 22, sceneMax: 22, bgMean: 22, flags: REPORT_BACKGROUND_READY, detections: [] });
  assert.equal((await ing.handleDurable(packet, '10.0.0.1')).ok, false);
  assert.equal((await ing.handleDurable(packet, '10.0.0.1')).ok, false);
  assert.equal(reports, 0);
  assert.equal(ing.links.size, 0);
  await ing.stop();
});

test('malformed request targets cannot throw out of HTTP or upgrade handlers', () => {
  for (const raw of ['http://[', '//[', '', undefined]) assert.equal(requestUrl(raw), null);
  assert.equal(requestUrl('/healthz')?.pathname, '/healthz');
});

test('graph boundary validation rejects malformed shapes, duplicate ids and invalid values', () => {
  const p = defaultPipeline(UID);
  for (const bad of [null, { ...p, edges: undefined }, { ...p, nodes: [null] }, { ...p, nodes: [...p.nodes, p.nodes[0]] }]) {
    assert.ok(validate(bad as never).length > 0);
  }
  const bad = structuredClone(p);
  bad.nodes[0]!.params = { arbitrary: 1 };
  assert.ok(validate(bad).some((p) => p.message.includes('invalid parameter')));
});

test('frame queries do not allocate rings and reboot frame numbers cannot match old detections', () => {
  const store = new FrameStore();
  for (let i = 0; i < 1000; i++) store.list(`unknown-${i}`);
  assert.equal(store.sources().length, 0);
  const msg = { uid: UID, frame: 1, tMin: 22, step: 0.1, pixels: new Array<number>(768).fill(0), receivedAt: 1000 };
  store.addReport(UID, 1, [], 1, 5);
  store.addRaw(msg);
  store.addReport(UID, 1, [], 1, 6);
  assert.equal(store.list(UID).length, 0);
  assert.equal(store.addRaw({ ...msg, receivedAt: 2000 }).receivedAt, 2000);
});

test('models must use the trained feature order and finite calibrated weights', () => {
  const valid = { version: 1, features: [...FEATURES], weights: new Array<number>(7).fill(0), threshold: 0.5, minArea: 1 };
  assert.equal(isModel(valid), true);
  assert.equal(isModel({ ...valid, features: [...FEATURES].reverse() }), false);
  assert.equal(isModel({ ...valid, weights: [Infinity, 0, 0, 0, 0, 0, 0] }), false);
  assert.equal(isModel({ ...valid, minArea: -1 }), false);
});

test('unreachable parameter reverts remain pending and survive process restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'params-'));
  let offline = false;
  let current = 60, lastCmd = 0;
  const sent: number[] = [];
  const rt = {
    cfg: { dataDir }, nodes: () => [{ uid: UID, status: { params: { min_contrast: current }, lastCmd } }],
    ingest: { sendCommand: async (_uid: string, _opcode: number, _param: number, value: number) => {
      if (offline) throw new Error('offline'); sent.push(value); return sent.length;
    } },
  } as unknown as EdgeRuntime;
  const broker = new ParamBroker(rt);
  await broker.apply({ uid: UID, nodeId: 'bg-1', param: 'min_contrast', binding: { kind: 'device', param: 'min_contrast' }, value: 90, by: 'test' });
  offline = true;
  await assert.rejects(broker.revert(UID, 'min_contrast', 'test'), /offline/);
  assert.equal(broker.changes().length, 1);
  assert.ok(readFileSync(join(dataDir, 'algo/pending-params.json'), 'utf8').includes('min_contrast'));
  const restarted = new ParamBroker(rt);
  assert.equal(restarted.changes().length, 1);
  offline = false;
  await restarted.revert(UID, 'min_contrast', 'test');
  assert.deepEqual(sent, [90, 60]);
  assert.equal(restarted.changes().length, 1, 'dispatching a datagram does not prove recovery');
  current = 60; lastCmd = 2;
  assert.equal(restarted.changes().length, 0, 'STATUS proves the recovery command landed');
  assert.equal(new ParamBroker(rt).changes().length, 0);
});

test('background history expires while offline and corrupt saved buckets cannot become trusted', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'background-')), 'saved.json');
  const opts = { ...DEFAULT_STATIC_BACKGROUND, minBuckets: 2 };
  const buckets = [1, 2].map((k) => ({ start: k * opts.bucketMs, samples: 30, rel: new Array(768).fill(0) }));
  writeFileSync(file, JSON.stringify({ version: 1, bucketMs: opts.bucketMs, buckets }));
  const bg = new StaticBackground(file, opts);
  assert.equal(bg.state(opts.bucketMs * 3).ready, true);
  assert.equal(bg.state(opts.windowMs + opts.bucketMs * 3).ready, false);
  for (const doc of [null, { version: 1, bucketMs: opts.bucketMs, buckets: [null] },
    { version: 1, bucketMs: opts.bucketMs, buckets: [buckets[0], buckets[0]] }]) {
    writeFileSync(file, JSON.stringify(doc));
    assert.equal(new StaticBackground(file, opts).state(opts.bucketMs * 3).ready, false);
  }
});

test('saving parameters cannot absorb a simultaneous temporary write and revert audit preserves the old value', async () => {
  let finishSave: (() => void) | undefined, current = 60, lastCmd = 0;
  const rt = {
    nodes: () => [{ uid: UID, status: { params: { min_contrast: current }, lastCmd } }],
    ingest: { sendCommand: async (_uid: string, opcode: number, _param: number, value: number) => {
      if (opcode === CMD_SAVE_PARAMS) await new Promise<void>((resolve) => { finishSave = resolve; });
      if (opcode === CMD_SET_PARAM) current = value;
      return ++lastCmd;
    } },
  } as unknown as EdgeRuntime;
  const broker = new ParamBroker(rt);
  const change = (value: number) => broker.apply({ uid: UID, nodeId: 'bg-1', param: 'min_contrast',
    binding: { kind: 'device', param: 'min_contrast' }, value, by: 'test' });
  await change(90);
  const saving = broker.persist(UID, 'test');
  assert.ok(finishSave);
  await assert.rejects(change(120), /save to finish/);
  assert.equal(broker.changes().length, 1);
  finishSave();
  await saving;
  assert.equal(broker.changes().length, 0);
  await change(120);
  await broker.revert(UID, 'min_contrast', 'test');
  assert.equal(current, 90);
  const entry = broker.recent().reverse().find((e) => e.action === 'revert');
  assert.equal(entry?.from, 120);
  assert.equal(entry?.to, 90);
});
