import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLocationCoverageSuggestions } from '../src/infrastructure/location-config/location-coverage.js';
import { parseLocationDocument, type LocationSensorAssignment } from '../src/modules/location-config/domain/location-document.js';
import type { LocationRegistrySnapshot } from '../src/modules/location-config/repositories/location-storage.js';

const UID_A = 'aa:bb:cc:dd:ee:31';
const UID_B = 'aa:bb:cc:dd:ee:32';
const SITE = { site: { id: 'coverage-test', name: 'Coverage test' }, floors: [] };
const document = parseLocationDocument({
  schemaVersion: 1, locationId: 'coverage-location', name: 'Coverage', building: 'North', visibility: 'public', widthCm: 800, heightCm: 400,
  outline: [[0, 0], [800, 0], [800, 400], [0, 400]],
  zones: [{ id: 'coverage-zone', name: 'Room', polygon: [[0, 0], [800, 0], [800, 400], [0, 400]] }],
  tables: [{ id: 'coverage-table', name: 'Long table', zoneId: 'coverage-zone', capacity: 3,
    shape: { type: 'rect', x: 100, y: 150, width: 600, height: 100 },
    seats: [100, 400, 700].map((x, index) => ({ id: `seat-${index + 1}`, x, y: 200, neighbors: [] })) }],
  sensorAssignments: [],
});

test('coverage response distinguishes zero, partial and full seat coverage using the runtime projection', () => {
  const snapshot: LocationRegistrySnapshot = {
    registryRevision: 4,
    nodes: [UID_A, UID_B].map((uid) => ({ uid, label: uid, floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node' })),
    locations: [],
  };
  const none = suggest(snapshot, []);
  assert.deepEqual(none, {
    totalSeats: 3, coveredSeats: 0, bySensor: [], coveredBy: [], suggestedOwner: null,
  });

  const poseA = pose(100, 200);
  const partial = suggest(snapshot, [{ uid: UID_A, pose: poseA, owns: [] }]);
  assert.deepEqual(partial, {
    totalSeats: 3, coveredSeats: 2, bySensor: [{ uid: UID_A, coveredSeats: 2 }], coveredBy: [], suggestedOwner: null,
  });

  const union = suggest(snapshot, [
    { uid: UID_A, pose: poseA, owns: [] },
    { uid: UID_B, pose: pose(700, 200), owns: [] },
  ]);
  assert.deepEqual(union, {
    totalSeats: 3, coveredSeats: 3,
    bySensor: [{ uid: UID_A, coveredSeats: 2 }, { uid: UID_B, coveredSeats: 2 }],
    coveredBy: [], suggestedOwner: null,
  }, 'the union may cover every seat while no single sensor can own the whole table');

  const full = suggest(snapshot, [{ uid: UID_A, pose: pose(400, 200), owns: [] }]);
  assert.deepEqual(full, {
    totalSeats: 3, coveredSeats: 3, bySensor: [{ uid: UID_A, coveredSeats: 3 }],
    coveredBy: [UID_A], suggestedOwner: UID_A,
  });
});

function suggest(snapshot: LocationRegistrySnapshot, proposed: readonly LocationSensorAssignment[]) {
  const row = computeLocationCoverageSuggestions(SITE, snapshot, document, proposed)[0];
  if (!row) throw new Error('Coverage candidate table was not returned.');
  return { ...row.seatCoverage, coveredBy: row.coveredBy, suggestedOwner: row.suggestedOwner };
}

function pose(x: number, y: number): LocationSensorAssignment['pose'] {
  return { x, y, heightCm: 350, yawDeg: 0, mirror: false };
}
