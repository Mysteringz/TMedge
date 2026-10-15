import { RemoveLocationUseCase } from '../src/modules/location-config/use-cases/remove-location.js';
import { TrackLocationRemoval1792195200000 } from '../src/infrastructure/postgres/migrations/1792195200000-TrackLocationRemoval.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPostgresDataSource } from '../src/infrastructure/postgres/data-source.js';
import { PostgresLocationDraftRepository, PostgresPublishedLocationRepository, PostgresLocationAssetMetadataRepository, PostgresLocationAssetStore } from '../src/infrastructure/postgres/location-configuration-repositories.js';
import { PostgresRegistryMutationCoordinator } from '../src/infrastructure/location-config/postgres-registry-mutation-coordinator.js';
import { CreateLocationDraftUseCase } from '../src/modules/location-config/use-cases/create-location-draft.js';
import { StartLocationEditDraftUseCase } from '../src/modules/location-config/use-cases/start-location-edit-draft.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';
import { UploadLocationAssetUseCase } from '../src/modules/location-config/use-cases/upload-location-asset.js';
import { PublishLocationUseCase } from '../src/modules/location-config/use-cases/publish-location.js';
import { DeleteLocationDraftUseCase } from '../src/modules/location-config/use-cases/delete-location-draft.js';
import { exposeAuthoredLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import { isPublishedDraft } from '../src/modules/location-config/domain/publication-source.js';
import { TrackLocationPublicationSource1792108800000 } from '../src/infrastructure/postgres/migrations/1792108800000-TrackLocationPublicationSource.js';

test('PostgreSQL commits exact draft receipts and restores historical inherited assets across reconnect', {
  skip: process.env.PG_DRAFT_TEST !== '1', timeout: 60_000,
}, async () => {
  const config = { host: '127.0.0.1', port: Number(process.env.PG_DRAFT_TEST_PORT ?? 53987), database: 'postgres',
    username: process.env.PG_DRAFT_TEST_USER ?? 'draft_test', password: 'local-test-only', role: 'migrator' as const, synchronize: false as const, migrationsRun: false as const };
  const admin = createPostgresDataSource(config);
  const database = `draft_publication_${randomUUID().replaceAll('-', '')}`;
  // Publication holds an advisory-lock connection while its transaction uses another connection.
  const source = createPostgresDataSource({ ...config, database, role: 'runtime' });
  const directory = mkdtempSync(join(tmpdir(), 'draft-postgres-assets-'));
  let created = false;
  try {
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
    const coordinator = new PostgresRegistryMutationCoordinator(source);
    const published = new PostgresPublishedLocationRepository(source, new Set(), coordinator);
    const drafts = new PostgresLocationDraftRepository(source);
    const assets = new PostgresLocationAssetStore(source, directory);
    const assetMetadata = new PostgresLocationAssetMetadataRepository(source);
    const snapshots = { async readSnapshot() { return { registryRevision: await published.registryRevision(), nodes: [], locations: await published.listActive() }; } };
    const save = new SaveLocationDraftUseCase({ drafts, published, assetMetadata });
    const first = await new CreateLocationDraftUseCase({ edgeId: 'draft-pg', drafts, published, snapshots, coordinator }).execute({ creatorId: 'uploader', name: 'Original layout', building: 'Test', widthCm: 400, heightCm: 300 });
    const uploaded = await new UploadLocationAssetUseCase({ drafts, assets, saveDraft: save }).execute({ creatorId: 'uploader', draftId: first.draft.draftId, expectedDraftRevision: 1,
      purpose: 'floor-plan', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const runtime = { prepareRemoval: () => 'removed', prepare: () => 'ready', refresh: (value: string) => value, activate: () => undefined, quarantine: () => undefined };
    const publisher = new PublishLocationUseCase({ drafts, published, snapshots, mutationCoordinator: coordinator, runtime, assetMetadata });
    await publisher.execute({ creatorId: 'uploader', draftId: first.draft.draftId, expectedDraftRevision: uploaded.outcome.draft.draftRevision, expectedPublishedRevision: null });
    const start = new StartLocationEditDraftUseCase({ drafts, snapshots, mutationCoordinator: coordinator });
    const older = await start.execute({ creatorId: 'manager-b', locationId: first.draft.locationId, expectedPublishedRevision: 1 });
    const newer = await start.execute({ creatorId: 'manager-c', locationId: first.draft.locationId, expectedPublishedRevision: 1 });
    const changedDocument = exposeAuthoredLocationCandidate(newer.draft.document, newer.draft.legacySpatial);
    changedDocument.name = 'Newer layout';
    delete changedDocument.planAssetId;
    const changed = await save.execute({ creatorId: 'manager-c', draftId: newer.draft.draftId, expectedDraftRevision: 1, document: changedDocument });
    await publisher.execute({ creatorId: 'manager-c', draftId: newer.draft.draftId, expectedDraftRevision: changed.draft.draftRevision, expectedPublishedRevision: 1 });
    await assert.rejects(publisher.execute({ creatorId: 'manager-b', draftId: older.draft.draftId, expectedDraftRevision: 1, expectedPublishedRevision: 1 }), /published location changed/);
    const restored = await publisher.execute({ creatorId: 'manager-b', draftId: older.draft.draftId, expectedDraftRevision: 1, expectedPublishedRevision: 2 });
    assert.equal(restored.publishedRevision, 3);
    await source.destroy();
    await source.initialize();
    const reopened = new PostgresPublishedLocationRepository(source, new Set(), new PostgresRegistryMutationCoordinator(source));
    const state = (await reopened.getActive(first.draft.locationId))!;
    const winner = state.history.at(-1)!;
    assert.equal(winner.document.name, 'Original layout');
    assert.equal(winner.document.planAssetId, uploaded.metadata.assetId);
    assert.equal(winner.assetProvenance?.planAssetId?.kind === 'upload' ? winner.assetProvenance.planAssetId.ownerId : null, 'uploader');
    assert.deepEqual(winner.sourceDraft, { draftId: older.draft.draftId, draftRevision: 1, basePublishedRevision: 1 });
    assert.equal(isPublishedDraft(older.draft, state.history), true);
    assert.deepEqual(state.history.map(row => row.revision), [1, 2, 3]);
    const remover = new DeleteLocationDraftUseCase({ drafts, coordinator });
    await assert.rejects(remover.execute({ creatorId: 'other-manager', draftId: first.draft.draftId, expectedDraftRevision: uploaded.outcome.draft.draftRevision }), /not found/i);
    await assert.rejects(remover.execute({ creatorId: 'uploader', draftId: first.draft.draftId, expectedDraftRevision: 1 }), /draft changed/i);
    const removal = await remover.execute({ creatorId: 'uploader', draftId: first.draft.draftId, expectedDraftRevision: uploaded.outcome.draft.draftRevision });
    assert.equal(removal.kind, 'deleted');
    assert.equal(await drafts.getDraft('uploader', first.draft.draftId), null);
    assert.equal((await reopened.getActive(first.draft.locationId))?.activeRevision, 3);
    assert.equal((await reopened.getActive(first.draft.locationId))?.history.at(-1)?.document.planAssetId, uploaded.metadata.assetId);
    assert.ok(await assets.read('uploader', uploaded.metadata.assetId), 'removing the source draft preserves referenced asset bytes');
    // A committed removal with a lost acknowledgement is reconciled from exact
    // registry revision + marker + released placements; immutable data survives.
    await source.query("INSERT INTO public.registered_nodes (uid, label, simulated, rgb, detector) VALUES ('aa:bb:cc:dd:ee:01', 'Reusable', false, false, 'node')");
    await source.query("INSERT INTO public.node_placements (uid, floor_id, x, y, height_cm, yaw_deg, mirror) VALUES ('aa:bb:cc:dd:ee:01', $1, 100, 100, 350, 0, false)", [first.draft.locationId]);
    await source.query("INSERT INTO public.node_table_owners (table_id, uid) VALUES ('old-table', 'aa:bb:cc:dd:ee:01')");
    const lostAck = new PostgresPublishedLocationRepository(source, new Set(), coordinator, async work => {
      await source.transaction(work);
      throw new Error('lost COMMIT acknowledgement');
    });
    const removeLocation = new RemoveLocationUseCase({ published: lostAck, snapshots, coordinator, runtime, now: () => 999 });
    await assert.rejects(removeLocation.execute({ creatorId: 'manager', locationId: first.draft.locationId, expectedPublishedRevision: 2 }), /changed/i);
    assert.equal((await removeLocation.execute({ creatorId: 'manager', locationId: first.draft.locationId, expectedPublishedRevision: 3 })).acknowledgement, 'reconciled');
    assert.deepEqual((await reopened.getActive(first.draft.locationId))?.removal, { removedAt: 999, removedBy: 'manager' });
    assert.equal((await reopened.listHistory(first.draft.locationId)).length, 3);
    assert.equal((await source.query('SELECT * FROM public.node_placements')).length, 0);
    assert.equal((await source.query('SELECT * FROM public.node_table_owners')).length, 0);
    assert.equal((await source.query('SELECT * FROM public.registered_nodes')).length, 1);
    assert.ok(await drafts.getDraft('manager-c', newer.draft.draftId));
    assert.ok(await assets.read('uploader', uploaded.metadata.assetId));
    await assert.rejects(publisher.execute({ creatorId: 'manager-c', draftId: newer.draft.draftId, expectedDraftRevision: changed.draft.draftRevision, expectedPublishedRevision: 3 }), /removed/i);
    await assert.rejects(start.execute({ creatorId: 'manager-c', locationId: first.draft.locationId, expectedPublishedRevision: 3 }), /removed/i);
    await source.destroy(); await source.initialize();
    assert.equal((await published.getActive(first.draft.locationId))?.removal?.removedAt, 999);
    const runner = source.createQueryRunner();
    try { await runner.connect(); await assert.rejects(new TrackLocationRemoval1792195200000().down(runner), /removal markers/); await assert.rejects(new TrackLocationPublicationSource1792108800000().down(runner), /older draft bases/); }
    finally { await runner.release(); }
  } finally {
    if (source.isInitialized) await source.destroy();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    if (admin.isInitialized) await admin.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
