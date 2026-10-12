import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileLocationAssetStore } from '../src/infrastructure/location-config/file-location-asset-store.js';
import { queryRows } from '../src/infrastructure/postgres/query-rows.js';
import { FileLocationDraftRepository } from '../src/infrastructure/location-config/file-location-draft-repository.js';
import { FileRegistryMutationCoordinator } from '../src/infrastructure/location-config/file-registry-mutation-coordinator.js';
import { atomicWriteNodesConfig, readNodesConfig, recoverNodesConfig } from '../src/infrastructure/location-config/file-nodes-config.js';
import { initializeFileLocationPersistence } from '../src/infrastructure/location-config/file-location-storage.js';
import { parseTrustedLegacyBaseline } from '../src/infrastructure/location-config/legacy-location-mapper.js';
import { exposeLocationCandidate, parseLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import { StartLocationEditDraftUseCase } from '../src/modules/location-config/use-cases/start-location-edit-draft.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';
import { PublishLocationUseCase } from '../src/modules/location-config/use-cases/publish-location.js';
import { buildRegistry, buildRegistryFromLocationDocuments } from '../src/edge/registry.js';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { isSnapshot } from '../src/web/store.js';
import { Provisioning } from '../src/edge/provisioning.js';
import { InvalidLocationDocumentError, MAX_LOCATION_DOCUMENT_BYTES, MAX_POLYGON_POINTS, createLocationId, parseLocationDocument, type LocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { LocationConflictError, LocationDraftNotFoundError, LocationStorageUnavailableError, type LocationDraft } from '../src/modules/location-config/domain/location-records.js';
import { syncDirectory, syncFileDescriptor, syncFileHandle } from '../src/shared/directory-sync.js';

function tempDirectory(): string { return mkdtempSync(join(tmpdir(), 'tmedge-location-storage-')); }

test('directory sync skips the unsupported Windows directory flush while file flush errors still propagate', async () => {
  const directory = tempDirectory();
  const file = join(directory, 'durable.txt');
  try {
    writeFileSync(file, 'durable');
    const descriptor = openSync(file, 'r+');
    try { assert.doesNotThrow(() => syncFileDescriptor(descriptor)); } finally { closeSync(descriptor); }
    assert.throws(() => syncFileDescriptor(descriptor), (error: { code?: string }) => error.code === 'EBADF');
    await assert.rejects(syncFileHandle({ sync: async () => { throw new Error('file sync failed'); } }), /file sync failed/);
    assert.doesNotThrow(() => syncDirectory(directory));
    if (process.platform !== 'win32') assert.throws(() => syncDirectory(join(directory, 'missing')), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('PostgreSQL row extraction supports SELECT and DML RETURNING result shapes', () => {
  const rows = [{ revision: '4' }];
  assert.deepEqual(queryRows<{ revision: string }>(rows), rows);
  assert.deepEqual(queryRows<{ revision: string }>([rows, 1]), rows);
  assert.throws(() => queryRows(null), /row list/);
});

test('NODES_CONFIG writes preserve pre-rename state and report post-rename durability uncertainty', async () => {
  const directory = tempDirectory();
  try {
    const { nodesPath } = writeConfigFiles(directory, {
      schemaVersion: 2, revision: 0, nodes: [], publishedLocations: [],
    });
    const original = readFileSync(nodesPath);
    const candidate = { schemaVersion: 2 as const, revision: 1, nodes: [], publishedLocations: [] };
    assert.throws(() => atomicWriteNodesConfig(nodesPath, candidate, {
      rename: () => { throw new Error('injected rename failure'); },
    }), /injected rename failure/);
    assert.deepEqual(readFileSync(nodesPath), original, 'a pre-rename failure leaves the old registry bytes authoritative');

    let failDirectorySync = true;
    const operations = {
      syncDirectory: (path: string) => {
        if (failDirectorySync) throw new Error('injected directory flush failure');
        syncDirectory(path);
      },
    };
    const committed = atomicWriteNodesConfig(nodesPath, candidate, operations);
    assert.deepEqual(committed, {
      kind: 'committed', durability: 'unconfirmed', revision: 1, contentSha256: committed.contentSha256,
    });
    assert.equal(readNodesConfig(nodesPath).revision, 1, 'the post-rename candidate is visible');
    assert.throws(() => recoverNodesConfig(nodesPath, committed.revision, committed.contentSha256, operations), /injected directory flush failure/);
    failDirectorySync = false;
    assert.doesNotThrow(() => recoverNodesConfig(nodesPath, committed.revision, committed.contentSha256, operations));
    assert.equal(readNodesConfig(nodesPath).revision, 1, 'recovery synchronizes the exact committed winner');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('revision-zero legacy baseline preserves the registry spatial envelope without authored shape provenance', async () => {
  const directory = tempDirectory();
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory, { nodes: [] });
    const site = seedSite() as { floors: Array<Record<string, unknown>> };
    site.floors[0]!.zones = [{ id: 'seed-zone', name: 'Seed zone', polygon: [[-10, -10], [410, -10], [400, 300]] }];
    site.floors[0]!.tables = [{ id: 'SEED-TABLE', name: 'Seed table', zone: 'seed-zone', x: 0, y: 100, width: 40, height: 60, capacity: 1 }];
    writeFileSync(sitePath, `${JSON.stringify(site)}\n`);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      const snapshot = await persistence.snapshots.readSnapshot();
      const baseline = snapshot.locations.find((location) => location.locationId === 'seed-floor')?.history[0]?.document;
      assert.ok(baseline);
      const restored = parseTrustedLegacyBaseline(JSON.parse(JSON.stringify(baseline)));
      assert.deepEqual(restored.zones[0]?.polygon, [[-10, -10], [410, -10], [400, 300]]);
      assert.equal(restored.tables[0]?.shape, undefined, 'legacy rectangles remain untagged');
      assert.deepEqual(restored.tables[0]?.rect, { x: 0, y: 100, width: 40, height: 60 });
      assert.equal(restored.tables[0]?.seats[0]?.x, -35, 'generated perimeter seats retain their legacy off-floor coordinate');
      assert.deepEqual(restored, baseline, 'file snapshot reconstruction preserves the same revision-zero values');
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file legacy edits preserve exact-base geometry through a second publish and restart', async () => {
  const directory = tempDirectory();
  let persistence: ReturnType<typeof initializeFileLocationPersistence> | null = null;
  try {
    const site = legacyBridgeSite();
    const legacyNodes = { nodes: [{
      uid: 'aa:bb:cc:dd:ee:09', label: 'Legacy owner', floor: 'seed-floor',
      pose: { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['SEED-TABLE'],
    }] };
    const originalRegistry = buildRegistry(site, legacyNodes);
    const originalTable = originalRegistry.tables.get('SEED-TABLE')!;
    const { sitePath, nodesPath } = writeConfigFiles(directory, legacyNodes);
    writeFileSync(sitePath, `${JSON.stringify(site)}\n`);
    const dataDir = join(directory, 'legacy-data');
    persistence = initializeFileLocationPersistence(sitePath, nodesPath, dataDir);
    const start = new StartLocationEditDraftUseCase({
      drafts: persistence.drafts, snapshots: persistence.snapshots, mutationCoordinator: persistence.coordinator, now: () => 10,
      createDraftId: () => '00000000-0000-4000-8000-000000000061',
    });
    let draftUpdateTime = 20;
    const save = new SaveLocationDraftUseCase({ drafts: persistence.drafts, published: persistence.published, now: () => draftUpdateTime });
    const first = await start.execute({ creatorId: 'legacy-editor', locationId: 'seed-floor', expectedPublishedRevision: 0 });
    assert.equal(first.draft.document.sensorAssignments[0]?.owns[0], 'SEED-TABLE', 'revision-zero edit retains the existing sensor/table assignment');
    assert.equal(first.draft.legacySpatial?.basePublishedRevision, 0);
    assert.deepEqual(first.draft.legacySpatial?.outline, legacyBridgeOutline());
    assert.equal(first.draft.legacySpatial?.zones[0]?.polygon[0]?.[0], -10);
    assert.equal(first.draft.legacySpatial?.tables[0]?.seats[0]?.x, -35);

    const edit = exposeLocationCandidate(first.draft.document, first.draft.legacySpatial);
    assert.equal('legacySpatial' in edit, false, 'server-derived provenance is absent from the edit payload');
    const forged = structuredClone(edit) as Record<string, unknown>;
    forged.legacySpatial = first.draft.legacySpatial;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: forged }), /server-managed/i);

    const changedOutline = structuredClone(edit) as { outline: number[][] };
    changedOutline.outline[0]![0] = -11;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: changedOutline }), /outline|finite number/i);
    const changedZone = structuredClone(edit) as { zones: Array<{ polygon: number[][] }> };
    changedZone.zones[0]!.polygon[0]![0] = -11;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: changedZone }), /polygon|finite number/i);
    const resized = structuredClone(edit) as { widthCm: number; heightCm: number };
    resized.widthCm = 401;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: resized }), /outline|polygon|finite number/i,
      'changing floor dimensions disables exact-base geometry grandfathering');
    const resizedHeight = structuredClone(edit) as { widthCm: number; heightCm: number };
    resizedHeight.heightCm = 299;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: resizedHeight }), /outline|polygon|finite number/i,
      'changing either base dimension requires strict validation of inherited spatial fields');
    const changedSeat = structuredClone(edit) as { tables: Array<{ seats: Array<{ x: number }> }> };
    changedSeat.tables[0]!.seats[0]!.x = -34;
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: changedSeat }), /seat|finite number/i);
    const newlyShaped = structuredClone(edit) as { tables: Array<Record<string, unknown>> };
    delete newlyShaped.tables[0]!.rect;
    newlyShaped.tables[0]!.shape = { type: 'rect', x: 20, y: 20, width: 40, height: 60 };
    await assert.rejects(save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: newlyShaped }), /seat|finite number/i,
      'off-floor inherited seats cannot be grandfathered once an authored shape is supplied');

    const acceptedFirst = structuredClone(edit) as { name: string };
    acceptedFirst.name = 'Legacy floor edited';
    const savedFirst = await save.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 1, document: acceptedFirst });
    assert.equal(savedFirst.draft.draftRevision, 2);
    const runtime = {
      prepare: () => 'prepared', refresh: (prepared: string) => prepared, activate: () => undefined, quarantine: () => undefined,
    };
    const publish = new PublishLocationUseCase({
      drafts: persistence.drafts, published: persistence.published, snapshots: persistence.snapshots,
      mutationCoordinator: persistence.coordinator, runtime, now: () => 30,
    });
    await publish.execute({ creatorId: 'legacy-editor', draftId: first.draft.draftId, expectedDraftRevision: 2, expectedPublishedRevision: 0 });

    const second = await new StartLocationEditDraftUseCase({
      drafts: persistence.drafts, snapshots: persistence.snapshots, mutationCoordinator: persistence.coordinator, now: () => 40,
      createDraftId: () => '00000000-0000-4000-8000-000000000062',
    }).execute({ creatorId: 'legacy-editor', locationId: 'seed-floor', expectedPublishedRevision: 1 });
    assert.equal(second.draft.legacySpatial?.basePublishedRevision, 1,
      'the second edit pins provenance to its immediate immutable base revision');
    assert.deepEqual({ ...second.draft.legacySpatial!, basePublishedRevision: 0 }, first.draft.legacySpatial,
      'the second edit retains only the same inherited spatial values');
    const acceptedSecond = exposeLocationCandidate(second.draft.document, second.draft.legacySpatial) as { name: string };
    acceptedSecond.name = 'Legacy floor edited twice';
    draftUpdateTime = 50;
    const savedSecond = await save.execute({ creatorId: 'legacy-editor', draftId: second.draft.draftId, expectedDraftRevision: 1, document: acceptedSecond });
    assert.deepEqual({ ...savedSecond.draft.legacySpatial!, basePublishedRevision: 0 }, first.draft.legacySpatial);
    await publish.execute({ creatorId: 'legacy-editor', draftId: second.draft.draftId, expectedDraftRevision: 2, expectedPublishedRevision: 1 });

    const history = await persistence.published.listHistory('seed-floor');
    assert.deepEqual(history.map((item) => item.revision), [0, 1, 2], 'the immutable revision-zero baseline remains available for exact-base validation');
    assert.deepEqual({ ...history[2]?.legacySpatial!, basePublishedRevision: 0 }, history[1]?.legacySpatial,
      'the second immutable revision retains geometry while pinning provenance to its own base');
    assert.equal(history[2]?.document.name, 'Legacy floor edited twice');
    const snapshot = await persistence.snapshots.readSnapshot();
    const active = snapshot.locations.find((item) => item.locationId === 'seed-floor')?.history.at(-1);
    assert.deepEqual(active?.legacySpatial?.outline, legacyBridgeOutline());
    assert.deepEqual(active?.legacySpatial?.zones[0]?.polygon, [[-10, -10], [410, -10], [400, 300]]);

    const runtimeNodes = JSON.parse(readFileSync(nodesPath, 'utf8')) as unknown;
    const registry = buildRegistryFromLocationDocuments(site, runtimeNodes, [parseLocationDocument(active!.document)], new Map([['seed-floor', active!.legacySpatial!]]));
    const preparedTable = registry.tables.get('SEED-TABLE')!;
    assert.deepEqual(preparedTable.seats, originalTable.seats, 'seat coordinates, identities, sides, indices and neighbor graph match the legacy registry');
    assert.equal(preparedTable.owner, originalTable.owner);
    assert.deepEqual(preparedTable.coveredBy, originalTable.coveredBy, 'coverage uses the original legacy seat positions');
    for (const seat of preparedTable.seats) assert.equal(registry.seatIndex.get(seat.id)?.seat, seat);
    assert.deepEqual(site, legacyBridgeSite(), 'candidate preparation leaves the active site seed untouched');
    const emitted = new OccupancyEngine(registry, 'edge-legacy-bridge').snapshot(100);
    assert.equal(emitted.version, 2);
    assert.equal(emitted.floors[0]?.outline.length, 257);
    assert.deepEqual(emitted.floors[0]?.zones[0]?.polygon, [[-10, -10], [410, -10], [400, 300]]);
    assert.equal(emitted.floors[0]?.tables[0]?.shape, undefined, 'normalized legacy rectangles remain untagged in v2');
    assert.equal(emitted.floors[0]?.tables[0]?.seats[0]?.x, -35);
    assert.equal(isSnapshot(emitted), true, 'the actual edge-generated v2 legacy snapshot keeps the v1 envelope');

    persistence.close();
    persistence = initializeFileLocationPersistence(sitePath, nodesPath, dataDir);
    const reopened = await persistence.snapshots.readSnapshot();
    const reopenedActive = reopened.locations.find((item) => item.locationId === 'seed-floor')?.history.at(-1);
    assert.deepEqual(reopenedActive?.legacySpatial, active?.legacySpatial);
    assert.equal(reopenedActive?.document.name, 'Legacy floor edited twice');
    assert.deepEqual(reopenedActive?.legacySpatial?.outline, legacyBridgeOutline());
  } finally {
    persistence?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function legacyBridgeOutline(): number[][] {
  const outline = Array.from({ length: 257 }, (_, index) => {
    const angle = (index / 257) * Math.PI * 2;
    return [200 + Math.cos(angle) * 100, 150 + Math.sin(angle) * 100];
  });
  outline[0] = [-10, -10];
  return outline;
}

function legacyBridgeSite(): { floors: Array<Record<string, unknown>> } {
  const site = seedSite() as { floors: Array<Record<string, unknown>> };
  const floor = site.floors[0]!;
  floor.outline = legacyBridgeOutline();
  floor.zones = [{ id: 'seed-zone', name: 'Seed zone', polygon: [[-10, -10], [410, -10], [400, 300]] }];
  floor.tables = [{ id: 'SEED-TABLE', name: 'Seed table', zone: 'seed-zone', x: 0, y: 100, width: 40, height: 60, capacity: 3 }];
  return site;
}

function seedSite(): unknown {
  return {
    site: { id: 'test-site', name: 'Test site' },
    floors: [{
      id: 'seed-floor', building: 'Test building', name: 'Seed floor', width: 400, height: 300,
      outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [{ id: 'seed-zone', name: 'Seed zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
      tables: [{ id: 'SEED-TABLE', name: 'Seed table', zone: 'seed-zone', x: 120, y: 100, width: 80, height: 60, capacity: 1 }],
    }],
  };
}

function locationDocument(locationId = createLocationId('edge-test', '00000000-0000-4000-8000-000000000001')): LocationDocument {
  return parseLocationDocument({
    schemaVersion: 1, locationId, name: 'New room', building: 'Test building', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'new-zone', name: 'New zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{
      id: 'NEW-TABLE', name: 'New table', zoneId: 'new-zone', capacity: 1,
      shape: { type: 'rect', x: 120, y: 100, width: 80, height: 60 },
      seats: [{ id: 'NEW-SEAT', x: 120, y: 80, neighbors: [] }],
    }],
    sensorAssignments: [],
  });
}

function publishedRevision(document: LocationDocument, revision = 1) {
  return { locationId: document.locationId, revision, createdBy: 'operator-1', createdAt: 100, document, legacySpatial: null };
}

function writeConfigFiles(directory: string, nodes: unknown = { nodes: [{ uid: 'aa:bb:cc:dd:ee:01', label: 'Existing sensor' }] }) {
  const sitePath = join(directory, 'site.json');
  const nodesPath = join(directory, 'nodes.json');
  writeFileSync(sitePath, `${JSON.stringify(seedSite())}\n`);
  writeFileSync(nodesPath, `${JSON.stringify(nodes)}\n`);
  return { sitePath, nodesPath };
}

function makeGlb(asset: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(asset), 'utf8');
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(20 + jsonLength, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  return glb;
}

test('location documents enforce shape, zone, seat and legacy sensor-pose bounds', () => {
  const valid = locationDocument();
  assert.equal(valid.locationId, 'location_edge-test_00000000-0000-4000-8000-000000000001');

  const offFloorPose = parseLocationDocument({
    ...valid,
    sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:02', pose: { x: -1000, y: 1300, heightCm: 350, yawDeg: 360, mirror: false }, owns: [] }],
  });
  assert.equal(offFloorPose.sensorAssignments[0]?.pose.x, -1000);
  assert.equal(offFloorPose.sensorAssignments[0]?.pose.y, 1300);

  assert.throws(() => parseLocationDocument({ ...valid, zones: [{ id: 'zone', name: 'Missing outline' }] }), InvalidLocationDocumentError);
  assert.throws(() => parseLocationDocument({
    ...valid, zones: [{ id: 'zone', name: 'Crossing', polygon: [[0, 0], [400, 300], [0, 200], [400, 0]] }],
  }), InvalidLocationDocumentError);
  assert.throws(() => parseLocationDocument({
    ...valid, sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:02', pose: { x: -1001, y: 80, heightCm: 350, yawDeg: 0, mirror: false }, owns: [] }],
  }), InvalidLocationDocumentError);
  assert.throws(() => parseLocationDocument({
    ...valid,
    outline: Array.from({ length: MAX_POLYGON_POINTS + 1 }, (_, index) => [index, index % 2]),
  }), new RegExp(`3\\.\\.${MAX_POLYGON_POINTS} points`));
  assert.throws(() => parseLocationDocument({ ...valid, name: 'x'.repeat(MAX_LOCATION_DOCUMENT_BYTES) }), /document exceeds/);
});

test('rectangular, circular and polygon table shapes accept valid bounds and reject invalid geometry', () => {
  const base = locationDocument();
  const seat = { id: 'shape-seat', x: 40, y: 40, neighbors: [] };
  const shapeDocument = (shape: unknown) => parseLocationDocument({
    ...base,
    tables: [{ id: 'shape-table', name: 'Shape', zoneId: 'new-zone', capacity: 1, shape, seats: [seat] }],
  });

  assert.equal(shapeDocument({ type: 'rect', x: 20, y: 20, width: 50, height: 40 }).tables[0]?.shape.type, 'rect');
  assert.equal(shapeDocument({ type: 'circle', cx: 60, cy: 60, radius: 20 }).tables[0]?.shape.type, 'circle');
  assert.equal(shapeDocument({ type: 'polygon', points: [[20, 20], [80, 20], [50, 60]] }).tables[0]?.shape.type, 'polygon');
  assert.throws(() => shapeDocument({ type: 'rect', x: 390, y: 20, width: 20, height: 40 }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'rect', x: 20, y: 20, width: 0, height: 40 }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'circle', cx: 20, cy: 60, radius: 21 }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'circle', cx: 60, cy: 60, radius: 0 }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'polygon', points: [[20, 20], [80, 20], [50, 60], [401, 40]] }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'polygon', points: [[20, 20], [50, 50], [80, 80]] }), InvalidLocationDocumentError);
  assert.throws(() => shapeDocument({ type: 'polygon', points: [[10, 10], [90, 90], [10, 80], [80, 20]] }), InvalidLocationDocumentError);
});

