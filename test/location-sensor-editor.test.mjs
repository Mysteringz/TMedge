import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const viteEntry = require.resolve('vite', { paths: [resolve('algo-app')] });
const { build } = await import(pathToFileURL(viteEntry).href);
const bundle = await build({
  configFile: false, root: resolve('.'), logLevel: 'silent',
  build: { lib: { entry: resolve('algo-app/src/features/location-editor/model/sensors.ts'), formats: ['es'], fileName: 'location-sensor-model.js' }, write: false, minify: false },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle)?.output.find((item) => item.type === 'chunk');
assert.ok(output && output.type === 'chunk', 'Vite compiles the sensor editor model without writing a bundle');
const model = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`);
const { addSensorAssignment, changedPoseField, coverageState, ownerSeatCount, patchSensorPose, proposedSensors, removeSensorAssignment, setTableOwner } = model;

const uidA = 'aa:bb:cc:dd:ee:01';
const uidB = 'aa:bb:cc:dd:ee:02';
const document = () => ({
  name: 'Lab', building: 'North', widthCm: 1000, heightCm: 700, outline: [[0, 0], [1000, 0], [1000, 700]], zones: [], tables: [],
  sensorAssignments: [{ uid: uidA, pose: { x: 100, y: 200, heightCm: 420, yawDeg: 0, mirror: true }, owns: ['TABLE-A'] }],
});

test('sensor draft model preserves untouched pose fields and proposals exclude stale assignments', () => {
  const original = document();
  const moved = patchSensorPose(original, uidA, { x: 250, yawDeg: 30 });
  assert.deepEqual(moved.sensorAssignments[0].pose, { x: 250, y: 200, heightCm: 420, yawDeg: 30, mirror: true });
  assert.deepEqual(original.sensorAssignments[0].pose, { x: 100, y: 200, heightCm: 420, yawDeg: 0, mirror: true });
  assert.deepEqual(proposedSensors(moved, [{ uid: uidA, label: 'Sensor A', simulated: false, rgb: false, detector: 'node', pose: null }]), [
    { uid: uidA, pose: { x: 250, y: 200, heightCm: 420, yawDeg: 30, mirror: true } },
  ]);
  assert.deepEqual(proposedSensors(moved, []), []);
});

test('proposal includes every current draft sensor and no-op metre blur preserves exact fractional centimetres', () => {
  const original = document();
  const withSecond = addSensorAssignment(original, uidB, { x: 700, y: 250, heightCm: 400, yawDeg: 12.5, mirror: false });
  const stale = addSensorAssignment(withSecond, 'aa:bb:cc:dd:ee:99', { x: 300, y: 200, heightCm: 350, yawDeg: 0, mirror: false });
  const eligible = [uidA, uidB].map((uid) => ({ uid, label: uid, simulated: false, rgb: false, detector: 'node', pose: null }));
  assert.deepEqual(proposedSensors(stale, eligible).map((item) => item.uid), [uidA, uidB]);

  const fractional = { x: 125.5, y: 235.5, heightCm: 375.5, yawDeg: 37.5, mirror: true };
  assert.equal(changedPoseField(fractional, 'x', fractional.x / 100), null);
  assert.equal(changedPoseField(fractional, 'y', fractional.y / 100), null);
  assert.equal(changedPoseField(fractional, 'height', fractional.heightCm / 100), null);
  assert.equal(changedPoseField(fractional, 'yaw', fractional.yawDeg), null);
  assert.deepEqual(changedPoseField(fractional, 'x', 1.26), { x: 126 });
  assert.deepEqual(changedPoseField(fractional, 'height', 3.76), { heightCm: 376 });
});

test('sensor draft model adds explicitly completed poses and removes table ownership uniquely', () => {
  let current = addSensorAssignment(document(), uidB, { x: 400, y: 300, heightCm: 500, yawDeg: -15, mirror: false });
  current = setTableOwner(current, 'TABLE-A', uidB);
  assert.deepEqual(current.sensorAssignments.map((item) => item.owns), [[], ['TABLE-A']]);
  current = setTableOwner(current, 'TABLE-A', null);
  assert.deepEqual(current.sensorAssignments.map((item) => item.owns), [[], []]);
  current = removeSensorAssignment(current, uidB);
  assert.deepEqual(current.sensorAssignments.map((item) => item.uid), [uidA]);
  assert.equal(addSensorAssignment(current, uidA, { x: 0, y: 0, heightCm: 500, yawDeg: 0, mirror: false }), current);
});

test('seat coverage states distinguish unknown, none, partial and full and report owner count', () => {
  assert.equal(coverageState(undefined), 'unknown');
  const row = (coveredSeats) => ({ tableId: 'TABLE-A', coveredBy: [], suggestedOwner: null, seatCoverage: {
    totalSeats: 4, coveredSeats, bySensor: [{ uid: uidA, coveredSeats: 2 }],
  } });
  assert.equal(coverageState(row(0)), 'none');
  assert.equal(coverageState(row(2)), 'partial');
  assert.equal(coverageState(row(4)), 'full');
  assert.equal(ownerSeatCount(row(2), uidA), 2);
  assert.equal(ownerSeatCount(row(4), uidA), 2, 'full union coverage does not imply one sensor is a valid full-seat owner');
  assert.equal(ownerSeatCount(row(2), uidB), null);
});


test('bottom-left sensor Y edits preserve exact poses on blur and convert only the edited field', () => {
  const pose = { x: 125.5, y: 350.5, heightCm: 400.5, yawDeg: 17, mirror: true };
  assert.equal(changedPoseField(pose, 'y', 6.495, 1000), null);
  assert.deepEqual(changedPoseField(pose, 'y', 6, 1000), { y: 400 });
  assert.deepEqual({ ...pose, ...changedPoseField(pose, 'y', 6, 1000) }, { ...pose, y: 400 });
});
