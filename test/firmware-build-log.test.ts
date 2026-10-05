import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedFirmwareBuildLog } from '../src/modules/firmware/domain/firmware-build-log.js';

test('build logs account for JSONB comma-space separators at the byte boundary', () => {
  const input = Array.from({ length: 33 }, () => 'x'.repeat(3968));
  assert.equal(Buffer.byteLength(JSON.stringify(input)), 131044);
  const retained = boundedFirmwareBuildLog(input);
  assert.equal(retained.length, 32);
  assert.equal(input.length, 33, 'normalization does not modify the input');
});

test('build logs keep newest lines and respect line and character caps', () => {
  const retained = boundedFirmwareBuildLog(Array.from({ length: 450 }, (_, index) => String(index)));
  assert.equal(retained.length, 400);
  assert.equal(retained[0], '50');
  assert.equal(retained.at(-1), '449');
  assert.deepEqual(boundedFirmwareBuildLog(['x'.repeat(5000)]), ['x'.repeat(4096)]);
  assert.deepEqual(boundedFirmwareBuildLog([]), []);
});

test('multibyte and escaped log strings respect the database text byte cap', () => {
  const retained = boundedFirmwareBuildLog(Array.from({ length: 60 }, () => '热"\\\n'.repeat(1000)));
  const databaseText = `[${retained.map((line) => JSON.stringify(line)).join(', ')}]`;
  assert.ok(Buffer.byteLength(databaseText) <= 131072);
  assert.ok(retained.length > 0 && retained.length < 60);
});
