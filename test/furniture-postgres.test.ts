import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { closePostgres, createPostgresDataSource } from '../src/infrastructure/postgres/data-source.js';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { CreateLocationConfigurationStorage1791676800000 } from '../src/infrastructure/postgres/migrations/1791676800000-CreateLocationConfigurationStorage.js';
import { PersistLocationSpatialProvenance1791763200000 } from '../src/infrastructure/postgres/migrations/1791763200000-PersistLocationSpatialProvenance.js';
import { PersistLocationAssetProvenance1791849600000 } from '../src/infrastructure/postgres/migrations/1791849600000-PersistLocationAssetProvenance.js';
import { AddLocationAssetDisplayName1791936000000 } from '../src/infrastructure/postgres/migrations/1791936000000-AddLocationAssetDisplayName.js';
import { AddFurnitureLocationAssets1792022400000 } from '../src/infrastructure/postgres/migrations/1792022400000-AddFurnitureLocationAssets.js';
import {
  PostgresLocationAssetMetadataRepository, PostgresLocationAssetStore, PostgresLocationDraftRepository,
} from '../src/infrastructure/postgres/location-configuration-repositories.js';
import { createLocationId, parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { InvalidLocationDocumentError } from '../src/modules/location-config/domain/location-document.js';
import { LocationDraft } from '../src/modules/location-config/domain/location-records.js';
import type { PublishedLocationRepository } from '../src/modules/location-config/repositories/location-storage.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';

const furnitureMigrations = [
  CreateLocationConfigurationStorage1791676800000,
  PersistLocationSpatialProvenance1791763200000,
  PersistLocationAssetProvenance1791849600000,
  AddLocationAssetDisplayName1791936000000,
  AddFurnitureLocationAssets1792022400000,
];

test('PostgreSQL furniture metadata is shared, authored assignments persist, and rollback fails safely', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrator = createPostgresDataSource(config.migrator, furnitureMigrations);
  const dataDir = mkdtempSync(join(tmpdir(), 'tmedge-furniture-postgres-'));
  const createdAssetIds: string[] = [];
  let migrationsApplied = 0;
  let draftId: string | undefined;

  try {
    await migrator.initialize();
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets') AS table_name"))[0].table_name, null,
      'the disposable fixture starts without application tables');
    assert.equal((await migrator.query('SELECT COUNT(*)::int AS count FROM public.migrations'))[0].count, 0,
      'the disposable fixture migration ledger is empty');
    migrationsApplied = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(migrationsApplied, 5);

    const store = new PostgresLocationAssetStore(migrator, dataDir);
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
    const document = parseLocationDocument({
      schemaVersion: 1, locationId, name: 'PostgreSQL furniture draft', building: 'Test building', visibility: 'public',
      widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [], tables: [], sensorAssignments: [],
    });
    const draft: LocationDraft = {
      draftId: randomUUID(), creatorId: 'different-manager', locationId, draftRevision: 1,
      basePublishedRevision: null, createdAt: 100, updatedAt: 100, document, legacySpatial: null, assetProvenance: {},
    };
    draftId = draft.draftId;
    const drafts = new PostgresLocationDraftRepository(migrator);
    await drafts.createDraft(draft);
    const useCase = new SaveLocationDraftUseCase({
      drafts,
      published: { getActive: async () => null } as unknown as PublishedLocationRepository,
      furnitureLibrary: store,
      assetMetadata: new PostgresLocationAssetMetadataRepository(migrator),
      now: () => 101,
    });
    const authored = {
      name: document.name, building: document.building, widthCm: document.widthCm, heightCm: document.heightCm,
      outline: document.outline, zones: document.zones, tables: document.tables, sensorAssignments: document.sensorAssignments,
      furnitureDefaults: { table: { assetId: table.assetId, scale: 1.25, yawDeg: 30, elevationM: 0.1 } },
    };
    await useCase.execute({ creatorId: 'different-manager', draftId: draft.draftId, expectedDraftRevision: 1, document: authored });
    const saved = await drafts.getDraft('different-manager', draft.draftId);
    assert.deepEqual(saved?.document.furnitureDefaults, authored.furnitureDefaults,
      'schema-v1 furniture transforms survive the existing PostgreSQL JSON draft path');
    await assert.rejects(useCase.execute({
      creatorId: 'different-manager', draftId: draft.draftId, expectedDraftRevision: 2,
      document: { ...authored, furnitureDefaults: { table: { assetId: chair.assetId, scale: 1, yawDeg: 0, elevationM: 0 } } },
    }), InvalidLocationDocumentError, 'a chair item cannot be assigned to the table slot');

    const queryRunner = migrator.createQueryRunner();
    await queryRunner.connect();
    try {
      await assert.rejects(new AddFurnitureLocationAssets1792022400000().down(queryRunner), /Cannot revert furniture metadata/);
    } finally { await queryRunner.release(); }
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets_furniture_library_idx') AS index_name"))[0].index_name,
      'location_assets_furniture_library_idx', 'failed rollback leaves the library index intact');
    assert.equal((await migrator.query("SELECT COUNT(*)::int AS count FROM public.location_assets WHERE purpose = 'furniture'"))[0].count, 2,
      'failed rollback leaves immutable furniture metadata intact');

    await cleanupFixtureRows(migrator, createdAssetIds, draftId);
    await migrator.undoLastMigration({ transaction: 'all' }); migrationsApplied -= 1;
    await migrator.undoLastMigration({ transaction: 'all' }); migrationsApplied -= 1;
    await migrator.undoLastMigration({ transaction: 'all' }); migrationsApplied -= 1;
    await migrator.undoLastMigration({ transaction: 'all' }); migrationsApplied -= 1;
    await migrator.undoLastMigration({ transaction: 'all' }); migrationsApplied -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.location_assets') AS table_name"))[0].table_name, null,
      'after furniture cleanup, the five required migrations roll back cleanly');
    assert.equal((await migrator.query('SELECT COUNT(*)::int AS count FROM public.migrations'))[0].count, 0);
  } finally {
    if (migrator.isInitialized) {
      await cleanupFixtureRows(migrator, createdAssetIds, draftId).catch(() => undefined);
      while (migrationsApplied > 0) {
        await migrator.undoLastMigration({ transaction: 'all' }).catch(() => undefined);
        migrationsApplied -= 1;
      }
    }
    await closePostgres(migrator);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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

async function cleanupFixtureRows(source: ReturnType<typeof createPostgresDataSource>, assetIds: readonly string[], draftId?: string): Promise<void> {
  const table = (await source.query("SELECT to_regclass('public.location_assets') AS table_name"))[0]?.table_name;
  if (!table) return;
  if (draftId && (await source.query("SELECT to_regclass('public.location_drafts') AS table_name"))[0]?.table_name) {
    await source.query('DELETE FROM public.location_drafts WHERE draft_id = $1', [draftId]);
  }
  if (assetIds.length) {
    await source.query('ALTER TABLE public.location_assets DISABLE TRIGGER location_assets_immutable');
    try { await source.query('DELETE FROM public.location_assets WHERE asset_id = ANY($1::uuid[])', [assetIds]); }
    finally { await source.query('ALTER TABLE public.location_assets ENABLE TRIGGER location_assets_immutable'); }
  }
}
