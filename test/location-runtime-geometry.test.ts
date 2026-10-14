import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegistry, buildRegistryFromLocationDocuments } from '../src/edge/registry.js';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { EdgeLocationPublicationRuntime } from '../src/edge/location-publication-runtime.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { activeLocationModelDispositions, locationModelPresentationDisposition, type LocationAssetProvenance } from '../src/modules/location-config/domain/location-assets.js';
import type { PublishedLocationState } from '../src/modules/location-config/domain/location-records.js';
import { generateSeats } from '../src/shared/seats.js';
import { tableBounds, tableSurfaceDistance } from '../src/shared/table-geometry.js';
import { isSnapshot } from '../src/web/store.js';

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

test('public furniture assignments select strict v3 while furniture-free and console-only projection stays v2', () => {
  const site = { site: { id: 'test', name: 'Test' }, floors: [] };
  const assignment = { assetId: '00000000-0000-4000-8000-000000000031', scale: 1, yawDeg: 0, elevationM: 0 };
  const publicFurniture = parseLocationDocument({
    ...baseDoc('location_test_00000000-0000-4000-8000-000000000032'),
    furnitureDefaults: { table: assignment },
  });
  const publicRegistry = buildRegistryFromLocationDocuments(site, { nodes: [] }, [publicFurniture]);
  const emitted = new OccupancyEngine(publicRegistry, 'edge-a').snapshot(1);
  assert.equal(publicRegistry.snapshotVersion, 3);
  assert.equal(emitted.version, 3);
  assert.deepEqual(emitted.floors[0]?.furnitureDefaults, { table: assignment });
  assert.equal(isSnapshot(emitted), true);

  const furnitureFree = parseLocationDocument(baseDoc('location_test_00000000-0000-4000-8000-000000000033'));
  const noFurniture = new OccupancyEngine(buildRegistryFromLocationDocuments(site, { nodes: [] }, [furnitureFree]), 'edge-a').snapshot(1);
  assert.equal(noFurniture.version, 2);
  assert.equal(Object.hasOwn(noFurniture.floors[0]!, 'furnitureDefaults'), false);

  const consoleFurniture = parseLocationDocument({
    ...baseDoc('location_test_00000000-0000-4000-8000-000000000034'),
    visibility: 'console', furnitureDefaults: { table: assignment },
  });
  const mixed = buildRegistryFromLocationDocuments(site, { nodes: [] }, [furnitureFree, consoleFurniture]);
  assert.equal(mixed.snapshotVersion, 2, 'console-only furniture does not select public v3 emission');
  const internal = new OccupancyEngine(mixed, 'edge-a').snapshot(1);
  internal.version = 3;
  internal.floors.find((floor) => floor.id === consoleFurniture.locationId)!.furnitureDefaults = { table: assignment };
  const projected = EdgeRuntime.prototype.publicSnapshot.call({}, internal, { reg: mixed } as never);
  assert.equal(projected.version, 2, 'version selection uses the emitted public floor payload');
  assert.deepEqual(projected.floors.map((floor) => floor.id), [furnitureFree.locationId]);
  assert.equal(projected.floors.some((floor) => Object.hasOwn(floor, 'furnitureDefaults')), false,
    'console-only references are not emitted to the public target');
});