test('tables require exact capacity and unique table/seat IDs, with seats inside the floor', () => {
  const base = locationDocument();
  const first = base.tables[0]!;
  const second = {
    ...first, id: 'OTHER-TABLE', name: 'Other table',
    shape: { type: 'circle' as const, cx: 250, cy: 180, radius: 20 },
    seats: [{ id: 'OTHER-SEAT', x: 250, y: 180, neighbors: [] }],
  };
  const parseTables = (tables: unknown[]) => parseLocationDocument({ ...base, tables });

  assert.throws(() => parseTables([{ ...first, capacity: 2 }]), /exactly 2 seats/);
  assert.throws(() => parseTables([first, { ...second, id: first.id }]), /duplicate value/);
  assert.throws(() => parseTables([
    { ...first, capacity: 2, seats: [{ id: 'DUP-SEAT', x: 120, y: 80, neighbors: [] }, { id: 'DUP-SEAT', x: 130, y: 80, neighbors: [] }] },
    { ...second, id: 'SECOND-TABLE', seats: [{ id: 'OTHER-SEAT-2', x: 250, y: 180, neighbors: [] }] },
  ]), /duplicate value/);
  assert.throws(() => parseTables([{ ...first, seats: [{ ...first.seats[0]!, x: 401 }] }]), /finite number in 0\.\.400/);
  assert.equal(parseTables([first, second]).tables.length, 2);
});

