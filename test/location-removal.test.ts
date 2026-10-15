import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { syncDirectory } from '../src/shared/directory-sync.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeFileLocationPersistence, loadFileRegistry } from '../src/infrastructure/location-config/file-location-storage.js';
import { CreateLocationDraftUseCase } from '../src/modules/location-config/use-cases/create-location-draft.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';
import { PublishLocationUseCase } from '../src/modules/location-config/use-cases/publish-location.js';
import { RemoveLocationUseCase } from '../src/modules/location-config/use-cases/remove-location.js';
import { StartLocationEditDraftUseCase } from '../src/modules/location-config/use-cases/start-location-edit-draft.js';
import { exposeAuthoredLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import { siteJson } from './fixtures.js';

test('file removal releases sensors, retains history/drafts and survives restart without seed resurrection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'location-removal-'));
  const sitePath = join(directory, 'site.json'), nodesPath = join(directory, 'nodes.json');
  const seed = siteJson() as { floors: Array<{ id: string }> };
  const locationId = seed.floors[0]!.id;
  writeFileSync(sitePath, JSON.stringify(seed));
  writeFileSync(nodesPath, JSON.stringify({ nodes: [{ uid: 'aa:bb:cc:dd:ee:01', label: 'Test sensor', floor: locationId,
    pose: { x: 100, y: 100, heightCm: 300, yawDeg: 0, mirror: false }, owns: [] }] }));
  let failRename = false, failDirectorySync = false;
  const operations = { rename: (...paths: Parameters<typeof renameSync>) => { if (failRename) throw new Error('injected failure'); renameSync(...paths); }, syncDirectory: (path: string) => { if (failDirectorySync) throw new Error('injected directory sync failure'); syncDirectory(path); } };
  let store = initializeFileLocationPersistence(sitePath, nodesPath, directory, operations);
  let activations = 0;
  const runtime = { prepare: () => 'published', prepareRemoval: () => 'removed', refresh: (value: string) => value,
    activate: () => { activations++; }, quarantine: () => undefined };
  try {
    const start = new StartLocationEditDraftUseCase({ drafts: store.drafts, snapshots: store.snapshots, mutationCoordinator: store.coordinator });
    const retained = await start.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 0 });
    const remove = new RemoveLocationUseCase({ published: store.published, snapshots: store.snapshots, coordinator: store.coordinator, runtime, now: () => 123 });
    await assert.rejects(remove.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 1 }), /changed/i);
    failRename = true;
    await assert.rejects(remove.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 0 }), /injected failure/);
    assert.equal(activations, 0);
    assert.equal((await store.published.getActive(locationId))?.removal, undefined);
    failRename = false; failDirectorySync = true;
    const result = await remove.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 0 });
    assert.equal(result.kind, 'removed');
    assert.equal(result.durability, 'unconfirmed');
    await assert.rejects(store.coordinator.withMutationLock(() => undefined), /unavailable/i);
    failDirectorySync = false;
    assert.equal(activations, 1);
    assert.equal((await store.published.listHistory(locationId)).length, 1);
    assert.equal((await store.drafts.getDraft('manager', retained.draft.draftId))?.draftRevision, 1);
    const node = (await store.snapshots.readSnapshot()).nodes[0]!;
    assert.equal(node.floorId, null); assert.equal(node.pose, null); assert.deepEqual(node.owns, []);
    await assert.rejects(remove.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 0 }), /removed/i);
    await assert.rejects(start.execute({ creatorId: 'manager', locationId, expectedPublishedRevision: 0 }), /removed/i);
    const publisher = new PublishLocationUseCase({ drafts: store.drafts, published: store.published, snapshots: store.snapshots, mutationCoordinator: store.coordinator, runtime });
    await assert.rejects(publisher.execute({ creatorId: 'manager', draftId: retained.draft.draftId, expectedDraftRevision: 1, expectedPublishedRevision: 0 }), /removed/i);
    const created = await new CreateLocationDraftUseCase({ edgeId: 'removal', drafts: store.drafts, published: store.published, snapshots: store.snapshots, coordinator: store.coordinator })
      .execute({ creatorId: 'manager', name: 'Authored room', building: 'Test', widthCm: 400, heightCm: 300 });
    await new SaveLocationDraftUseCase({ drafts: store.drafts, published: store.published }).execute({ creatorId: 'manager', draftId: created.draft.draftId, expectedDraftRevision: 1,
      document: { ...exposeAuthoredLocationCandidate(created.draft.document, created.draft.legacySpatial), zones: [{ id: 'room-zone', name: 'Room', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }] } });
    await publisher.execute({ creatorId: 'manager', draftId: created.draft.draftId, expectedDraftRevision: 2, expectedPublishedRevision: null });
    await remove.execute({ creatorId: 'manager', locationId: created.draft.locationId, expectedPublishedRevision: 1 });
    await assert.rejects(publisher.execute({ creatorId: 'manager', draftId: created.draft.draftId, expectedDraftRevision: 2, expectedPublishedRevision: null }), /removed/i);
    assert.equal((await store.published.listHistory(created.draft.locationId)).length, 1);
    for (const floor of seed.floors.slice(1)) await remove.execute({ creatorId: 'manager', locationId: floor.id, expectedPublishedRevision: 0 });
    assert.equal(loadFileRegistry(sitePath, nodesPath).floors.length, 0, 'the last location can be removed');
    store.close();
    store = initializeFileLocationPersistence(sitePath, nodesPath, directory);
    assert.ok(!store.registry.floors.some(floor => floor.id === locationId || floor.id === created.draft.locationId));
    assert.ok(!loadFileRegistry(sitePath, nodesPath).floors.some(floor => floor.id === locationId || floor.id === created.draft.locationId));
    assert.deepEqual((await store.published.getActive(locationId))?.removal, { removedAt: 123, removedBy: 'manager' });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
