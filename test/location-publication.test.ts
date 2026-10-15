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
const furnitureId = '00000000-0000-4000-8000-000000000005';

function document(withModel = false, visibility: 'public' | 'console' = 'public', generatedRoom = false, withFurniture = false) {
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
    ...(generatedRoom ? { proceduralRoom: 'simple-rectangle-v1' } : {}),
    ...(withFurniture ? { furnitureDefaults: { table: { assetId: furnitureId, scale: 1, yawDeg: 0, elevationM: 0 } } } : {}),
  });
}

function harness(options: {
  withModel?: boolean;
  withFurniture?: boolean;
  furnitureUnavailable?: boolean;
  furnitureTypeMismatch?: boolean;
  generatedReplacement?: boolean;
  visibility?: 'public' | 'console';
  legacyStatic?: boolean;
  existingBase?: boolean;
  staleBase?: boolean;
  commitError?: Error;
  durability?: 'confirmed' | 'unconfirmed';
  modelAcknowledgement?: () => Promise<void>;
} = {}) {
  let locked = false;
  const events: string[] = [];
  const location = document(options.withModel, options.visibility, options.generatedReplacement, options.withFurniture);
  const baseDocument = options.legacyStatic ? document(true, options.visibility) : options.existingBase ? document(false, options.visibility) : null;
  const activeRevision = options.legacyStatic ? 0 : options.existingBase ? 1 : null;
  const baseProvenance = options.legacyStatic ? {
    modelAssetId: { kind: 'legacy-static' as const, basePublishedRevision: 0 as const, locationId: location.locationId, assetId: modelId },
  } : {};
  const base: PublishedLocationRevision | null = baseDocument && activeRevision !== null ? {
    locationId: location.locationId, revision: activeRevision, createdBy: 'seed', createdAt: 1,
    document: baseDocument, legacySpatial: null, assetProvenance: baseProvenance,
  } : null;
  const exposedBase = options.legacyStatic && base
    ? exposePublishedLocationCandidate({ revision: 0, document: base.document, legacySpatial: null }) : null;
  if (exposedBase && options.generatedReplacement) {
    delete exposedBase.modelAssetId;
    delete exposedBase.modelTransform;
    exposedBase.proceduralRoom = 'simple-rectangle-v1';
  }
  const draftCandidate = options.legacyStatic && base && exposedBase ? parseLocationCandidate(
    exposedBase, { revision: 0, document: base.document, legacySpatial: null }, 0,
  ) : { document: location, legacySpatial: null };
  const state: PublishedLocationState | null = base ? {
    locationId: location.locationId, activeRevision: activeRevision!, history: [base],
  } : null;
  const inheritedProvenance = options.legacyStatic && !options.generatedReplacement ? baseProvenance : {};
  const uploadedProvenance = options.withModel && !options.legacyStatic
    ? { modelAssetId: { kind: 'upload' as const, ownerId: 'operator-a' } }
    : inheritedProvenance;
  const draft: LocationDraft = {
    draftId, creatorId: 'operator-a', locationId: location.locationId, draftRevision: 2,
    basePublishedRevision: options.staleBase ? null : activeRevision, createdAt: 1, updatedAt: 2, document: draftCandidate.document,
    legacySpatial: draftCandidate.legacySpatial, assetProvenance: uploadedProvenance,
  };
  let runtimeCandidate: ReturnType<typeof document> | null = null;
  let committedRevision: PublishedLocationRevision | null = null;
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
    async getDraftForRead(owner, id) { return owner === draft.creatorId && id === draftId ? draft : null; },
    async deleteDraftWithinMutation() { throw new Error('unused'); },
    async getDraftForReadWithinMutation(owner, id) { assert.equal(locked, true); events.push('draft'); return owner === draft.creatorId && id === draftId ? draft : null; },
    async listDrafts() { return []; }, async saveDraft() { throw new Error('unused'); },
  };
  const snapshots: LocationRegistrySnapshotRepository = {
    async readSnapshot() { assert.equal(locked, true); events.push('read'); return snapshot; },
  };
  const published: PublishedLocationRepository = {
    async removeWithinMutation() { throw new Error('unused removal'); },
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
      committedRevision = structuredClone(input.revision);
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
    furnitureLibrary: {
      async getFurnitureMetadata(id) {
        events.push('furniture-meta');
        return options.withFurniture && !options.furnitureUnavailable && id === furnitureId ? {
          assetId: furnitureId, creatorId: 'different-uploader', purpose: 'furniture', furnitureType: options.furnitureTypeMismatch ? 'chair' : 'table',
          mediaType: 'model/gltf-binary', sha256: 'b'.repeat(64), byteLength: 20, createdAt: 1, displayName: 'Shared table.glb',
        } : null;
      },
    },
    ...(options.modelAcknowledgement ? { modelDistributor: { acknowledge: async () => { events.push('model-ack'); await options.modelAcknowledgement!(); } } } : {}),
    now: () => 100,
  });
  return { useCase, events, get committedRevision() { return committedRevision; }, get preparedDocument() { return runtimeCandidate; }, get publishedState() { return state; } };
}

