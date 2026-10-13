import assert from 'node:assert/strict';
import test from 'node:test';
import { modelTransformToWorld, planPointToWorld, sensorPoseToWorld } from '../src/shared/location-view.js';

test('plan corners map to X and negative Z with unrounded centimetre precision', () => {
  assert.deepEqual(planPointToWorld({ x: 0, y: 0 }), { x: 0, y: 0, z: 0 });
  assert.deepEqual(planPointToWorld({ x: 1234, y: 876 }), { x: 12.34, y: 0, z: -8.76 });
  assert.equal(planPointToWorld({ x: 0.5, y: 0.25 }).x, 0.005);
  assert.equal(planPointToWorld({ x: 0.5, y: 0.25 }).z, -0.0025);
});

test('sensor height maps to positive Y and yaw stays about positive Y', () => {
  assert.deepEqual(sensorPoseToWorld({ x: 125.5, y: 234.25, heightCm: 350, yawDeg: 90 }), {
    position: { x: 1.255, y: 3.5, z: -2.3425 }, yawRad: Math.PI / 2,
  });
});

test('model root transform preserves metre positions and converts each XYZ degree independently', () => {
  assert.deepEqual(modelTransformToWorld({
    scale: { x: 1, y: 2, z: 0.5 }, rotationDeg: { x: 90, y: -45, z: 180 },
    positionM: { x: 0.001, y: -2.25, z: 3.5 },
  }), {
    scale: { x: 1, y: 2, z: 0.5 },
    rotationRad: { x: Math.PI / 2, y: -Math.PI / 4, z: Math.PI },
    positionM: { x: 0.001, y: -2.25, z: 3.5 },
  });
});

test('invalid runtime coordinates fail before reaching the scene', () => {
  assert.throws(() => planPointToWorld({ x: Number.NaN, y: 0 }), /must be finite/);
});
