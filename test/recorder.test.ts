import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { DailyLog, Recorder } from '../src/edge/recorder.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tmedge-recorder-'));
}

test('recording queue stays below its byte cap and drains in order after backpressure', async () => {
  const releaseWrites: (() => void)[] = [];
  const lines: string[] = [];
  const log = new DailyLog(tempDir(), 16, () => new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      if (lines.length === 1) releaseWrites.push(() => callback());
      else callback();
    },
  }));

  log.write(Date.UTC(2026, 0, 1), { n: 1 });
  log.write(Date.UTC(2026, 0, 1), { n: 2 });
  log.write(Date.UTC(2026, 0, 1), { n: 3 });
  assert.equal(log.health().queuedBytes, 16);
  assert.equal(log.health().droppedRecords, 1);

  releaseWrites[0]?.();
  await log.close();
  assert.deepEqual(lines, ['{"n":1}\n', '{"n":2}\n']);
  assert.equal(log.health().healthy, true);
});

test('daily rotation waits for the prior stream to finish before opening the next file', async () => {
  const releaseWrites: (() => void)[] = [];
  const opened: string[] = [];
  const log = new DailyLog(tempDir(), 100, (file) => {
    opened.push(file);
    let writes = 0;
    return new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        if (opened.length === 1 && writes === 1) releaseWrites.push(() => callback());
        else callback();
      },
    });
  });
  log.write(Date.UTC(2026, 0, 1), { n: 1 });
  log.write(Date.UTC(2026, 0, 2), { n: 2 });
  assert.equal(opened.length, 1);
  releaseWrites[0]?.();
  await log.close();
  assert.equal(opened.length, 2);
  assert.match(opened[0] ?? '', /2026-01-01\.jsonl$/);
  assert.match(opened[1] ?? '', /2026-01-02\.jsonl$/);
});

test('write failures are counted, queued records are dropped, and a later write can recover', async () => {
  let opens = 0;
  const log = new DailyLog(tempDir(), 100, () => {
    opens += 1;
    return new Writable({ write(_chunk, _encoding, callback) {
      if (opens === 1) callback(new Error('disk full'));
      else callback();
    } });
  });
  log.write(Date.UTC(2026, 0, 1), { n: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(log.health().healthy, false);
  assert.equal(log.health().writeErrors, 1);
  assert.equal(log.health().droppedRecords, 1);
  log.write(Date.UTC(2026, 0, 1), { n: 2 });
  await log.close();
  assert.equal(log.health().healthy, true);
  assert.equal(log.health().lastSuccessfulWriteAt !== null, true);
});

test('raw recording remains absent when disabled', async () => {
  let opens = 0;
  const recorder = new Recorder(tempDir(), false, {
    openStream: () => {
      opens += 1;
      return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    },
  });
  recorder.rawFrame({ kind: 'raw', type: 1, uid: 'node-a', boot: 1, seq: 1, uptimeMs: 1,
    signed: true, frame: 1, tMin: 20, step: 1, pixels: new Uint8Array(768) }, Date.UTC(2026, 0, 1));
  await recorder.close();
  assert.equal(opens, 0);
  assert.equal(recorder.health().raw, null);
});