test('v2 model disposition distinguishes authored 2D-only, retained legacy-static, and uploaded models', () => {
  const site = { site: { id: 'test', name: 'Test' }, floors: [] };
  const base = {
    schemaVersion: 1, locationId: 'location_test_00000000-0000-4000-8000-000000000003', name: 'Studio', building: 'North',
    visibility: 'public', widthCm: 500, heightCm: 400,
    outline: [[0, 0], [500, 0], [500, 400], [0, 400]],
    zones: [{ id: 'zone', name: 'Room', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }], tables: [], sensorAssignments: [],
  };
  const transform = {
    scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 },
  };
  const authored2d = parseLocationDocument(base);
  const twoDDisposition = locationModelPresentationDisposition(authored2d, {});
  assert.equal(twoDDisposition, 'explicit-none');
  const twoDSnapshot = new OccupancyEngine(buildRegistryFromLocationDocuments(site, { nodes: [] }, [authored2d], new Map(), new Map([[authored2d.locationId, twoDDisposition!]])), 'edge-a').snapshot(1);
  assert.equal(twoDSnapshot.version, 2);
  assert.equal(twoDSnapshot.floors[0]?.model, null, 'an authored no-model revision suppresses any static fallback');

  const legacyModelId = '00000000-0000-4000-8000-000000000005';
  const legacyStatic = parseLocationDocument({ ...base, locationId: 'location_test_00000000-0000-4000-8000-000000000017', modelAssetId: legacyModelId, modelTransform: transform });
  const legacyProvenance: LocationAssetProvenance = { modelAssetId: { kind: 'legacy-static', basePublishedRevision: 0, locationId: legacyStatic.locationId, assetId: legacyModelId } };
  const legacyDisposition = locationModelPresentationDisposition(legacyStatic, legacyProvenance);
  assert.equal(legacyDisposition, 'legacy-fallback');
  assert.equal(locationModelPresentationDisposition(legacyStatic, legacyProvenance, 0), 'legacy-fallback', 'trusted revision-zero static metadata retains catalog fallback');
  assert.equal(locationModelPresentationDisposition(authored2d, {}, 0), undefined, 'raw seed without a static marker keeps the legacy no-hint state');
  const activeDispositions = activeLocationModelDispositions([
    { locationId: legacyStatic.locationId, activeRevision: 0, history: [{ locationId: legacyStatic.locationId, revision: 0, createdBy: 'seed', createdAt: 0, document: legacyStatic, assetProvenance: legacyProvenance }] },
    { locationId: authored2d.locationId, activeRevision: 1, history: [{ locationId: authored2d.locationId, revision: 1, createdBy: 'manager', createdAt: 1, document: authored2d, assetProvenance: {} }] },
  ]);
  assert.deepEqual(activeDispositions.get(legacyStatic.locationId), 'legacy-fallback');
  assert.deepEqual(activeDispositions.get(authored2d.locationId), 'explicit-none');
  const legacySnapshot = new OccupancyEngine(buildRegistryFromLocationDocuments(site, { nodes: [] }, [legacyStatic], new Map(), new Map([[legacyStatic.locationId, legacyDisposition!]])), 'edge-a').snapshot(1);
  assert.equal(Object.hasOwn(legacySnapshot.floors[0]!, 'model'), false, 'retained seed-static models preserve catalog fallback without becoming uploaded descriptors');

  const uploaded = parseLocationDocument({ ...base, modelAssetId: '00000000-0000-4000-8000-000000000004', modelTransform: transform });
  const uploadedSnapshot = new OccupancyEngine(buildRegistryFromLocationDocuments(site, { nodes: [] }, [uploaded]), 'edge-a').snapshot(1);
  assert.deepEqual(uploadedSnapshot.floors[0]?.model, { assetId: uploaded.modelAssetId, transform });
});

test('generated source activates in the registry and emits only the strict v2 room discriminator', () => {
  const site = { site: { id: 'test', name: 'Test' }, floors: [] };
  const generated = parseLocationDocument({ ...baseDoc('location_test_00000000-0000-4000-8000-000000000024'), proceduralRoom: 'simple-rectangle-v1' });
  const registry = buildRegistryFromLocationDocuments(site, { nodes: [] }, [generated]);
  assert.equal(registry.floors[0]?.proceduralRoom, 'simple-rectangle-v1');
  assert.equal(registry.floors[0]?.model, undefined);
  assert.equal(locationModelPresentationDisposition(generated, {}), undefined, 'generated geometry has no GLB or explicit-none model disposition');

  const snapshot = new OccupancyEngine(registry, 'edge-a').snapshot(1);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.floors[0]?.proceduralRoom, 'simple-rectangle-v1');
  assert.equal(Object.hasOwn(snapshot.floors[0]!, 'model'), false);
  assert.equal(isSnapshot(snapshot), true);

  const modelConflict = structuredClone(snapshot);
  modelConflict.floors[0]!.model = null;
  assert.equal(isSnapshot(modelConflict), false, 'procedural and model source keys cannot coexist');
  const unknownVersion = structuredClone(snapshot);
  unknownVersion.floors[0]!.proceduralRoom = 'simple-rectangle-v2' as 'simple-rectangle-v1';
  assert.equal(isSnapshot(unknownVersion), false, 'unknown room versions reject');

  const mismatchedDimensions = structuredClone(snapshot);
  mismatchedDimensions.floors[0]!.width += 1;
  assert.equal(isSnapshot(mismatchedDimensions), false, 'generated outlines must match the declared dimensions');
  const reorderedCorners = structuredClone(snapshot);
  reorderedCorners.floors[0]!.outline = [[0, 0], [400, 300], [400, 0], [0, 300]];
  assert.equal(isSnapshot(reorderedCorners), false, 'generated outlines must use the canonical top-left clockwise corner order');
  const nonRectangular = structuredClone(snapshot);
  nonRectangular.floors[0]!.outline = [[0, 0], [400, 0], [200, 300]];
  assert.equal(isSnapshot(nonRectangular), false, 'generated outlines reject non-rectangular polygons');

  const legacyNonRectangular = structuredClone(snapshot);
  delete legacyNonRectangular.floors[0]!.proceduralRoom;
  legacyNonRectangular.floors[0]!.outline = [[0, 0], [400, 0], [200, 300]];
  assert.equal(isSnapshot(legacyNonRectangular), true, 'marker-absent legacy v2 outlines keep their prior polygon envelope');

  const v1 = structuredClone(snapshot);
  v1.version = 1;
  delete v1.floors[0]!.proceduralRoom;
  for (const table of v1.floors[0]!.tables) delete table.shape;
  assert.equal(isSnapshot(v1), true, 'the existing v1 shape envelope stays valid');
  v1.floors[0]!.proceduralRoom = 'simple-rectangle-v1';
  assert.equal(isSnapshot(v1), false, 'v1 rejects the new floor key');
});

