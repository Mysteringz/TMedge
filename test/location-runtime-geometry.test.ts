import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegistry, buildRegistryFromLocationDocuments } from '../src/edge/registry.js';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { generateSeats } from '../src/shared/seats.js';
import { tableBounds, tableSurfaceDistance } from '../src/shared/table-geometry.js';

test('circle and polygon seat generation gives every seat a stable symmetric perimeter graph', () => {
  for (const shape of [
    { type: 'circle' as const, cx: 200, cy: 160, radius: 50 },
    { type: 'polygon' as const, points: [[140, 120], [260, 120], [240, 210], [160, 210]] as [number, number][] },
  ]) {
    const seats = generateSeats('TABLE', shape, 6);
    assert.equal(seats.length, 6);
    assert.equal(new Set(seats.map((seat) => seat.id)).size, 6);
    for (const seat of seats) {
      assert.ok(seat.neighbors.length >= 2);
      for (const neighbor of seat.neighbors) assert.ok(seats.find((item) => item.id === neighbor)?.neighbors.includes(seat.id));
    }
  }
});

test('table geometry derives compatible bounds and measures actual surfaces', () => {
  const circle = { type: 'circle' as const, cx: 50, cy: 50, radius: 20 };
  const polygon = { type: 'polygon' as const, points: [[100, 40], [150, 40], [125, 90]] as [number, number][] };
  assert.deepEqual(tableBounds(circle), { x: 30, y: 30, width: 40, height: 40 });
  assert.equal(tableSurfaceDistance(circle, { type: 'rect', x: 70, y: 40, width: 20, height: 20 }), 0);
  assert.equal(tableSurfaceDistance(polygon, { type: 'rect', x: 160, y: 40, width: 20, height: 20 }), 10);
});

test('trusted legacy seat assembly derives indexes and coverage from exact original coordinates', () => {
  const site = {
    site: { id: 'test', name: 'Test' },
    floors: [{
      id: 'legacy-floor', building: 'North', name: 'Legacy floor', width: 400, height: 300,
      outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [{ id: 'legacy-zone', name: 'Legacy zone', polygon: [[-10, -10], [410, -10], [400, 300]] }],
      tables: [{ id: 'LEGACY-TABLE', name: 'Wall table', zone: 'legacy-zone', x: 0, y: 100, width: 40, height: 60, capacity: 3 }],
    }],
  };
  const nodes = { nodes: [{
    uid: 'aa:bb:cc:dd:ee:11', label: 'Legacy owner', floor: 'legacy-floor',
    pose: { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['LEGACY-TABLE'],
  }] };
  const seedBefore = structuredClone(site);
  const legacyRegistry = buildRegistry(site, nodes);
  const legacyTable = legacyRegistry.tables.get('LEGACY-TABLE')!;
  assert.equal(legacyTable.seats[0]?.x, -35);
  assert.equal(legacyTable.owner, 'aa:bb:cc:dd:ee:11');

  const document = parseLocationDocument({
    schemaVersion: 1, locationId: 'legacy-floor', name: 'Legacy floor', building: 'North', visibility: 'public', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'legacy-zone', name: 'Legacy zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{
      id: 'LEGACY-TABLE', name: 'Wall table', zoneId: 'legacy-zone', capacity: 3,
      shape: { type: 'rect', x: 20, y: 20, width: 40, height: 60 },
      seats: legacyTable.seats.map((seat) => ({
        id: seat.id, x: 0, y: 0, side: seat.side, index: seat.index, neighbors: [...seat.neighbors],
      })),
    }],
    sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:11', pose: { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['LEGACY-TABLE'] }],
  });
  const legacySpatial = {
    basePublishedRevision: 0,
    zones: [{ id: 'legacy-zone', polygon: [[-10, -10], [410, -10], [400, 300]] as [number, number][] }],
    tables: [{
      id: 'LEGACY-TABLE', rect: { x: 0, y: 100, width: 40, height: 60 },
      seats: legacyTable.seats.map(({ id, x, y }) => ({ id, x, y })),
    }],
  };
  const candidate = buildRegistryFromLocationDocuments(site, nodes, [document], new Map([['legacy-floor', legacySpatial]]));
  const candidateTable = candidate.tables.get('LEGACY-TABLE')!;
  assert.deepEqual(candidateTable.seats, legacyTable.seats, 'coordinates and exact neighbor identity match the original registry');
  assert.deepEqual(candidateTable.coveredBy, legacyTable.coveredBy);
  assert.equal(candidateTable.owner, legacyTable.owner);
  for (const seat of candidateTable.seats) assert.equal(candidate.seatIndex.get(seat.id)?.seat, seat);
  assert.deepEqual(site, seedBefore, 'preparing the detached candidate does not mutate the active site seed');

  const explicitLegacy = structuredClone(site) as { floors: Array<{ tables: Array<Record<string, unknown>> }> };
  explicitLegacy.floors[0]!.tables[0]!.seats = legacyTable.seats.map((seat) => ({
    id: seat.id, x: seat.x, y: seat.y, side: seat.side, index: seat.index, neighbors: seat.neighbors,
  }));
  assert.throws(() => buildRegistry(explicitLegacy, nodes), /number in 0\.\.400/, 'the public seed parser stays strict for authored explicit off-floor seats');
});

