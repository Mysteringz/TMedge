import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [resolve('algo-app')] })).href);
const bundle = await build({ configFile: false, root: resolve('.'), logLevel: 'silent',
  build: { lib: { entry: resolve('algo-app/src/features/location-editor/model/tables.ts'), formats: ['es'] }, write: false, minify: false } });
const chunk = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk');
const { removeTable } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);

test('removing a table deletes its seats and every ownership reference without mutating other draft data', () => {
  const original = { zones: [{ id: 'zone' }], tables: [{ id: 'remove', seats: [{ id: 'seat-a' }] }, { id: 'keep', seats: [{ id: 'seat-b' }] }],
    sensorAssignments: [{ uid: 'one', pose: { x: 100, y: 200 }, owns: ['remove', 'keep'] }, { uid: 'two', pose: { x: 300, y: 400 }, owns: ['remove'] }],
    furnitureDefaults: { chair: { assetId: 'shared-chair' } } };
  const before = structuredClone(original);
  const result = removeTable(original, 'remove');
  assert.deepEqual(result.tables, [original.tables[1]]);
  assert.deepEqual(result.sensorAssignments.map(sensor => sensor.owns), [['keep'], []]);
  assert.equal(result.zones, original.zones);
  assert.equal(result.furnitureDefaults, original.furnitureDefaults);
  assert.equal(result.sensorAssignments[0].pose, original.sensorAssignments[0].pose);
  assert.deepEqual(original, before);
  assert.equal(removeTable(original, 'missing'), original);
  assert.deepEqual(removeTable(result, 'keep').tables, [], 'removing the final table is supported');
});
