import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { exposePublishedLocationCandidate, parseLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import { UnknownRegistryCommitOutcomeError, type LocationDraft, type PublishedLocationRevision, type PublishedLocationState } from '../src/modules/location-config/domain/location-records.js';
import { PublishLocationUseCase, PublishedModelDistributionFailedError, PublishedModelDistributionUnavailableError } from '../src/modules/location-config/use-cases/publish-location.js';
import type {
  LocationDraftRepository, LocationRegistrySnapshot, LocationRegistrySnapshotRepository,
  PreparedLocationRuntime, PublishedLocationRepository, RegistryMutationCoordinator,
} from '../src/modules/location-config/repositories/location-storage.js';

const draftId = '00000000-0000-4000-8000-000000000001';
const modelId = '00000000-0000-4000-8000-000000000002';

function document(withModel = false, visibility: 'public' | 'console' = 'public') {
  return parseLocationDocument({
    schemaVersion: 1,
    locationId: 'location_edge-test_00000000-0000-4000-8000-000000000003',
    name: 'New room', building: 'North', visibility, widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'room-zone', name: 'Room', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{
      id: 'NEW-TABLE', name: 'Table', zoneId: 'room-zone', capacity: 1,
      shape: { type: 'circle', cx: 200, cy: 150, radius: 35 },
      seats: [{ id: 'NEW-SEAT', x: 200, y: 210, neighbors: [] }],
    }],
    sensorAssignments: [],
    ...(withModel ? {
      modelAssetId: modelId,
      modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
    } : {}),
  });
}

function harness(options: {
  withModel?: boolean;
  visibility?: 'public' | 'console';
  legacyStatic?: boolean;
  existingBase?: boolean;
  commitError?: Error;
  durability?: 'confirmed' | 'unconfirmed';
  modelAcknowledgement?: () => Promise<void>;
} = {}) {
  let locked = false;
  const events: string[] = [];
  const location = document(options.withModel, options.visibility);
  const baseDocument = options.legacyStatic ? location : options.existingBase ? document(false, options.visibility) : null;
  const activeRevision = options.legacyStatic ? 0 : options.existingBase ? 1 : null;
  const baseProvenance = options.legacyStatic ? {
    modelAssetId: { kind: 'legacy-static' as const, basePublishedRevision: 0 as const, locationId: location.locationId, assetId: modelId },
  } : {};
  const base: PublishedLocationRevision | null = baseDocument && activeRevision !== null ? {
    locationId: location.locationId, revision: activeRevision, createdBy: 'seed', createdAt: 1,
    document: baseDocument, legacySpatial: null, assetProvenance: baseProvenance,
  } : null;
  const draftCandidate = options.legacyStatic && base ? parseLocationCandidate(
    exposePublishedLocationCandidate({ revision: 0, document: base.document, legacySpatial: null }),
    { revision: 0, document: base.document, legacySpatial: null }, 0,
  ) : { document: location, legacySpatial: null };
  const state: PublishedLocationState | null = base ? {
    locationId: location.locationId, activeRevision: activeRevision!, history: [base],
  } : null;
  const inheritedProvenance = options.legacyStatic ? baseProvenance : {};
  const uploadedProvenance = options.withModel && !options.legacyStatic
    ? { modelAssetId: { kind: 'upload' as const, ownerId: 'operator-a' } }
    : inheritedProvenance;
  const draft: LocationDraft = {
    draftId, creatorId: 'operator-a', locationId: location.locationId, draftRevision: 2,
    basePublishedRevision: activeRevision, createdAt: 1, updatedAt: 2, document: draftCandidate.document,
    legacySpatial: draftCandidate.legacySpatial, assetProvenance: uploadedProvenance,
  };
  let runtimeCandidate: ReturnType<typeof document> | null = null;
  const snapshot: LocationRegistrySnapshot = { registryRevision: 0, nodes: [], locations: state ? [state] : [] };
  const coordinator: RegistryMutationCoordinator = {
    withMutationLock: async (work) => {
      assert.equal(locked, false);
      locked = true;
      events.push('lock');
      try { return await work(); } finally { events.push('unlock'); locked = false; }
    },
    assertHealthy() { assert.equal(locked, true); },
    quarantine() { events.push('coordinator-quarantine'); },
  };
  const drafts: LocationDraftRepository = {
    async createDraft() { throw new Error('unused'); },
    async getDraft(owner, id) { assert.equal(locked, true); events.push('draft'); return owner === draft.creatorId && id === draftId ? draft : null; },
    async listDrafts() { return []; }, async saveDraft() { throw new Error('unused'); },
  };
  const snapshots: LocationRegistrySnapshotRepository = {
    async readSnapshot() { assert.equal(locked, true); events.push('read'); return snapshot; },
  };
  const published: PublishedLocationRepository = {
    async assertLocationIdAvailable() { assert.equal(locked, true); events.push('available'); },
    async getActive() { return state; }, async listActive() { return state ? [state] : []; }, async listHistory() { return state?.history ?? []; }, async registryRevision() { return 0; },
    async commitWithinMutation(input) {
      assert.equal(locked, true);
      events.push('commit');
      assert.equal(input.expectedRegistryRevision, 0);
      assert.equal(input.expectedPublishedRevision, activeRevision);
      assert.equal(input.revision.revision, (activeRevision ?? 0) + 1);
      if (options.commitError) {
        if (options.commitError instanceof UnknownRegistryCommitOutcomeError) coordinator.quarantine(options.commitError);
        throw options.commitError;
      }
      return { kind: 'committed', durability: options.durability ?? 'confirmed', acknowledgement: 'received', registryRevision: 1, activeRevision: (activeRevision ?? 0) + 1 };
    },
  };
  const runtime: PreparedLocationRuntime<string> = {
    prepare(_latest, candidate) { assert.equal(locked, true); assert.equal(candidate.locationId, draft.locationId); runtimeCandidate = structuredClone(candidate); events.push('prepare'); return 'prepared'; },
    refresh(prepared) { assert.equal(locked, true); events.push('refresh'); return prepared; },
    activate(prepared) { assert.equal(locked, true); assert.equal(prepared, 'prepared'); events.push('activate'); },
    quarantine() { events.push('runtime-quarantine'); },
  };
  const useCase = new PublishLocationUseCase({
    drafts, published, snapshots, mutationCoordinator: coordinator, runtime,
    assetMetadata: {
      async saveAssetMetadata() { throw new Error('unused'); },
      async getAssetMetadata(owner, id) {
        return owner === 'operator-a' && id === modelId ? {
          assetId: modelId, creatorId: owner, purpose: 'model', mediaType: 'model/gltf-binary', sha256: 'a'.repeat(64), byteLength: 20, createdAt: 1,
        } : null;
      },
    },
    ...(options.modelAcknowledgement ? { modelDistributor: { acknowledge: async () => { events.push('model-ack'); await options.modelAcknowledgement!(); } } } : {}),
    now: () => 100,
  });
  return { useCase, events, get preparedDocument() { return runtimeCandidate; } };
}