test('unrelated publication preparation preserves revision-zero static fallback and restart omits its uploaded hint', () => {
  const legacyId = 'iw-maker-a';
  const legacyDocument = parseLocationDocument({ ...baseDoc(legacyId), modelAssetId: '00000000-0000-4000-8000-000000000015', modelTransform: identityTransform() });
  const legacyProvenance: LocationAssetProvenance = { modelAssetId: { kind: 'legacy-static', basePublishedRevision: 0, locationId: legacyId, assetId: legacyDocument.modelAssetId! } };
  const siteSeed = {
    site: { id: 'test', name: 'Test' },
    floors: [{ id: legacyId, building: 'North', name: 'Legacy room', width: 500, height: 400,
      outline: [[0, 0], [500, 0], [500, 400], [0, 400]], zones: [{ id: 'zone', name: 'Room', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }],
      tables: [], model: { assetId: legacyDocument.modelAssetId, transform: legacyDocument.modelTransform } }],
  };
  const state: PublishedLocationState = { locationId: legacyId, activeRevision: 0, history: [{ locationId: legacyId, revision: 0, createdBy: 'seed', createdAt: 0, document: legacyDocument, assetProvenance: legacyProvenance }] };
  const candidate = parseLocationDocument({ ...baseDoc('location_test_00000000-0000-4000-8000-000000000016') });
  const prepared: { registry?: ReturnType<typeof buildRegistryFromLocationDocuments> } = {};
  const fakeRuntime = {
    prepareGeneration(registry: ReturnType<typeof buildRegistryFromLocationDocuments>) { prepared.registry = registry; return {} as never; },
    refreshPreparedGeneration(prepared: never) { return prepared; },
    activatePreparedGeneration() {},
    quarantine() {},
  };
  const adapter = new EdgeLocationPublicationRuntime(fakeRuntime as never, siteSeed);
  adapter.prepare({ registryRevision: 0, nodes: [], locations: [state] }, candidate, null, 'explicit-none');
  const preparedRegistry = prepared.registry;
  assert.ok(preparedRegistry);
  assert.equal(preparedRegistry.floors.find((floor) => floor.id === legacyId)?.modelDisposition, 'legacy-fallback',
    'preparing a different location retains the trusted revision-zero static disposition');
  const snapshot = new OccupancyEngine(preparedRegistry!, 'edge-a').snapshot(1);
  const legacyFloor = snapshot.floors.find((floor) => floor.id === legacyId)!;
  assert.equal(Object.hasOwn(legacyFloor, 'model'), false, 'the seed model never leaks as an uploaded descriptor');
  assert.equal(snapshot.floors.find((floor) => floor.id === candidate.locationId)?.model, null, 'the candidate remains explicitly 2D-only');

  const restartDispositions = activeLocationModelDispositions([state]);
  const restartedRegistry = buildRegistryFromLocationDocuments(siteSeed, { nodes: [] }, [], new Map(), restartDispositions);
  const restarted = new OccupancyEngine(restartedRegistry, 'edge-a').snapshot(1).floors.find((floor) => floor.id === legacyId)!;
  assert.equal(Object.hasOwn(restarted, 'model'), false, 'revision-zero fallback survives a rebuilt registry');
});

function baseDoc(locationId: string) {
  return {
    schemaVersion: 1,
    locationId,
    name: 'Studio', building: 'North', visibility: 'public', widthCm: 500, heightCm: 400,
    outline: [[0, 0], [500, 0], [500, 400], [0, 400]],
    zones: [{ id: 'zone', name: 'Room', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }],
    tables: [], sensorAssignments: [],
  };
}
function identityTransform() {
  return { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } };
}
