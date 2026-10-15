import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AlgoRuntime } from '../src/algo/runtime.js';
import { defaultPipeline } from '../src/algo/nodes.js';
import { ParamBroker } from '../src/algo/params.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { buildRegistry } from '../src/edge/registry.js';
import { EdgeLocationPublicationRuntime } from '../src/edge/location-publication-runtime.js';
import { Provisioning } from '../src/edge/provisioning.js';
import { REPORT_BACKGROUND_READY, TYPE_REPORT, type Report } from '../src/edge/protocol.js';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { PublishLocationUseCase } from '../src/modules/location-config/use-cases/publish-location.js';
import type { LocationDraft } from '../src/modules/location-config/domain/location-records.js';
import type {
  LocationDraftRepository, LocationRegistrySnapshot, LocationRegistrySnapshotRepository,
  PublishedLocationRepository, RegistryMutationCoordinator,
} from '../src/modules/location-config/repositories/location-storage.js';
import { nodesJson, siteJson } from './fixtures.js';
import { personAt } from './fixtures.js';
import { buildFileRegistry } from '../src/infrastructure/location-config/file-location-storage.js';
import { syncDirectory } from '../src/shared/directory-sync.js';

function config(): EdgeConfig {
  return {
    edgeId: 'activation-test', keys: [], allowUnsigned: true, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-activation-')), recordRaw: false,
    consolePort: 0, consoleHost: '127.0.0.1', algoPort: 0, adminPassword: null, flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60_000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
}

function candidateDocument(withModel = false) {
  return parseLocationDocument({
    schemaVersion: 1,
    locationId: 'location_activation-test_00000000-0000-4000-8000-000000000001',
    name: 'New lab', building: 'North', visibility: 'public', widthCm: 500, heightCm: 400,
    outline: [[0, 0], [500, 0], [500, 400], [0, 400]],
    zones: [{ id: 'NEW-ZONE', name: 'Lab', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }],
    tables: [{
      id: 'NEW-ROUND-TABLE', name: 'Round table', zoneId: 'NEW-ZONE', capacity: 2,
      shape: { type: 'circle', cx: 250, cy: 200, radius: 45 },
      seats: [
        { id: 'NEW-ROUND-SEAT-A', x: 250, y: 280, neighbors: ['NEW-ROUND-SEAT-B'] },
        { id: 'NEW-ROUND-SEAT-B', x: 250, y: 120, neighbors: ['NEW-ROUND-SEAT-A'] },
      ],
    }],
    sensorAssignments: [],
    ...(withModel ? {
      modelAssetId: '00000000-0000-4000-8000-000000000002',
      modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
    } : {}),
  });
}

test('location preparation keeps active readers unchanged until a complete public generation is activated', async () => {
  const seed = siteJson();
  const registry = buildRegistry(seed, nodesJson());
  const runtime = createEdgeRuntime(config(), registry);
  const original = runtime.captureGeneration();
  const stableServices = {
    ingest: runtime.ingest, recorder: runtime.recorder, publisher: runtime.publisher,
    firmware: runtime.firmware, rollouts: runtime.rollouts, direct: runtime.direct,
    gateways: runtime.gateways, history: runtime.occupancyHistory, commandOutcomes: runtime.commandOutcomes,
    host: runtime.host, edgeDetectors: runtime.edgeDetectors,
    commandReceipts: runtime.commandReceipts, rolloutService: runtime.rolloutService,
  };
  const snapshot: LocationRegistrySnapshot = {
    registryRevision: 0,
    nodes: [...registry.nodes.values()].map((node) => ({
      uid: node.uid, label: node.label, floorId: node.floorId, pose: node.pose,
      owns: [...node.owns], simulated: node.simulated, rgb: node.rgb, detector: node.detector ?? 'node',
    })),
    locations: [],
  };
  const adapter = new EdgeLocationPublicationRuntime(runtime, seed);
  try {
    runtime.engine.setOptions({ seatRadiusCm: 123 });
    const prepared = adapter.prepare(snapshot, candidateDocument());
    const refreshed = adapter.refresh(prepared);

    assert.strictEqual(runtime.captureGeneration(), original, 'preparation does not change the active pointer');
    assert.ok(!runtime.reg.floors.some((floor) => floor.id === prepared.generation.reg.floors.at(-1)?.id));
    assert.equal(prepared.generation.reg.floors.length, registry.floors.length + 1);
    assert.equal(prepared.generation.reg.nodes.size, registry.nodes.size);
    assert.equal(prepared.generation.reg.tables.size, registry.tables.size + 1);
    assert.equal(prepared.generation.engine.options().seatRadiusCm, 123, 'debugger occupancy tuning is preserved');
    assert.equal(refreshed.publicSnapshot.version, 2);
    assert.ok(refreshed.publicSnapshot.floors.every((floor) => !floor.id || prepared.generation.reg.floors.find((item) => item.id === floor.id)?.visibility === 'public'));
    assert.equal(refreshed.publicSnapshot.floors.at(-1)?.tables[0]?.shape?.type, 'circle');
    assert.equal(refreshed.publicSnapshot.floors.at(-1)?.tables[0]?.seats[0]?.occupied, null, 'new uncovered seats start unknown');

    let emitted: unknown;
    runtime.once('snapshot', (value) => { emitted = value; });
    adapter.activate(refreshed);
    assert.strictEqual(runtime.captureGeneration(), refreshed.generation);
    assert.deepEqual(emitted, refreshed.publicSnapshot, 'the activation event and pre-serialized publisher payload use the prepared public snapshot');
    assert.strictEqual(runtime.ingest, stableServices.ingest);
    assert.strictEqual(runtime.recorder, stableServices.recorder);
    assert.strictEqual(runtime.publisher, stableServices.publisher);
    assert.strictEqual(runtime.firmware, stableServices.firmware);
    assert.strictEqual(runtime.rollouts, stableServices.rollouts);
    assert.strictEqual(runtime.direct, stableServices.direct);
    assert.strictEqual(runtime.gateways, stableServices.gateways);
    assert.strictEqual(runtime.occupancyHistory, stableServices.history);
    assert.strictEqual(runtime.commandOutcomes, stableServices.commandOutcomes);
    assert.strictEqual(runtime.host, stableServices.host);
    assert.strictEqual(runtime.edgeDetectors, stableServices.edgeDetectors);
    assert.strictEqual(runtime.commandReceipts, stableServices.commandReceipts);
    assert.strictEqual(runtime.rolloutService, stableServices.rolloutService);
  } finally {
    await runtime.stop();
  }
});

test('approval prepares an unplaced node generation and makes it live only when activated', async () => {
  const registry = buildRegistry(siteJson(), nodesJson());
  const runtime = createEdgeRuntime(config(), registry);
  const uid = 'a0:b1:c2:d3:e4:f5';
  const activate = runtime.prepareNodeRegistration({
    uid, label: 'Approved node', floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node',
  });
  try {
    assert.equal(runtime.captureGeneration().reg.nodes.has(uid), false);
    activate();
    const generation = runtime.captureGeneration();
    assert.equal(generation.reg.nodes.get(uid)?.floorId, null);
    assert.equal(generation.reg.nodes.get(uid)?.pose, null);
    assert.deepEqual(generation.reg.nodes.get(uid)?.owns, []);
  } finally {
    await runtime.stop();
  }
});

test('reports received during delayed model acknowledgement survive publication preparation and activation', async () => {
  const registry = buildRegistry(siteJson(), nodesJson());
  const runtime = createEdgeRuntime(config(), registry);
  const active = runtime.captureGeneration();
  const seed = siteJson();
  const document = candidateDocument(true);
  const draft: LocationDraft = {
    draftId: '00000000-0000-4000-8000-000000000010', creatorId: 'operator-a', locationId: document.locationId,
    draftRevision: 1, basePublishedRevision: null, createdAt: 1, updatedAt: 1, document,
    assetProvenance: { modelAssetId: { kind: 'upload', ownerId: 'operator-a' } },
  };
  const snapshot: LocationRegistrySnapshot = {
    registryRevision: 0,
    nodes: [...registry.nodes.values()].map((node) => ({
      uid: node.uid, label: node.label, floorId: node.floorId, pose: node.pose,
      owns: [...node.owns], simulated: node.simulated, rgb: node.rgb, detector: node.detector ?? 'node',
    })),
    locations: [],
  };
  let draftFetched = false;
  let locked = false;
  let acknowledgeStarted!: () => void;
  let releaseAcknowledge!: () => void;
  const started = new Promise<void>((resolve) => { acknowledgeStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseAcknowledge = resolve; });
  const drafts: LocationDraftRepository = {
    async createDraft() { throw new Error('unused'); },
    async getDraft(owner, id) { draftFetched = true; return owner === draft.creatorId && id === draft.draftId ? draft : null; },
    async getDraftForRead(owner, id) { return owner === draft.creatorId && id === draft.draftId ? draft : null; },
    async deleteDraftWithinMutation() { throw new Error('unused'); },
    async getDraftForReadWithinMutation(owner, id) { draftFetched = true; return owner === draft.creatorId && id === draft.draftId ? draft : null; },
    async listDrafts() { return []; }, async saveDraft() { throw new Error('unused'); },
  };
  const snapshots: LocationRegistrySnapshotRepository = { async readSnapshot() { return snapshot; } };
  const published: PublishedLocationRepository = {
    async assertLocationIdAvailable() {}, async getActive() { return null; }, async listActive() { return []; },
    async listHistory() { return []; }, async registryRevision() { return 0; },
    async commitWithinMutation(input) {
      assert.equal(locked, true);
      assert.equal(input.expectedRegistryRevision, 0);
      return { kind: 'committed', durability: 'confirmed', acknowledgement: 'received', registryRevision: 1, activeRevision: 1 };
    },
  };
  const coordinator: RegistryMutationCoordinator = {
    async withMutationLock(work) { locked = true; try { return await work(); } finally { locked = false; } },
    assertHealthy() { assert.equal(locked, true); }, quarantine() { throw new Error('unexpected quarantine'); },
  };
  const publication = new PublishLocationUseCase({
    drafts, published, snapshots, mutationCoordinator: coordinator,
    runtime: new EdgeLocationPublicationRuntime(runtime, seed),
    assetMetadata: {
      async saveAssetMetadata() { throw new Error('unused'); },
      async getAssetMetadata(ownerId, assetId) {
        return ownerId === draft.creatorId && assetId === document.modelAssetId ? {
          assetId, creatorId: ownerId, purpose: 'model', mediaType: 'model/gltf-binary', sha256: 'a'.repeat(64), byteLength: 20, createdAt: 1,
        } : null;
      },
    },
    modelDistributor: { async acknowledge() { acknowledgeStarted(); await blocked; } },
  });
  const table = registry.tables.get('M3')!;
  const seat = table.seats[0]!;
  const node = registry.nodes.get('30:ed:a0:cb:f5:f8')!;
  const detection = personAt(node.pose!, seat.x, seat.y);
  const reportAt = Date.now();
  const operation = publication.execute({
    creatorId: draft.creatorId, draftId: draft.draftId, expectedDraftRevision: 1, expectedPublishedRevision: null,
  });
  try {
    await started;
    assert.equal(draftFetched, true);
    assert.strictEqual(runtime.captureGeneration(), active, 'the candidate remains invisible while GLB bytes are being acknowledged');
    for (let frame = 0; frame < 5; frame += 1) {
      const report: Report = {
        type: TYPE_REPORT, kind: 'report', uid: node.uid, boot: 1, seq: frame, uptimeMs: frame * 1000, signed: false,
        frame, ta: 25, sceneMin: 20, sceneMax: 30, bgMean: 22, flags: REPORT_BACKGROUND_READY, detections: [detection],
      };
      runtime.ingest.emit('report', report, '127.0.0.1:5200', reportAt + frame * 250);
    }
    assert.equal(runtime.engine.lastDetections(node.uid).length, 1, 'the active report callback receives reports during transfer');
    releaseAcknowledge();
    const result = await operation;
    assert.equal(result.kind, 'committed');
    assert.notStrictEqual(runtime.captureGeneration(), active);
    const publicFloor = runtime.latest.floors.find((floor) => floor.id === 'iw-maker-a')!;
    const occupiedTable = publicFloor.tables.find((candidate) => candidate.id === 'M3')!;
    assert.equal(occupiedTable.seats[0]?.occupied, true, 'the prepared winner includes all seat warm-up reports received during transfer');
    assert.ok(runtime.captureGeneration().reg.floors.some((floor) => floor.id === document.locationId));
  } finally {
    releaseAcknowledge();
    await operation.catch(() => undefined);
    await runtime.stop();
  }
});

test('an asynchronous algorithm run keeps the registry generation it captured before detector work', async () => {
  const registry = buildRegistry(siteJson(), nodesJson());
  const runtime = createEdgeRuntime(config(), registry);
  const broker = new ParamBroker(runtime);
  const algo = new AlgoRuntime(runtime, broker);
  const uid = '30:ed:a0:cb:f5:f8';
  let detectorStarted!: () => void;
  let releaseDetector!: () => void;
  const started = new Promise<void>((resolve) => { detectorStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseDetector = resolve; });
  Object.defineProperty(algo.detector, 'unavailable', { value: null });
  (algo.detector as unknown as { run: (...args: unknown[]) => Promise<unknown[]> }).run = async () => {
    detectorStarted();
    await blocked;
    return [{
      index: 0, backgroundReady: true, globalShift: false, truncated: false, backgroundMean: 22, detections: [],
      background: new Float32Array(768).fill(22), diff: new Float32Array(768), foreground: new Uint8Array(768), label: new Uint8Array(768),
    }];
  };
  algo.frames.addRaw({
    uid, frame: 7, tMin: 20, step: 0.1, pixels: new Array(768).fill(0), receivedAt: Date.now(),
  });
  const operation = algo.run(defaultPipeline(uid));
  try {
    await started;
    const oldGeneration = runtime.captureGeneration();
    const changedNodes = new Map(oldGeneration.reg.nodes);
    const oldNode = changedNodes.get(uid)!;
    changedNodes.set(uid, { ...oldNode, label: 'Changed after detector started', rgb: !oldNode.rgb });
    const changedRegistry = { ...oldGeneration.reg, nodes: changedNodes };
    const prepared = runtime.prepareGeneration(changedRegistry);
    runtime.activatePreparedGeneration(runtime.refreshPreparedGeneration(prepared));
    releaseDetector();
    const result = await operation;
    const thermal = result.envelopes.find((envelope) => envelope.type === 'thermal_input')!;
    assert.equal(thermal.debug.label, oldNode.label, 'the async result uses one registry snapshot from before its await');
    assert.equal(thermal.debug.rgb, oldNode.rgb);
    assert.equal(runtime.captureGeneration().reg.nodes.get(uid)?.label, 'Changed after detector started');
  } finally {
    releaseDetector();
    await operation.catch(() => undefined);
    await algo.dispose();
    broker.stop();
    await runtime.stop();
  }
});

test('runtime quarantine remains closed for any thrown commit value', async () => {
  const runtime = createEdgeRuntime(config(), buildRegistry(siteJson(), nodesJson()));
  try {
    runtime.quarantine(undefined);
    assert.equal(runtime.isQuarantined(), true);
    assert.throws(() => runtime.captureGeneration(), { name: 'RegistryMutationQuarantinedError' });
    runtime.tick(Date.now());
    assert.equal(runtime.isQuarantined(), true);
  } finally {
    await runtime.stop();
  }
});

test('file provisioning reads and preserves wizard locations and applies each rename outcome to the active generation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-wizard-provision-'));
  const site = siteJson();
  const document = candidateDocument();
  const nodesPath = join(directory, 'nodes.json');
  const sitePath = join(directory, 'site.json');
  const nodesDocument = {
    schemaVersion: 2, revision: 5, nodes: nodesJson().nodes,
    publishedLocations: [{
      locationId: document.locationId, activeRevision: 1,
      revisions: [{ locationId: document.locationId, revision: 1, createdBy: 'seed', createdAt: 1, document }],
    }],
  };
  writeFileSync(sitePath, JSON.stringify(site));
  writeFileSync(nodesPath, JSON.stringify(nodesDocument));
  const registry = buildFileRegistry(site, nodesDocument);
  const runtime = createEdgeRuntime(config(), registry);
  let failNextDirectorySync = false;
  let failRename = false;
  const mutex: RegistryMutationCoordinator = {
    async withMutationLock(work) { return work(); }, assertHealthy() {}, quarantine() {},
  };
  const provisioning = new Provisioning(registry, {
    token: 'wizard-provisioning-token-32-characters', nodesPath, sitePath,
    auditPath: join(directory, 'audit.jsonl'), mutationCoordinator: mutex,
    registryProvider: () => runtime.captureGeneration().reg,
    prepareRegistryAddition: (node) => runtime.prepareNodeRegistration(node),
    nodesConfigWriteOperations: {
      rename(from, to) { if (failRename) throw new Error('simulated pre-rename failure'); renameSync(from, to); },
      syncDirectory(path) {
        if (failNextDirectorySync) { failNextDirectorySync = false; throw new Error('simulated post-rename directory flush failure'); }
        syncDirectory(path);
      },
    },
  });
  try {
    provisioning.ready();
    assert.equal(runtime.reg.floors.find((floor) => floor.id === document.locationId)?.tables[0]?.id, 'NEW-ROUND-TABLE');

    const firstUid = 'aa:bb:cc:dd:ee:01';
    const first = provisioning.request({ uid: firstUid, label: 'Approved stable node' }, 'test');
    assert.equal(first.status, 'pending');
    const beforeFirst = runtime.captureGeneration();
    await provisioning.approve(first.status === 'pending' ? first.request.id : '', 'operator');
    assert.notStrictEqual(runtime.captureGeneration(), beforeFirst);
    assert.equal(runtime.captureGeneration().reg.nodes.get(firstUid)?.floorId, null);
    assert.ok(runtime.captureGeneration().reg.floors.some((floor) => floor.id === document.locationId));

    const secondUid = 'aa:bb:cc:dd:ee:02';
    const second = provisioning.request({ uid: secondUid, label: 'Durability uncertain node' }, 'test');
    assert.equal(second.status, 'pending');
    failNextDirectorySync = true;
    const beforeUnconfirmed = runtime.captureGeneration();
    await provisioning.approve(second.status === 'pending' ? second.request.id : '', 'operator');
    assert.notStrictEqual(runtime.captureGeneration(), beforeUnconfirmed, 'a renamed, applied-but-unconfirmed candidate activates');
    assert.equal(runtime.captureGeneration().reg.nodes.get(secondUid)?.floorId, null);
    assert.ok(buildFileRegistry(site, JSON.parse(readFileSync(nodesPath, 'utf8'))).nodes.has(secondUid));

    const thirdUid = 'aa:bb:cc:dd:ee:03';
    const third = provisioning.request({ uid: thirdUid, label: 'After recovery node' }, 'test');
    assert.equal(third.status, 'pending');
    await provisioning.approve(third.status === 'pending' ? third.request.id : '', 'operator');
    assert.ok(runtime.captureGeneration().reg.nodes.has(thirdUid), 'the next mutation verifies and re-syncs the previous winner before proceeding');

    const failedUid = 'aa:bb:cc:dd:ee:04';
    const failed = provisioning.request({ uid: failedUid, label: 'Not committed node' }, 'test');
    assert.equal(failed.status, 'pending');
    failRename = true;
    const beforeFailure = runtime.captureGeneration();
    await assert.rejects(provisioning.approve(failed.status === 'pending' ? failed.request.id : '', 'operator'), /simulated pre-rename failure/);
    assert.strictEqual(runtime.captureGeneration(), beforeFailure, 'a pre-rename error leaves the prior runtime pointer active');
    assert.equal(runtime.reg.nodes.has(failedUid), false);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
