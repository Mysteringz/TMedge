import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { closePostgres, createPostgresDataSource, openPostgres, postgresAvailability } from '../src/infrastructure/postgres/data-source.js';

test('a disposable PostgreSQL accepts migrations and denies schema changes to runtime credentials', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), 'postgres-foundation-probe-migration.js');
  const migrator = createPostgresDataSource(config.migrator, [migrationPath]);
  const runtime = await openPostgres(config.runtime);
  let migrationApplied = false;

  try {
    await migrator.initialize();
    assert.deepEqual(await postgresAvailability(migrator), { available: true });
    assert.equal((await migrator.runMigrations({ transaction: 'all' })).length, 1);
    migrationApplied = true;
    assert.equal(
      (await migrator.query("SELECT to_regclass('public.tmedge_foundation_probe') AS table_name"))[0].table_name,
      'tmedge_foundation_probe',
      'the up migration created its table',
    );

    assert.deepEqual(await postgresAvailability(runtime), { available: true });
    await assert.rejects(
      runtime.query('CREATE TABLE public.tmedge_runtime_must_not_ddl (id integer)'),
      /permission denied/i,
    );

    await migrator.undoLastMigration({ transaction: 'all' });
    migrationApplied = false;
    assert.equal(
      (await migrator.query("SELECT to_regclass('public.tmedge_foundation_probe') AS table_name"))[0].table_name,
      null,
      'the down migration removed its table',
    );
    await closePostgres(runtime);
    await closePostgres(runtime);
    assert.equal(runtime.isInitialized, false, 'shutdown can be repeated safely');
  } finally {
    await closePostgres(runtime);
    if (migrationApplied && migrator.isInitialized) {
      await migrator.undoLastMigration({ transaction: 'all' }).catch(() => undefined);
    }
    await closePostgres(migrator);
  }
});