test('seat adjacency is unique, table-local, non-self and symmetric', () => {
  const base = locationDocument();
  const first = base.tables[0]!;
  const twoSeats = {
    ...first,
    capacity: 2,
    seats: [
      { id: 'SEAT-A', x: 120, y: 80, neighbors: ['SEAT-B'] },
      { id: 'SEAT-B', x: 140, y: 80, neighbors: ['SEAT-A'] },
    ],
  };
  assert.equal(parseLocationDocument({ ...base, tables: [twoSeats] }).tables[0]?.seats.length, 2);
  assert.throws(() => parseLocationDocument({ ...base, tables: [{ ...first, seats: [{ id: 'SEAT-A', x: 120, y: 80, neighbors: ['SEAT-A'] }] }] }), /another seat on this table/);
  assert.throws(() => parseLocationDocument({ ...base, tables: [{ ...first, seats: [{ id: 'SEAT-A', x: 120, y: 80, neighbors: ['MISSING'] }] }] }), /another seat on this table/);
  assert.throws(() => parseLocationDocument({
    ...base,
    tables: [{ ...twoSeats, seats: [twoSeats.seats[0]!, { ...twoSeats.seats[1]!, neighbors: [] }] }],
  }), /adjacency must be symmetric/);
  assert.throws(() => parseLocationDocument({
    ...base,
    tables: [{ ...twoSeats, seats: [{ ...twoSeats.seats[0]!, neighbors: ['SEAT-B', 'SEAT-B'] }, twoSeats.seats[1]!] }],
  }), /duplicate value/);
  const otherTable = {
    ...first, id: 'OTHER-TABLE', name: 'Other',
    seats: [{ id: 'SEAT-OTHER', x: 250, y: 180, neighbors: [] }],
  };
  assert.throws(() => parseLocationDocument({
    ...base,
    tables: [
      { ...first, seats: [{ id: 'SEAT-A', x: 120, y: 80, neighbors: ['SEAT-OTHER'] }] },
      otherTable,
    ],
  }), /another seat on this table/);
});