test('an older draft publishes its own contents as the next observed revision', async () => {
  const h = harness({ existingBase: true, staleBase: true });
  const result = await h.useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 1 });
  assert.equal(result.publishedRevision, 2);
  assert.deepEqual((h.committedRevision as unknown as Record<string, unknown>).sourceDraft,
    { draftId, draftRevision: 2, basePublishedRevision: null });
  assert.equal(h.committedRevision?.document.name, 'New room');
});

test('an older draft still conflicts when the observed active revision changes', async () => {
  const h = harness({ existingBase: true, staleBase: true });
  await assert.rejects(h.useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 0 }), /published location changed/);
  assert.ok(!h.events.includes('commit'));
});

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

test('a furniture acknowledgement failure leaves an existing public winner and runtime active', async () => {
  const { useCase, events, publishedState } = harness({
    withFurniture: true,
    existingBase: true,
    modelAcknowledgement: async () => { throw new Error('target did not confirm furniture'); },
  });
  assert.equal(publishedState?.activeRevision, 1);
  assert.equal(publishedState?.history.at(-1)?.document.furnitureDefaults, undefined);
  await assert.rejects(
    useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 1 }),
    PublishedModelDistributionFailedError,
  );
  assert.equal(publishedState?.activeRevision, 1, 'the old composite location winner remains current');
  assert.equal(publishedState?.history.at(-1)?.revision, 1);
  assert.equal(publishedState?.history.at(-1)?.document.furnitureDefaults, undefined,
    'the failed candidate never replaces the old winner document');
  assert.ok(!events.includes('commit'));
  assert.ok(!events.includes('activate'), 'the prior runtime generation remains active');
});

test('a public shared-furniture reference is revalidated then acknowledged before commit', async () => {
  const { useCase, events } = harness({ withFurniture: true, modelAcknowledgement: async () => undefined });
  const result = await useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null });
  assert.equal(result.publishedRevision, 1);
  assert.deepEqual(events, ['lock', 'read', 'draft', 'furniture-meta', 'available', 'prepare', 'model-ack', 'refresh', 'commit', 'activate', 'unlock']);
});

test('public furniture publication fails before prepare when the shared metadata is unavailable or type-incompatible', async () => {
  for (const options of [{ withFurniture: true, furnitureUnavailable: true }, { withFurniture: true, furnitureTypeMismatch: true }]) {
    const { useCase, events } = harness(options);
    await assert.rejects(useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null }));
    assert.ok(events.includes('furniture-meta'));
    assert.ok(!events.includes('prepare'));
    assert.ok(!events.includes('commit'));
  }
});

test('console-only furniture is metadata-validated but never distributed to student web targets', async () => {
  const { useCase, events } = harness({ withFurniture: true, visibility: 'console', modelAcknowledgement: async () => undefined });
  const result = await useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: null });
  assert.equal(result.publishedRevision, 1);
  assert.ok(events.includes('furniture-meta'));
  assert.ok(!events.includes('model-ack'));
  assert.ok(events.includes('activate'));
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

test('an explicit generated room replaces revision-zero static source without transferring or retaining the model', async () => {
  const source = harness({ legacyStatic: true, generatedReplacement: true });
  const result = await source.useCase.execute({ creatorId: 'operator-a', draftId, expectedDraftRevision: 2, expectedPublishedRevision: 0 });
  assert.equal(result.publishedRevision, 1);
  assert.ok(!source.events.includes('model-ack'));
  assert.equal(source.preparedDocument?.proceduralRoom, 'simple-rectangle-v1');
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
