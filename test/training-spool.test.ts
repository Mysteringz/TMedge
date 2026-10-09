import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TrainingSpool } from '../src/algo/training-spool.js';
import { FrameStore } from '../src/algo/frames.js';

test('PostgreSQL outbox preserves sensor bytes and timestamps, including unmatched RGB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'training-'));
  try {
    const flag = join(dir, 'recording.on');
    writeFileSync(flag, '1');
    const spool = new TrainingSpool(dir, flag);
    const frames = new FrameStore();
    const msg = { uid: '2c:cf:67:0b:c0:94', frame: 42, receivedAt: 1000, tMin: 20, step: 0.1,
      pixels: Array.from({ length: 768 }, (_, i) => i % 256) };
    frames.addRaw(msg);
    spool.raw(msg, { pose: { mirror: true } });
    spool.offer(msg.uid, Buffer.from([255, 216, 255, 217]), 1100, frames, true);
    spool.offer(msg.uid, Buffer.from([255, 216, 255, 217]), 2000, frames, true);
    const rows = readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
    const raw = rows.find((r) => r.kind === 'thermal');
    assert.ok(raw);
    assert.deepEqual(Buffer.from(String(raw.pixels), 'base64'), Buffer.from(msg.pixels));
    assert.equal(raw.receivedAt, 1000);
    const rgb = rows.find((r) => r.at === 1100);
    assert.equal(rgb?.thermalId, raw.id);
    assert.equal(rgb?.skewMs, 100);
    assert.equal(rows.find((r) => r.at === 2000)?.thermalId, null);
    assert.equal(spool.prune(), 0);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 3);
    spool.setMode('off');
    spool.raw({ ...msg, frame: 43 }, {});
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 3);
    assert.equal(new TrainingSpool(dir, flag).recording, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