test('publication prepares and acknowledges before commit, then activates before unlocking', async () => {
  const { useCase, events } = harness({ withModel: true, modelAcknowledgement: async () => undefined });
  const result = await useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null });
  assert.deepEqual(events, ['lock', 'read', 'draft', 'available', 'prepare', 'model-ack', 'refresh', 'commit', 'activate', 'unlock']);
  assert.deepEqual(result, {
    kind: 'committed', locationId: 'location_edge-test_00000000-0000-4000-8000-000000000003',
    publishedRevision: 1, registryRevision: 1, durability: 'confirmed', acknowledgement: 'received',
  });
});

test('a GLB candidate fails closed before commit if distribution is unavailable', async () => {
  const { useCase, events } = harness({ withModel: true });
  await assert.rejects(
    useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null }),
    PublishedModelDistributionUnavailableError,
  );
  assert.deepEqual(events, ['lock', 'read', 'draft', 'available', 'prepare', 'unlock']);
});

test('a failed public GLB acknowledgement is a pre-commit distribution failure', async () => {
  const { useCase, events } = harness({ withModel: true, modelAcknowledgement: async () => { throw new Error('target rejected'); } });
  await assert.rejects(
    useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null }),
    PublishedModelDistributionFailedError,
  );
  assert.ok(events.includes('model-ack'));
  assert.ok(!events.includes('commit'));
  assert.ok(!events.includes('activate'));
});

test('console-only uploaded models stay edge-local and do not wait for student web distribution', async () => {
  const { useCase, events } = harness({ withModel: true, visibility: 'console', existingBase: true });
  const result = await useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 1 });
  assert.equal(result.publishedRevision, 2);
  assert.ok(!events.includes('model-ack'));
  assert.ok(events.includes('activate'));
});

test('revision-zero static models remain on the legacy fallback without a transfer', async () => {
  const source = harness({ withModel: true, legacyStatic: true });
  const result = await source.useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 0 });
  assert.equal(result.publishedRevision, 1);
  assert.ok(!source.events.includes('model-ack'));
  assert.ok(source.events.includes('activate'));
  assert.equal(source.preparedDocument?.modelAssetId, undefined);
  assert.equal(source.preparedDocument?.modelTransform, undefined);
});

test('committed-unconfirmed storage results still activate the applied generation', async () => {
  const { useCase, events } = harness({ durability: 'unconfirmed' });
  const result = await useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null });
  assert.equal(result.durability, 'unconfirmed');
  assert.ok(events.indexOf('activate') > events.indexOf('commit'));
});

test('unknown durable outcomes quarantine and never activate a candidate', async () => {
  const unknown = new UnknownRegistryCommitOutcomeError(0, 1, document().locationId);
  const { useCase, events } = harness({ commitError: unknown });
  await assert.rejects(useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null }), unknown);
  assert.ok(events.includes('runtime-quarantine'));
  assert.ok(events.includes('coordinator-quarantine'));
  assert.ok(!events.includes('activate'));
  assert.equal(events.at(-1), 'unlock');
});
