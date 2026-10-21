import { TrackLocationRemoval1792195200000 } from '../src/infrastructure/postgres/migrations/1792195200000-TrackLocationRemoval.js';
import { TrackLocationPublicationSource1792108800000 } from '../src/infrastructure/postgres/migrations/1792108800000-TrackLocationPublicationSource.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { CreateRegistrationProvisioningAuditSchema1790812800000 } from '../src/infrastructure/postgres/migrations/1790812800000-CreateRegistrationProvisioningAuditSchema.js';
import { closePostgres, createPostgresDataSource } from '../src/infrastructure/postgres/data-source.js';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { CreateLocationConfigurationStorage1791676800000 } from '../src/infrastructure/postgres/migrations/1791676800000-CreateLocationConfigurationStorage.js';
import { PersistLocationSpatialProvenance1791763200000 } from '../src/infrastructure/postgres/migrations/1791763200000-PersistLocationSpatialProvenance.js';
import { PersistLocationAssetProvenance1791849600000 } from '../src/infrastructure/postgres/migrations/1791849600000-PersistLocationAssetProvenance.js';
import { AddLocationAssetDisplayName1791936000000 } from '../src/infrastructure/postgres/migrations/1791936000000-AddLocationAssetDisplayName.js';
import { AddFurnitureLocationAssets1792022400000 } from '../src/infrastructure/postgres/migrations/1792022400000-AddFurnitureLocationAssets.js';
import {
  PostgresLocationAssetMetadataRepository, PostgresLocationAssetStore, PostgresLocationDraftRepository,
  PostgresPublishedLocationRepository,
} from '../src/infrastructure/postgres/location-configuration-repositories.js';
import { PostgresRegistryMutationCoordinator } from '../src/infrastructure/location-config/postgres-registry-mutation-coordinator.js';
import { createLocationId, parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { InvalidLocationDocumentError } from '../src/modules/location-config/domain/location-document.js';
import { LocationDraft } from '../src/modules/location-config/domain/location-records.js';
import type { LocationRegistrySnapshotRepository, PreparedLocationRuntime, PublishedLocationRepository } from '../src/modules/location-config/repositories/location-storage.js';
import { HttpPublishedModelDistributor } from '../src/infrastructure/location-config/http-published-model-distributor.js';
import { createWebApp } from '../src/web/main.js';
import { PublishLocationUseCase, PublishedModelDistributionFailedError } from '../src/modules/location-config/use-cases/publish-location.js';
import { StartLocationEditDraftUseCase } from '../src/modules/location-config/use-cases/start-location-edit-draft.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';

const TRANSFER_TOKEN = 'postgres-furniture-transfer-token-012345';

const furnitureMigrations = [
  CreateRegistrationProvisioningAuditSchema1790812800000,
  CreateLocationConfigurationStorage1791676800000,
  PersistLocationSpatialProvenance1791763200000,
  PersistLocationAssetProvenance1791849600000,
  AddLocationAssetDisplayName1791936000000,
  AddFurnitureLocationAssets1792022400000,
  TrackLocationPublicationSource1792108800000,
  TrackLocationRemoval1792195200000,
];

test('PostgreSQL furniture metadata is shared, authored assignments persist, and rollback fails safely', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
  timeout: 60_000,
}, async (context) => {
  const config = loadPostgresConfig();
  const migrator = createPostgresDataSource(config.migrator, furnitureMigrations);
  let application: ReturnType<typeof createPostgresDataSource> | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'tmedge-furniture-postgres-'));
  const createdAssetIds: string[] = [];
  const draftIds: string[] = [];
  let migrationsApplied = 0;
  let locationIdForCleanup: string | undefined;
  let goodTarget: Awaited<ReturnType<typeof startWebTarget>> | undefined;
  let badTarget: Awaited<ReturnType<typeof startWebTarget>> | undefined;

  try {
    await migrator.initialize();
    assert.equal((await migrator.query("SELECT to_regclass('public.registered_nodes') AS table_name"))[0].table_name, null,
      'the disposable fixture starts without registration or application tables');
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets') AS table_name"))[0].table_name, null,
      'the disposable fixture starts without application tables');
    assert.equal((await migrator.query('SELECT COUNT(*)::int AS count FROM public.migrations'))[0].count, 0,
      'the disposable fixture migration ledger is empty');
    migrationsApplied = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(migrationsApplied, furnitureMigrations.length);
    context.diagnostic('Disposable migrations applied; opening the runtime-role data source for application operations.');
    application = createPostgresDataSource(config.runtime, furnitureMigrations);
    assert.ok(Number((application.options.extra as { max?: unknown } | undefined)?.max) >= 2,
      'the application pool must allow the advisory-lock connection and publication transaction concurrently');
    await application.initialize();

    const store = new PostgresLocationAssetStore(application, dataDir);
    const table = await store.createFurnitureItem({
      creatorId: 'furniture-uploader', furnitureType: 'table', displayName: 'Oak table.glb', bytes: postgresTestGlb(), createdAt: 20,
    });
    createdAssetIds.push(table.assetId);
    const chair = await store.createFurnitureItem({
      creatorId: 'furniture-uploader', furnitureType: 'chair', displayName: 'Oak chair.glb', bytes: postgresTestGlb(), createdAt: 10,
    });
    createdAssetIds.push(chair.assetId);

    assert.equal((await store.getFurnitureMetadata(table.assetId))?.creatorId, 'furniture-uploader');
    assert.deepEqual((await store.listFurnitureMetadata({ furnitureType: 'table', query: 'OAK' })).map(({ assetId }) => assetId), [table.assetId]);
    assert.deepEqual(await store.listFurnitureMetadata({ query: '%' }), [], 'search wildcard characters are treated literally');
    assert.equal((await store.readFurnitureItem(table.assetId))?.metadata.assetId, table.assetId,
      'the same shared asset can be resolved without a requesting creator or location binding');
    assert.equal((await migrator.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'location_assets' AND column_name = 'location_id'")).length, 0,
      'shared metadata is not bound to its first location');

    const locationId = createLocationId('pg-furniture-test', randomUUID());
    locationIdForCleanup = locationId;
    const document = parseLocationDocument({
      schemaVersion: 1, locationId, name: 'PostgreSQL furniture draft', building: 'Test building', visibility: 'public',
      widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [], tables: [], sensorAssignments: [],
    });
    const draft: LocationDraft = {
      draftId: randomUUID(), creatorId: 'different-manager', locationId, draftRevision: 1,
      basePublishedRevision: null, createdAt: 100, updatedAt: 100, document, legacySpatial: null, assetProvenance: {},
    };
    draftIds.push(draft.draftId);
    const drafts = new PostgresLocationDraftRepository(application);
    await drafts.createDraft(draft);
    const useCase = new SaveLocationDraftUseCase({
      drafts,
      published: { getActive: async () => null } as unknown as PublishedLocationRepository,
      furnitureLibrary: store,
      assetMetadata: new PostgresLocationAssetMetadataRepository(application),
      now: () => 101,
    });
    const authoredAssignment = { table: { assetId: table.assetId, scale: 1.25, yawDeg: 30, elevationM: 0.1 } };
    const authored = {
      name: document.name, building: document.building, widthCm: document.widthCm, heightCm: document.heightCm,
      outline: document.outline, zones: document.zones, tables: document.tables, sensorAssignments: document.sensorAssignments,
      furnitureDefaults: authoredAssignment,
    };
    await useCase.execute({ creatorId: 'different-manager', draftId: draft.draftId, expectedDraftRevision: 1, document: authored });
    const saved = await drafts.getDraft('different-manager', draft.draftId);
    assert.deepEqual(saved?.document.furnitureDefaults, authored.furnitureDefaults,
      'schema-v1 furniture transforms survive the existing PostgreSQL JSON draft path');
    await assert.rejects(useCase.execute({
      creatorId: 'different-manager', draftId: draft.draftId, expectedDraftRevision: 2,
      document: { ...authored, furnitureDefaults: { table: { assetId: chair.assetId, scale: 1, yawDeg: 0, elevationM: 0 } } },
    }), InvalidLocationDocumentError, 'a chair item cannot be assigned to the table slot');
    context.diagnostic('Shared furniture metadata and authored assignment persistence passed.');

    const queryRunner = migrator.createQueryRunner();
    await queryRunner.connect();
    try {
      await assert.rejects(new AddFurnitureLocationAssets1792022400000().down(queryRunner), /Cannot revert furniture metadata/);
    } finally { await queryRunner.release(); }
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets_furniture_library_idx') AS index_name"))[0].index_name,
      'location_assets_furniture_library_idx', 'failed rollback leaves the library index intact');
    assert.equal((await migrator.query("SELECT COUNT(*)::int AS count FROM public.location_assets WHERE purpose = 'furniture'"))[0].count, 2,
      'failed rollback leaves immutable furniture metadata intact');

    const coordinator = new PostgresRegistryMutationCoordinator(application);
    const published = new PostgresPublishedLocationRepository(application, new Set(), coordinator);
    const snapshots: LocationRegistrySnapshotRepository = {
      async readSnapshot() {
        return { registryRevision: await published.registryRevision(), nodes: [], locations: await published.listActive() };
      },
    };
    let activationCount = 0;
    const runtime: PreparedLocationRuntime<unknown> = {
      prepare(_snapshot, candidate) { return candidate; },
      refresh(prepared) { return prepared; },
      activate() { activationCount++; },
      quarantine() {},
    };
    goodTarget = await startWebTarget(join(dataDir, 'web-good'), TRANSFER_TOKEN);
    badTarget = await startWebTarget(join(dataDir, 'web-bad'), 'different-postgres-target-token-98765');
    const publisher = (targetUrl: string) => new PublishLocationUseCase({
      drafts, published, snapshots, mutationCoordinator: coordinator, runtime,
      furnitureLibrary: store,
      modelDistributor: new HttpPublishedModelDistributor([targetUrl], TRANSFER_TOKEN, 'pg-edge', store, 5_000),
      now: () => 200,
    });
    context.diagnostic('Starting the PostgreSQL-backed publication and web distribution profile.');
    const firstPublish = await publisher(goodTarget.url).execute({
      creatorId: 'different-manager', draftId: draft.draftId, expectedDraftRevision: saved!.draftRevision, expectedPublishedRevision: null,
    });
    assert.equal(firstPublish.publishedRevision, 1);
    assert.equal(activationCount, 1);
    const persistedV3Winner = await published.getActive(locationId);
    assert.equal(persistedV3Winner?.activeRevision, 1);
    assert.deepEqual(persistedV3Winner?.history.at(-1)?.document.furnitureDefaults, authoredAssignment,
      'the acknowledged v3 furniture assignment persists in PostgreSQL published history');
    context.diagnostic('Acknowledged v3 publication persisted; exercising failed-ACK winner retention.');

    const edit = await new StartLocationEditDraftUseCase({
      drafts, snapshots, mutationCoordinator: coordinator, now: () => 210,
    }).execute({ creatorId: 'different-manager', locationId, expectedPublishedRevision: 1 });
    draftIds.push(edit.draft.draftId);
    const changedAssignment = { table: { assetId: table.assetId, scale: 1.25, yawDeg: 75, elevationM: 0.1 } };
    const authoredEdit = {
      name: 'Edited furniture room', building: edit.draft.document.building,
      widthCm: edit.draft.document.widthCm, heightCm: edit.draft.document.heightCm,
      outline: edit.draft.document.outline, zones: edit.draft.document.zones,
      tables: edit.draft.document.tables, sensorAssignments: edit.draft.document.sensorAssignments,
      furnitureDefaults: changedAssignment,
    };
    const changed = await new SaveLocationDraftUseCase({ drafts, published, furnitureLibrary: store, now: () => 211 }).execute({
      creatorId: 'different-manager', draftId: edit.draft.draftId, expectedDraftRevision: 1, document: authoredEdit,
    });
    await assert.rejects(publisher(badTarget.url).execute({
      creatorId: 'different-manager', draftId: edit.draft.draftId,
      expectedDraftRevision: changed.draft.draftRevision, expectedPublishedRevision: 1,
    }), PublishedModelDistributionFailedError,
    'a real target rejection prevents the PostgreSQL publication commit');
    const stillWinning = await published.getActive(locationId);
    assert.equal(stillWinning?.activeRevision, 1, 'the previous persisted winner survives failed furniture acknowledgement');
    assert.deepEqual(stillWinning?.history.at(-1)?.document.furnitureDefaults, authoredAssignment,
      'the failed edited transform never replaces the acknowledged transform');
    assert.equal(activationCount, 1, 'the detached failed candidate is never activated');

    await cleanupFixtureRows(migrator, createdAssetIds, draftIds, locationIdForCleanup);
    await closePostgres(application);
    application = undefined;
    for (let index = 0; index < furnitureMigrations.length; index++) {
      await migrator.undoLastMigration({ transaction: 'all' });
      migrationsApplied -= 1;
    }
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets') AS table_name"))[0].table_name, null,
      'after furniture cleanup, the required migrations roll back cleanly');
    assert.equal((await migrator.query("SELECT to_regclass('public.registered_nodes') AS table_name"))[0].table_name, null,
      'the publication dependency table also returns to its original absent state');
    assert.equal((await migrator.query('SELECT COUNT(*)::int AS count FROM public.migrations'))[0].count, 0);
  } finally {
    if (goodTarget) await goodTarget.close().catch(() => undefined);
    if (badTarget) await badTarget.close().catch(() => undefined);
    let cleanupFailure: unknown;
    if (application?.isInitialized) {
      try { await closePostgres(application); } catch (error) { cleanupFailure = error; }
    }
    if (migrator.isInitialized) {
      try { await cleanupFixtureRows(migrator, createdAssetIds, draftIds, locationIdForCleanup); }
      catch (error) { cleanupFailure ??= error; }
      while (migrationsApplied > 0) {
        try {
          await migrator.undoLastMigration({ transaction: 'all' });
          migrationsApplied -= 1;
        } catch (error) {
          cleanupFailure ??= error;
          break;
        }
      }
      if (migrationsApplied === 0) {
        try {
          assert.equal((await migrator.query("SELECT to_regclass('public.location_assets') AS table_name"))[0].table_name, null);
          assert.equal((await migrator.query("SELECT to_regclass('public.registered_nodes') AS table_name"))[0].table_name, null);
          assert.equal((await migrator.query('SELECT COUNT(*)::int AS count FROM public.migrations'))[0].count, 0);
        } catch (error) { cleanupFailure ??= error; }
      }
    }
    try { await closePostgres(migrator); } catch (error) { cleanupFailure ??= error; }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure) throw new Error('The disposable PostgreSQL fixture did not return to its original state.', { cause: cleanupFailure });
  }
});

