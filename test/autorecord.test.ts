import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOLD_MS, PREROLL_MS, RecordSwitch, recordModeOf } from '../src/algo/autorecord.js';
import { FrameStore } from '../src/algo/frames.js';
import { TrainingSpool } from '../src/algo/training-spool.js';

const UID = '2c:cf:67:0b:c0:94';
const raw = (frame: number, receivedAt: number) => ({ uid: UID, frame, receivedAt, tMin: 20, step: 0.1,
  pixels: Array.from({ length: 768 }, (_, i) => (i + frame) % 256) });

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'autorecord-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a box nobody configured records in auto, without anyone pressing record', () => withDir((dir) => {
  assert.equal(new RecordSwitch(join(dir, 'recording.on')).mode, 'auto');
}));

test('a box explicitly switched off stays off, and one explicitly recording keeps recording everything', () => withDir((dir) => {
  const flag = join(dir, 'recording.on');
  writeFileSync(flag, '1');
  assert.equal(new RecordSwitch(flag).mode, 'on');
  new RecordSwitch(flag).setMode('off');
  assert.equal(new RecordSwitch(flag).mode, 'off');
  assert.equal(readFileSync(flag, 'utf8'), '0', 'a rollback to the on/off release must not start recording');
}));

test('in auto an empty room is not kept, but the frames just before a person appears are', () => withDir((dir) => {
  const s = new RecordSwitch(join(dir, 'recording.on'));
  const kept: number[] = [];
  const t0 = 1_000_000;
  // Six seconds of empty room at 1 Hz; only the last PREROLL_MS of it survives.
  for (let i = 0; i < 6; i++) s.gate(UID, () => kept.push(i), t0 + i * 1000);
  assert.equal(kept.length, 0);
  s.presence(UID, 0, t0 + 5500);
  assert.equal(kept.length, 0, 'a report with nobody in it starts nothing');
  s.presence(UID, 1, t0 + 5500);
  assert.deepEqual(kept, [1, 2, 3, 4, 5], 'pre-roll is written in arrival order');
  assert.ok(s.capturing(t0 + 5500));
  // While somebody is there, and for HOLD_MS after, frames are written at once.
  s.gate(UID, () => kept.push(6), t0 + 6000);
  s.gate(UID, () => kept.push(7), t0 + 5500 + HOLD_MS);
  assert.deepEqual(kept.slice(-2), [6, 7]);
  // Then it stops again by itself.
  s.gate(UID, () => kept.push(8), t0 + 5500 + HOLD_MS + 1);
  assert.equal(kept.at(-1), 7);
  assert.ok(!s.capturing(t0 + 5500 + HOLD_MS + 1));
  assert.ok(PREROLL_MS < HOLD_MS);
}));

test('a person at one sensor does not record another sensor\'s empty room', () => withDir((dir) => {
  const s = new RecordSwitch(join(dir, 'recording.on'));
  let other = 0;
  s.presence(UID, 2, 1000);
  s.gate('aa:bb:cc:dd:ee:ff', () => { other += 1; }, 1500);
  assert.equal(other, 0);
}));

test('off keeps nothing even with people, on keeps everything without them', () => withDir((dir) => {
  const s = new RecordSwitch(join(dir, 'recording.on'));
  let n = 0;
  s.setMode('off');
  s.presence(UID, 3, 1000);
  s.gate(UID, () => { n += 1; }, 1000);
  assert.equal(n, 0);
  s.setMode('on');
  s.gate('aa:bb:cc:dd:ee:ff', () => { n += 1; }, 1000);
  assert.equal(n, 1);
}));

test('the console may send a mode or the older on/off, and nothing else is read as off', () => {
  assert.equal(recordModeOf({ mode: 'auto' }), 'auto');
  assert.equal(recordModeOf({ on: true }), 'on');
  assert.equal(recordModeOf({ on: false }), 'off');
  assert.equal(recordModeOf({ mode: 'sometimes' }), null);
  assert.equal(recordModeOf({}), null);
});

test('auto mode puts a detected person\'s thermal and RGB frames in the PostgreSQL outbox, paired', () => withDir((dir) => {
  const spool = new TrainingSpool(join(dir, 'outbox'), join(dir, 'recording.on'));
  assert.equal(spool.stats().mode, 'auto');
  const frames = new FrameStore();
  const now = Date.now();
  const empty = raw(1, now);
  frames.addRaw(empty);
  spool.raw(empty, {});
  const files = () => readdirSync(join(dir, 'outbox')).filter((f) => f.endsWith('.json'));
  assert.equal(files().length, 0, 'nothing written while nobody is there');
  // The detector reports a person for that frame; the held RAW is written.
  spool.presence(UID, 1);
  const msg = raw(2, Date.now());
  frames.addRaw(msg);
  spool.raw(msg, {});
  spool.offer(UID, Buffer.from([255, 216, 255, 217]), msg.receivedAt + 50, frames, false);
  const rows = files().map((f) => JSON.parse(readFileSync(join(dir, 'outbox', f), 'utf8')) as Record<string, unknown>);
  assert.equal(rows.filter((r) => r.kind === 'thermal').length, 2);
  const rgb = rows.find((r) => r.kind === 'rgb');
  assert.equal(rgb?.thermalId, rows.find((r) => r.kind === 'thermal' && r.frame === 2)?.id);
  assert.ok(spool.stats().capturing);
}));
