import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignmentForNewOverride,
  copyFurnitureAssignment,
  effectiveFurniture,
  replaceAssignmentAsset,
  updateAssignmentFit,
} from '../algo-app/src/features/location-furniture-models/model/assignments.ts';

const roomTable = { assetId: 'table-default', scale: 1.25, yawDeg: 45, elevationM: 0.1 };
const roomChair = { assetId: 'chair-default', scale: 0.8, yawDeg: -10, elevationM: 0 };

test('table overrides replace the complete matching room default and other slots still inherit', () => {
  const defaults = { table: roomTable, chair: roomChair };
  const overrides = { table: { assetId: 'table-override', scale: 2, yawDeg: 0, elevationM: 0.25 } };
  assert.deepEqual(effectiveFurniture(defaults, overrides, 'table'), overrides.table);
  assert.deepEqual(effectiveFurniture(defaults, overrides, 'chair'), roomChair);
  assert.equal(effectiveFurniture(undefined, undefined, 'chair'), undefined);
});

test('new overrides copy all inherited fit values without mutating the room default', () => {
  const copied = assignmentForNewOverride(roomTable);
  assert.deepEqual(copied, roomTable);
  assert.notEqual(copied, roomTable);
  assert.deepEqual(assignmentForNewOverride(undefined), undefined);
  assert.deepEqual(assignmentForNewOverride(undefined, 'new-chair'), { assetId: 'new-chair', scale: 1, yawDeg: 0, elevationM: 0 });
});

test('changing the model preserves the current override fit, then inherited fit, then documented defaults', () => {
  assert.deepEqual(replaceAssignmentAsset({ assetId: 'old', scale: 3, yawDeg: 180, elevationM: 1 }, roomTable, 'new'), {
    assetId: 'new', scale: 3, yawDeg: 180, elevationM: 1,
  });
  assert.deepEqual(replaceAssignmentAsset(undefined, roomChair, 'new'), { ...roomChair, assetId: 'new' });
  assert.deepEqual(replaceAssignmentAsset(undefined, undefined, 'new'), { assetId: 'new', scale: 1, yawDeg: 0, elevationM: 0 });
});

test('fit edits update one field and copied assignments remain independent', () => {
  const copy = copyFurnitureAssignment(roomChair);
  const fitted = updateAssignmentFit(copy, 'scale', 2.4);
  assert.deepEqual(fitted, { ...roomChair, scale: 2.4 });
  assert.deepEqual(roomChair, { assetId: 'chair-default', scale: 0.8, yawDeg: -10, elevationM: 0 });
});