test('trusted owner validation uses real legacy seats rather than coordinates that fit temporary placeholders', () => {
  const site = {
    site: { id: 'test', name: 'Test' },
    floors: [{
      id: 'legacy-floor', building: 'North', name: 'Legacy floor', width: 400, height: 300,
      outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [{ id: 'legacy-zone', name: 'Legacy zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
      tables: [{ id: 'LEGACY-TABLE', name: 'Wall table', zone: 'legacy-zone', x: 0, y: 100, width: 40, height: 60, capacity: 1 }],
    }],
  };
  const nodes = { nodes: [{
    uid: 'aa:bb:cc:dd:ee:12', label: 'Incorrect legacy owner', floor: 'legacy-floor',
    pose: { x: 316, y: 130, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['LEGACY-TABLE'],
  }] };
  assert.throws(() => buildRegistry(site, nodes), /cannot see all of its seats/);
  const document = parseLocationDocument({
    schemaVersion: 1, locationId: 'legacy-floor', name: 'Legacy floor', building: 'North', visibility: 'public', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'legacy-zone', name: 'Legacy zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{ id: 'LEGACY-TABLE', name: 'Wall table', zoneId: 'legacy-zone', capacity: 1,
      shape: { type: 'rect', x: 20, y: 20, width: 40, height: 60 }, seats: [{ id: 'LEGACY-TABLE-L1', x: 0, y: 0, neighbors: [] }] }],
    sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:12', pose: { x: 316, y: 130, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['LEGACY-TABLE'] }],
  });
  const legacySpatial = {
    basePublishedRevision: 0, zones: [],
    tables: [{ id: 'LEGACY-TABLE', rect: { x: 0, y: 100, width: 40, height: 60 }, seats: [{ id: 'LEGACY-TABLE-L1', x: -35, y: 130 }] }],
  };
  assert.throws(
    () => buildRegistryFromLocationDocuments(site, nodes, [document], new Map([['legacy-floor', legacySpatial]])),
    /cannot see all of its seats/,
    'an owner that sees a (0, 130) placeholder must not pass when it cannot see the inherited (-35, 130) seat',
  );
});

test('location documents assemble into a complete shape-aware registry with exact seat identity and model metadata', () => {
  const document = parseLocationDocument({
    schemaVersion: 1,
    locationId: 'location_test_00000000-0000-4000-8000-000000000001',
    name: 'Studio', building: 'North', visibility: 'public', widthCm: 500, heightCm: 400,
    outline: [[0, 0], [500, 0], [500, 400], [0, 400]],
    zones: [{ id: 'room-zone', name: 'Room', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }],
    tables: [{
      id: 'STUDIO-TABLE', name: 'Round table', zoneId: 'room-zone', capacity: 2,
      shape: { type: 'circle', cx: 250, cy: 200, radius: 45 },
      seats: [
        { id: 'STUDIO-SEAT-A', x: 250, y: 280, neighbors: ['STUDIO-SEAT-B'] },
        { id: 'STUDIO-SEAT-B', x: 250, y: 120, neighbors: ['STUDIO-SEAT-A'] },
      ],
    }],
    sensorAssignments: [],
    modelAssetId: '00000000-0000-4000-8000-000000000002',
    modelTransform: {
      scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 },
    },
  });
  const site = { site: { id: 'test', name: 'Test' }, floors: [] };
  const nodes = { schemaVersion: 2, revision: 4, nodes: [], publishedLocations: [] };
  const registry = buildRegistryFromLocationDocuments(site, nodes, [document]);
  const floor = registry.floors[0]!;
  const table = floor.tables[0]!;
  assert.equal(registry.snapshotVersion, 2);
  assert.equal(table.shape.type, 'circle');
  assert.deepEqual(table.rect, { x: 205, y: 155, width: 90, height: 90 });
  assert.deepEqual(table.seats.map((seat) => seat.id), ['STUDIO-SEAT-A', 'STUDIO-SEAT-B']);
  assert.equal(floor.model?.assetId, document.modelAssetId);
  assert.deepEqual(floor.zones[0]?.polygon, document.zones[0]?.polygon);
});