async function startWebTarget(directory: string, pushToken: string): Promise<{ url: string; close(): Promise<void> }> {
  mkdirSync(directory, { recursive: true });
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken, sessionSecret: Buffer.alloc(40, 4),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: [], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await web.ready;
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const address = web.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      web.server.closeAllConnections();
      await web.dispose();
      await new Promise<void>((resolve) => web.server.close(() => resolve()));
    },
  };
}

function postgresTestGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [] }), 'utf8');
  const paddedLength = Math.ceil(json.byteLength / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.byteLength, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  return bytes;
}

async function cleanupFixtureRows(
  source: ReturnType<typeof createPostgresDataSource>, assetIds: readonly string[], draftIds: readonly string[] = [], locationId?: string,
): Promise<void> {
  const table = (await source.query("SELECT to_regclass('public.location_assets') AS table_name"))[0]?.table_name;
  if (!table) return;
  if (locationId && (await source.query("SELECT to_regclass('public.location_active_revisions') AS table_name"))[0]?.table_name) {
    await source.query('DELETE FROM public.location_active_revisions WHERE location_id = $1', [locationId]);
    await source.query('ALTER TABLE public.location_published_revisions DISABLE TRIGGER location_published_revisions_immutable');
    try { await source.query('DELETE FROM public.location_published_revisions WHERE location_id = $1', [locationId]); }
    finally { await source.query('ALTER TABLE public.location_published_revisions ENABLE TRIGGER location_published_revisions_immutable'); }
  }
  if (draftIds.length && (await source.query("SELECT to_regclass('public.location_drafts') AS table_name"))[0]?.table_name) {
    await source.query('DELETE FROM public.location_drafts WHERE draft_id = ANY($1::uuid[])', [draftIds]);
  }
  if (assetIds.length) {
    await source.query('ALTER TABLE public.location_assets DISABLE TRIGGER location_assets_immutable');
    try { await source.query('DELETE FROM public.location_assets WHERE asset_id = ANY($1::uuid[])', [assetIds]); }
    finally { await source.query('ALTER TABLE public.location_assets ENABLE TRIGGER location_assets_immutable'); }
  }
}
