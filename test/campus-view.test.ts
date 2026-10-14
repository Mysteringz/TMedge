import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCampusView } from '../src/shared/campus-view.js';
import type { CampusView, Point } from '../src/shared/types.js';

const p = (x: number, y: number): Point => [x, y];

function validView(): CampusView {
  const floor = {
    id: 'floor-a', siteId: 'site-a', key: JSON.stringify(['site-a', 'floor-a']), edgeId: 'edge-a',
    building: 'Library', name: 'Level 1', width: 500, height: 400,
    outline: [p(0, 0), p(500, 0), p(500, 400), p(0, 400)],
    zones: [{ id: 'quiet', name: 'Quiet area', polygon: [p(0, 0), p(500, 0), p(500, 400), p(0, 400)], people: 0 }],
    tables: [{
      id: 'table-a', name: 'Table A', zoneId: 'quiet', rect: { x: 100, y: 100, width: 100, height: 80 },
      shape: { type: 'rect' as const, x: 100, y: 100, width: 100, height: 80 }, capacity: 2, occupied: 0, free: 2, status: 'ok' as const,
      seats: [
        { id: 'seat-a', x: 90, y: 140, side: 'L', index: 0, occupied: false, neighbors: ['seat-b'] },
        { id: 'seat-b', x: 210, y: 140, side: 'R', index: 0, occupied: false, neighbors: ['seat-a'] },
      ],
    }],
    totals: { seats: 2, free: 2, occupied: 0, unknownSeats: 0, tablesFullyFree: 1 },
    updatedAt: 1234, stale: false,
  };
  return { generatedAt: 2345, floors: [floor] } as CampusView;
}

test('public campus parser retains valid authored v2 and projects away unknown/private fields', () => {
  const value = validView();
  Object.assign(value, { debug: 'must not reach the student UI' });
  Object.assign(value.floors[0]!, { privateOwnerId: 'admin-a' });
  value.floors[0]!.model = {
    assetId: '00000000-0000-4000-8000-000000000001',
    transform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
  };
  const parsed = parseCampusView(value);
  assert.ok(parsed);
  assert.equal('debug' in parsed, false);
  assert.equal('privateOwnerId' in parsed.floors[0]!, false);
  assert.deepEqual(parsed.floors[0]!.model, {
    assetId: '00000000-0000-4000-8000-000000000001',
    transform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
  });
});

test('versionless public campus projection carries complete furniture references and excludes private metadata', () => {
  const value = validView();
  const floor = value.floors[0]!;
  const defaults = { table: { assetId: '00000000-0000-4000-8000-000000000021', scale: 1.25, yawDeg: 35, elevationM: 0.04 } };
  const overrides = { chair: { assetId: '00000000-0000-4000-8000-000000000022', scale: 0.75, yawDeg: -90, elevationM: 0.12 } };
  floor.furnitureDefaults = defaults;
  floor.tables[0]!.furnitureOverrides = overrides;
  Object.assign(floor, { furnitureDigest: 'private', creatorId: 'private' });
  const parsed = parseCampusView(value);
  assert.ok(parsed);
  assert.deepEqual(parsed.floors[0]!.furnitureDefaults, defaults);
  assert.deepEqual(parsed.floors[0]!.tables[0]!.furnitureOverrides, overrides);
  assert.equal('furnitureDigest' in parsed.floors[0]!, false);
  assert.equal('creatorId' in parsed.floors[0]!, false);
  assert.equal('version' in parsed, false, 'the campus projection remains versionless');

  const malformed = structuredClone(value);
  malformed.floors[0]!.tables[0]!.furnitureOverrides!.chair!.elevationM = 11;
  assert.equal(parseCampusView(malformed), null, 'versionless projections reject malformed furniture bundles');
});

test('public campus parser preserves the legacy spatial envelope for untagged tables', () => {
  const value = validView();
  const floor = value.floors[0]!;
  delete floor.tables[0]!.shape;
  floor.tables[0]!.rect.x = 0;
  floor.tables[0]!.seats[0]!.x = -35;
  floor.zones[0]!.polygon[0] = p(-20, -15);
  floor.outline[0] = p(-20, -15);
  const parsed = parseCampusView(value);
  assert.ok(parsed);
  assert.equal(parsed.floors[0]!.tables[0]!.shape, undefined);
  assert.equal(parsed.floors[0]!.tables[0]!.seats[0]!.x, -35);
  assert.deepEqual(parsed.floors[0]!.zones[0]!.polygon[0], [-20, -15]);
});

test('public campus parser retains only the canonical generated source without any model key', () => {
  const generated = validView();
  generated.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  const parsed = parseCampusView(generated);
  assert.ok(parsed);
  assert.equal(parsed.floors[0]!.proceduralRoom, 'simple-rectangle-v1');
  assert.equal(Object.hasOwn(parsed.floors[0]!, 'model'), false);

  const withModelDescriptor = validView();
  withModelDescriptor.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  withModelDescriptor.floors[0]!.model = {
    assetId: '00000000-0000-4000-8000-000000000001',
    transform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
  };
  const withExplicit2d = validView();
  withExplicit2d.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  withExplicit2d.floors[0]!.model = null;
  const unknownLiteral = validView();
  unknownLiteral.floors[0]!.proceduralRoom = 'simple-rectangle-v2' as 'simple-rectangle-v1';
  const reorderedOutline = validView();
  reorderedOutline.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  reorderedOutline.floors[0]!.outline = [p(500, 0), p(500, 400), p(0, 400), p(0, 0)];
  const mismatchedDimensions = validView();
  mismatchedDimensions.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  mismatchedDimensions.floors[0]!.width = 501;

  for (const invalid of [withModelDescriptor, withExplicit2d, unknownLiteral, reorderedOutline, mismatchedDimensions]) {
    assert.equal(parseCampusView(invalid), null);
  }
});

test('public campus parser keeps model tri-state and rejects malformed geometry, references, status and counts', () => {
  const none = validView();
  none.floors[0]!.model = null;
  assert.equal(parseCampusView(none)?.floors[0]?.model, null);
  const fallback = validView();
  assert.equal(Object.hasOwn(parseCampusView(fallback)!.floors[0]!, 'model'), false);

  const malformed: Array<(value: CampusView) => void> = [
    (value) => { value.floors[0]!.tables[0]!.shape = { type: 'polygon', points: [p(20, 20), p(40, 40), p(60, 60)] }; },
    (value) => { value.floors[0]!.tables[0]!.rect.width = 99; },
    (value) => { value.floors[0]!.tables[0]!.zoneId = 'missing-zone'; },
    (value) => { value.floors[0]!.tables[0]!.seats[0]!.neighbors = ['missing-seat']; },
    (value) => { value.floors[0]!.tables[0]!.occupied = 1; },
    (value) => { value.floors[0]!.totals.free = 1; },
    (value) => { value.floors[0]!.model = { assetId: '00000000-0000-4000-8000-000000000001', transform: { scale: { x: 1e308, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } } }; },
    (value) => { value.floors[0]!.key = JSON.stringify(['other-site', 'floor-a']); },
    (value) => { value.floors[0]!.stale = true; },
  ];
  for (const corrupt of malformed) {
    const value = structuredClone(validView());
    corrupt(value);
    assert.equal(parseCampusView(value), null);
  }
});