test('file initialization validates then upgrades legacy NODES_CONFIG under process ownership', () => {
  const directory = tempDirectory();
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      const config = readNodesConfig(nodesPath);
      assert.equal(config.schemaVersion, 2);
      assert.equal(config.revision, 0);
      assert.deepEqual(config.nodes, [{ uid: 'aa:bb:cc:dd:ee:01', label: 'Existing sensor' }]);
      assert.equal(existsSync(`${nodesPath}.writer.lock`), true);
      const competing = new FileRegistryMutationCoordinator(nodesPath);
      assert.throws(() => competing.acquireProcessOwnership(), /already owned/);
    } finally {
      persistence.close();
    }
    assert.equal(existsSync(`${nodesPath}.writer.lock`), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file publication and a competing registry writer preserve each other under the shared coordinator', async () => {
  const directory = tempDirectory();
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      let started!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const approvalLikeWrite = persistence.coordinator.withMutationLock(async () => {
        const current = readNodesConfig(nodesPath);
        current.nodes.push({ uid: 'aa:bb:cc:dd:ee:02', label: 'Added while publishing' });
        current.revision += 1;
        atomicWriteNodesConfig(nodesPath, current);
        started();
        await held;
      });
      await ready;
      const document = locationDocument();
      const publish = persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 1, expectedPublishedRevision: null,
        revision: publishedRevision(document), assignments: [],
      }));
      release();
      await Promise.all([approvalLikeWrite, publish]);

      const config = readNodesConfig(nodesPath);
      assert.equal(config.revision, 2);
      assert.deepEqual(config.nodes.map((node) => (node as { uid: string }).uid), ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
      assert.equal((await persistence.published.getActive(document.locationId))?.activeRevision, 1);
      await assert.rejects(persistence.published.assertLocationIdAvailable('seed-floor'), LocationConflictError);

      const other = locationDocument(createLocationId('edge-test', '00000000-0000-4000-8000-000000000002'));
      const collidingSeat = { ...other, tables: [{ ...other.tables[0]!, id: 'OTHER-TABLE', seats: [{ ...other.tables[0]!.seats[0]!, id: 'NEW-SEAT' }] }] };
      const beforeConflict = readFileSync(nodesPath);
      await assert.rejects(persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 2, expectedPublishedRevision: null,
        revision: publishedRevision(parseLocationDocument(collidingSeat)), assignments: [],
      })), LocationConflictError);
      assert.deepEqual(readFileSync(nodesPath), beforeConflict, 'a rejected collision leaves the durable registry unchanged');
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file publication applies the same RGB sensor visibility rule as PostgreSQL', async () => {
  const directory = tempDirectory();
  try {
    const sensorUid = 'aa:bb:cc:dd:ee:03';
    const site = seedSite() as { floors: Array<Record<string, unknown>> };
    site.floors[0]!.visibility = 'console';
    const { sitePath, nodesPath } = writeConfigFiles(directory, {
      nodes: [{
        uid: sensorUid, label: 'RGB sensor', rgb: true, floor: 'seed-floor',
        pose: { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false }, owns: ['SEED-TABLE'],
      }],
    });
    writeFileSync(sitePath, `${JSON.stringify(site)}\n`);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      const base = locationDocument(createLocationId('edge-test', '00000000-0000-4000-8000-000000000004'));
      const publicDocument = parseLocationDocument({
        ...base,
        sensorAssignments: [{
          uid: sensorUid,
          pose: { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false },
          owns: ['NEW-TABLE'],
        }],
      });
      const before = readFileSync(nodesPath);
      await assert.rejects(persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 0, expectedPublishedRevision: null,
        revision: publishedRevision(publicDocument), assignments: publicDocument.sensorAssignments,
      })), /RGB sensor .* cannot be assigned to a public location/);
      assert.deepEqual(readFileSync(nodesPath), before, 'an invalid public RGB placement leaves the registry unchanged');

      const baseline = await persistence.published.getActive('seed-floor');
      assert.equal(baseline?.history[0]?.document.visibility, 'console');
      const consoleDocument = parseLocationDocument({ ...locationDocument('seed-floor'), name: 'Console floor rename', visibility: 'console' });
      const baseRevision = baseline!.history[0]!;
      const consoleCandidate = parseLocationCandidate(consoleDocument, {
        revision: 0, document: baseRevision.document, legacySpatial: baseRevision.legacySpatial,
      }, 0);
      const newDocument = locationDocument();
      assert.equal(newDocument.visibility, 'public', 'new documents default to public');
      await persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 0, expectedPublishedRevision: 0,
        revision: { ...publishedRevision(consoleCandidate.document), legacySpatial: consoleCandidate.legacySpatial },
        assignments: consoleCandidate.document.sensorAssignments,
      }));
      assert.equal((await persistence.published.getActive(consoleDocument.locationId))?.history[0]?.document.visibility, 'console');
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy console-only visibility survives bootstrap and cannot be edited into a public location', async () => {
  const directory = tempDirectory();
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory);
    const site = seedSite() as { floors: Array<Record<string, unknown>> };
    site.floors[0]!.visibility = 'console';
    writeFileSync(sitePath, `${JSON.stringify(site)}\n`);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      const baseline = await persistence.published.getActive('seed-floor');
      assert.equal(baseline?.history[0]?.document.visibility, 'console');
      const attemptedPublicEdit = parseLocationDocument({ ...locationDocument('seed-floor'), name: 'Renamed', visibility: 'public' });
      const baseRevision = baseline!.history[0]!;
      const publicCandidate = parseLocationCandidate(attemptedPublicEdit, {
        revision: 0, document: baseRevision.document, legacySpatial: baseRevision.legacySpatial,
      }, 0);
      const before = readFileSync(nodesPath);
      await assert.rejects(persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 0, expectedPublishedRevision: 0,
        revision: { ...publishedRevision(publicCandidate.document), legacySpatial: publicCandidate.legacySpatial },
        assignments: publicCandidate.document.sensorAssignments,
      })), LocationConflictError);
      assert.deepEqual(readFileSync(nodesPath), before);

      const newDocument = locationDocument();
      assert.equal(newDocument.visibility, 'public', 'new documents receive the server public default');
      await persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
        expectedRegistryRevision: 0, expectedPublishedRevision: null,
        revision: publishedRevision(newDocument), assignments: [],
      }));
      assert.equal((await persistence.published.getActive(newDocument.locationId))?.history[0]?.document.visibility, 'public');
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file provisioning preserves published-location overrides and advances the shared registry revision', async () => {
  const directory = tempDirectory();
  try {
    const document = locationDocument();
    const initial = {
      schemaVersion: 2 as const,
      revision: 7,
      nodes: [],
      publishedLocations: [{
        locationId: document.locationId,
        activeRevision: 1,
        revisions: [publishedRevision(document)],
      }],
    };
    const { sitePath, nodesPath } = writeConfigFiles(directory, initial);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'));
    try {
      const provisioning = new Provisioning(persistence.registry, {
        token: 'p'.repeat(32), nodesPath, sitePath, auditPath: join(directory, 'audit.jsonl'),
        mutationCoordinator: persistence.coordinator,
      });
      provisioning.ready();
      const queued = provisioning.request({ uid: 'aa:bb:cc:dd:ee:03', label: 'New sensor' }, 'test');
      assert.equal(queued.status, 'pending');
      if (queued.status !== 'pending') throw new Error('Expected a pending request');
      await provisioning.approve(queued.request.id, 'operator-1');

      const after = readNodesConfig(nodesPath);
      assert.equal(after.revision, 8);
      assert.deepEqual(after.publishedLocations, initial.publishedLocations);
      assert.deepEqual(after.nodes, [{ uid: 'aa:bb:cc:dd:ee:03', label: 'New sensor' }]);
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file drafts, published history, registry and immutable asset bytes survive repository restart', async () => {
  const directory = tempDirectory();
  const siteAndNodes = writeConfigFiles(directory);
  const dataDir = join(directory, 'persistent-data');
  const document = locationDocument();
  const draftId = '00000000-0000-4000-8000-000000000030';
  const assetBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let persistence = initializeFileLocationPersistence(siteAndNodes.sitePath, siteAndNodes.nodesPath, dataDir);
  let assetId = '';
  try {
    const draft: LocationDraft = {
      draftId, creatorId: 'operator-restart', locationId: document.locationId,
      draftRevision: 1, basePublishedRevision: null, createdAt: 10, updatedAt: 10, document,
    };
    await persistence.drafts.createDraft(draft);
    const savedDraft = await persistence.drafts.saveDraft(
      draft.creatorId, draftId, 1, { document: parseLocationDocument({ ...document, name: 'Saved before restart' }), legacySpatial: null }, 20,
    );
    assert.equal(savedDraft.draft.draftRevision, 2);
    const asset = await persistence.assets.put('operator-restart', 'floor-plan', 'image/png', assetBytes, 30);
    assetId = asset.assetId;

    await persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
      expectedRegistryRevision: 0, expectedPublishedRevision: null,
      revision: publishedRevision(document), assignments: [],
    }));
    await persistence.coordinator.withMutationLock(() => persistence.published.commitWithinMutation({
      expectedRegistryRevision: 1, expectedPublishedRevision: 1,
      revision: publishedRevision(parseLocationDocument({ ...document, name: 'Second published revision' }), 2), assignments: [],
    }));
  } finally {
    persistence.close();
  }

  try {
    persistence = initializeFileLocationPersistence(siteAndNodes.sitePath, siteAndNodes.nodesPath, dataDir);
    const reopenedDraft = await persistence.drafts.getDraft('operator-restart', draftId);
    assert.equal(reopenedDraft?.draftRevision, 2);
    assert.equal(reopenedDraft?.document.name, 'Saved before restart');
    const reopenedHistory = await persistence.published.listHistory(document.locationId);
    assert.deepEqual(reopenedHistory.map((item) => item.revision), [1, 2]);
    assert.equal((await persistence.published.getActive(document.locationId))?.history.at(-1)?.document.name, 'Second published revision');
    const registryDocument = readNodesConfig(siteAndNodes.nodesPath);
    assert.equal(registryDocument.revision, 2);
    assert.deepEqual(registryDocument.nodes, [{ uid: 'aa:bb:cc:dd:ee:01', label: 'Existing sensor' }]);
    assert.equal((await persistence.assetMetadata.getAssetMetadata('operator-restart', assetId))?.byteLength, assetBytes.length);
    assert.deepEqual((await persistence.assets.read('operator-restart', assetId))?.bytes, assetBytes);
  } finally {
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file provisioning applies a post-rename registration and blocks later writes until exact recovery', async () => {
  const directory = tempDirectory();
  let failDirectorySync = false;
  const operations = {
    syncDirectory: (path: string) => {
      if (failDirectorySync) throw new Error('injected directory flush failure');
      syncDirectory(path);
    },
  };
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory);
    const persistence = initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data'), operations);
    try {
      const provisioning = new Provisioning(persistence.registry, {
        token: 'p'.repeat(32), nodesPath, sitePath, auditPath: join(directory, 'audit.jsonl'),
        mutationCoordinator: persistence.coordinator, nodesConfigWriteOperations: operations,
      });
      const first = provisioning.request({ uid: 'aa:bb:cc:dd:ee:04', label: 'First sensor' }, 'test');
      const second = provisioning.request({ uid: 'aa:bb:cc:dd:ee:05', label: 'Second sensor' }, 'test');
      assert.equal(first.status, 'pending');
      assert.equal(second.status, 'pending');
      if (first.status !== 'pending' || second.status !== 'pending') throw new Error('Expected pending requests');

      failDirectorySync = true;
      const approved = await provisioning.approve(first.request.id, 'operator-1');
      assert.equal(approved.uid, first.request.uid);
      assert.equal(persistence.registry.nodes.has(first.request.uid), true, 'the in-memory registry applies the renamed candidate');
      assert.equal(provisioning.statusOf(first.request.uid), 'registered');
      assert.equal(provisioning.requests().some((request) => request.id === first.request.id), false, 'the applied request leaves the pending queue');
      assert.equal(readNodesConfig(nodesPath).revision, 1, 'the candidate is visible after rename');

      await assert.rejects(provisioning.approve(second.request.id, 'operator-1'), /registry storage is unavailable|unavailable/i,
        'a later registry write is blocked while readback and directory sync fail');
      assert.equal(persistence.registry.nodes.has(second.request.uid), false);
      assert.equal(readNodesConfig(nodesPath).revision, 1);

      failDirectorySync = false;
      const retried = await provisioning.approve(second.request.id, 'operator-1');
      assert.equal(retried.uid, second.request.uid);
      assert.equal(persistence.registry.nodes.has(second.request.uid), true);
      assert.equal(readNodesConfig(nodesPath).revision, 2);
    } finally { persistence.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file draft storage is creator-private and uses compare-and-swap revisions', async () => {
  const directory = tempDirectory();
  try {
    let failDirectorySync = false;
    const operations = {
      syncDirectory: (path: string) => {
        if (failDirectorySync) throw new Error('injected draft directory flush failure');
        syncDirectory(path);
      },
    };
    const repository = new FileLocationDraftRepository(
      join(directory, 'data'), new FileRegistryMutationCoordinator(join(directory, 'nodes.json')), operations,
    );
    const document = locationDocument();
    const draft: LocationDraft = {
      draftId: '00000000-0000-4000-8000-000000000010', creatorId: 'operator-1', locationId: document.locationId,
      draftRevision: 1, basePublishedRevision: null, createdAt: 10, updatedAt: 10, document,
    };
    await repository.createDraft(draft);
    assert.equal(await repository.getDraft('operator-2', draft.draftId), null);
    await assert.rejects(repository.saveDraft('operator-2', draft.draftId, 1, { document, legacySpatial: null }, 20), LocationDraftNotFoundError);
    await assert.rejects(repository.saveDraft('operator-1', draft.draftId, 0, { document, legacySpatial: null }, 20), LocationConflictError);

    const updated = parseLocationDocument({ ...document, name: 'Renamed room' });
    const saves = await Promise.allSettled([
      repository.saveDraft('operator-1', draft.draftId, 1, { document: updated, legacySpatial: null }, 20),
      repository.saveDraft('operator-1', draft.draftId, 1, { document: updated, legacySpatial: null }, 20),
    ]);
    assert.equal(saves.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(saves.filter((item) => item.status === 'rejected' && item.reason instanceof LocationConflictError).length, 1);
    assert.equal((await repository.getDraft('operator-1', draft.draftId))?.draftRevision, 2);

    failDirectorySync = true;
    const applied = await repository.saveDraft('operator-1', draft.draftId, 2, { document: parseLocationDocument({ ...updated, name: 'Applied with uncertain durability' }), legacySpatial: null }, 30);
    assert.equal(applied.kind, 'committed');
    assert.equal(applied.durability, 'unconfirmed');
    assert.equal(applied.draft.draftRevision, 3);
    assert.equal((await repository.getDraft('operator-1', draft.draftId))?.draftRevision, 3,
      'reads report the visible revision even when parent-directory flush failed');

    await assert.rejects(repository.saveDraft('operator-1', draft.draftId, 3, { document: updated, legacySpatial: null }, 40), LocationStorageUnavailableError,
      'the same draft writer remains latched while exact revision recovery fails');
    assert.equal((await repository.getDraft('operator-1', draft.draftId))?.draftRevision, 3);
    failDirectorySync = false;
    const recovered = await repository.saveDraft('operator-1', draft.draftId, 3, { document: updated, legacySpatial: null }, 40);
    assert.equal(recovered.durability, 'confirmed');
    assert.equal(recovered.draft.draftRevision, 4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file asset storage validates signatures and self-contained GLB bytes and isolates owners', async () => {
  const directory = tempDirectory();
  try {
    const store = new FileLocationAssetStore(directory, { now: () => 123, uuid: () => '00000000-0000-4000-8000-000000000020' });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const metadata = await store.put('operator-1', 'floor-plan', 'image/png', png);
    assert.deepEqual((await store.read('operator-1', metadata.assetId))?.bytes, Buffer.from(png));
    assert.equal(await store.read('operator-2', metadata.assetId), null);
    assert.equal(await store.getAssetMetadata('operator-2', metadata.assetId), null);
    const bytesPath = join(directory, 'location-assets', createHash('sha256').update('operator-1').digest('hex'), `${metadata.assetId}.bin`);
    rmSync(bytesPath);
    await assert.rejects(store.read('operator-1', metadata.assetId), LocationStorageUnavailableError);
    await assert.rejects(store.put('operator-1', 'floor-plan', 'image/jpeg', png), /signature/);
    await assert.rejects(store.saveAssetMetadata({ ...metadata, assetId: '00000000-0000-4000-8000-000000000099', creatorId: '   ' }), /Asset metadata is invalid/);
    await assert.rejects(store.saveAssetMetadata({ ...metadata, assetId: '00000000-0000-4000-8000-000000000098', byteLength: 20 * 1024 * 1024 + 1 }), /Asset metadata is invalid/);

    const glbStore = new FileLocationAssetStore(directory, { uuid: () => '00000000-0000-4000-8000-000000000021' });
    const glb = makeGlb({ asset: { version: '2.0' } });
    const model = await glbStore.put('operator-1', 'model', 'model/gltf-binary', glb);
    assert.deepEqual((await glbStore.read('operator-1', model.assetId))?.bytes, glb);
    await assert.rejects(glbStore.put('operator-1', 'model', 'model/gltf-binary', makeGlb({
      asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/model.bin' }],
    })), /external resource URIs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid legacy config fails without rewriting the last known-good NODES_CONFIG', () => {
  const directory = tempDirectory();
  try {
    const { sitePath, nodesPath } = writeConfigFiles(directory);
    const before = readFileSync(nodesPath);
    const invalidSite = { ...(seedSite() as Record<string, unknown>), unexpected: true };
    writeFileSync(sitePath, JSON.stringify(invalidSite));
    assert.throws(() => initializeFileLocationPersistence(sitePath, nodesPath, join(directory, 'data')));
    assert.deepEqual(readFileSync(nodesPath), before);
    assert.equal(existsSync(`${nodesPath}.writer.lock`), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
