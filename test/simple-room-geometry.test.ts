import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSimpleRoomRectangleOutline,
  projectSimpleRoomPoint,
  projectSimpleRoomSeat,
  projectSimpleRoomTable,
  SIMPLE_ROOM_TABLE_HEIGHT_M,
  SIMPLE_ROOM_WALL_HEIGHT_M,
} from '../src/shared/simple-room-geometry.js';

test('simple room keeps fixed heights and recognizes only the exact canonical outline', () => {
  assert.equal(SIMPLE_ROOM_WALL_HEIGHT_M, 3);
  assert.equal(SIMPLE_ROOM_TABLE_HEIGHT_M, 0.75);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [600, 0], [600, 400], [0, 400]], 600, 400), true);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [-600, 0], [-600, 400], [0, 400]], -600, 400), false);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [600, 0], [600, 400], [0, 400]], Number.POSITIVE_INFINITY, 400), false);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [600, 0], [500, 400], [0, 400]], 600, 400), false);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [600, 0], [600, 400], [0, 400], [0, 0]], 600, 400), false);
  assert.equal(isSimpleRoomRectangleOutline([[0, 0], [600, 400], [600, 0], [0, 400]], 600, 400), false);
});

test('plan coordinates project to world meters with positive X and negative Z', () => {
  assert.deepEqual(projectSimpleRoomPoint({ x: 123.45, y: 678.9 }), { x: 1.2345, z: -6.789 });
  assert.deepEqual(projectSimpleRoomPoint({ x: 0, y: 0 }), { x: 0, z: 0 });
});

test('rectangle and circle table footprints preserve authored dimensions', () => {
  assert.deepEqual(projectSimpleRoomTable({ shape: { type: 'rect', x: 10, y: 25, width: 80, height: 50 } }), {
    type: 'rect', points: [{ x: 0.1, z: -0.25 }, { x: 0.9, z: -0.25 }, { x: 0.9, z: -0.75 }, { x: 0.1, z: -0.75 }],
  });
  assert.deepEqual(projectSimpleRoomTable({ shape: { type: 'circle', cx: 250, cy: 325, radius: 75 } }), {
    type: 'circle', center: { x: 2.5, z: -3.25 }, radiusM: 0.75,
  });
});

test('concave polygon footprint preserves each projected vertex and concavity', () => {
  const points: [number, number][] = [[100, 100], [400, 100], [400, 200], [200, 200], [200, 400], [100, 400]];
  assert.deepEqual(projectSimpleRoomTable({ shape: { type: 'polygon', points } }), {
    type: 'polygon',
    points: [{ x: 1, z: -1 }, { x: 4, z: -1 }, { x: 4, z: -2 }, { x: 2, z: -2 }, { x: 2, z: -4 }, { x: 1, z: -4 }],
  });
});

test('legacy rectangle and seat projections preserve exact centimeter source coordinates', () => {
  const rect = { x: 12.34, y: 56.78, width: 90.12, height: 40.06 };
  const seat = { id: 'legacy-seat', x: 123.45, y: 234.56 };
  const sourceSeat = structuredClone(seat);
  const legacyProjection = projectSimpleRoomTable({ rect });
  const authoredProjection = projectSimpleRoomTable({ shape: { type: 'rect', ...rect } });
  assert.deepEqual(legacyProjection, authoredProjection, 'legacy rectangles and explicit rectangles use the same projection');
  assert.equal(legacyProjection.type, 'rect');
  if (legacyProjection.type !== 'rect') throw new Error('Expected a rectangular footprint.');
  assert.deepEqual(legacyProjection.points[0], { x: 0.1234, z: -0.5678 });
  assert.ok(Math.abs(legacyProjection.points[1]!.x - 1.0246) < 1e-12);
  assert.ok(Math.abs(legacyProjection.points[2]!.x - 1.0246) < 1e-12);
  assert.deepEqual(legacyProjection.points[3], { x: 0.1234, z: -0.9684 });
  assert.deepEqual(projectSimpleRoomSeat(seat), { x: 1.2345, z: -2.3456 });
  assert.deepEqual(seat, sourceSeat);
});

test('invalid non-finite geometry is rejected', () => {
  assert.throws(() => projectSimpleRoomPoint({ x: Number.NaN, y: 20 }), RangeError);
  assert.throws(() => projectSimpleRoomTable({}), TypeError);
  assert.throws(() => projectSimpleRoomTable({ shape: { type: 'circle', cx: 50, cy: 50, radius: 0 } }), RangeError);
});
