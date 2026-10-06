import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPostgresConfig, loadPostgresConnectionConfig } from '../src/infrastructure/postgres/config.js';
import { createPostgresDataSource, postgresAvailability } from '../src/infrastructure/postgres/data-source.js';

const env = {
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGDATABASE: 'tmedge_test',
  PG_MIGRATION_USER: 'tmedge_migrator',
  PG_MIGRATION_PASSWORD: 'migration-secret-123',
  PG_RUNTIME_USER: 'tmedge_runtime',
  PG_RUNTIME_PASSWORD: 'runtime-secret-123',
};

test('PostgreSQL configuration keeps migration and runtime credentials separate', () => {
  const config = loadPostgresConfig(env);

  assert.equal(config.migrator.username, 'tmedge_migrator');
  assert.equal(config.runtime.username, 'tmedge_runtime');
  assert.notEqual(config.migrator.password, config.runtime.password);
  assert.equal(config.migrator.synchronize, false);
  assert.equal(config.runtime.synchronize, false);
  assert.equal(config.migrator.migrationsRun, false);
  assert.equal(config.runtime.migrationsRun, false);
});

test('PostgreSQL configuration preserves intentional whitespace in passwords', () => {
  const config = loadPostgresConfig({
    ...env,
    PG_MIGRATION_PASSWORD: ' migration-secret ',
    PG_RUNTIME_PASSWORD: ' runtime-secret ',
  });

  assert.equal(config.migrator.password, ' migration-secret ');
  assert.equal(config.runtime.password, ' runtime-secret ');
});

test('migration connection config does not require the runtime password', () => {
  const config = loadPostgresConnectionConfig('migrator', {
    PGDATABASE: 'tmedge_test',
    PG_MIGRATION_USER: 'tmedge_migrator',
    PG_MIGRATION_PASSWORD: 'migration-secret',
  });

  assert.equal(config.username, 'tmedge_migrator');
  assert.equal(config.password, 'migration-secret');
  assert.equal(config.role, 'migrator');
});

test('PostgreSQL configuration rejects shared database credentials', () => {
  assert.throws(
    () => loadPostgresConfig({ ...env, PG_RUNTIME_USER: env.PG_MIGRATION_USER }),
    /must be different/,
  );
  assert.throws(
    () => loadPostgresConfig({ ...env, PG_RUNTIME_PASSWORD: env.PG_MIGRATION_PASSWORD }),
    /must be different/,
  );
});

test('PostgreSQL DataSource never synchronizes schema or auto-runs migrations', () => {
  const source = createPostgresDataSource(loadPostgresConfig(env).runtime);

  assert.equal(source.options.type, 'postgres');
  assert.equal(source.options.username, 'tmedge_runtime');
  assert.equal(source.options.synchronize, false);
  assert.equal(source.options.migrationsRun, false);
  assert.equal(source.options.migrationsTransactionMode, 'all');
});

test('PostgreSQL availability reports an uninitialized connection as unavailable', async () => {
  const source = createPostgresDataSource(loadPostgresConfig(env).runtime);

  assert.deepEqual(await postgresAvailability(source), { available: false });
});

test('PostgreSQL configuration errors never include supplied passwords', () => {
  assert.throws(
    () => loadPostgresConfig({ ...env, PGPORT: 'not-a-port' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /PGPORT/);
      assert.ok(!error.message.includes(env.PG_MIGRATION_PASSWORD));
      assert.ok(!error.message.includes(env.PG_RUNTIME_PASSWORD));
      return true;
    },
  );
});
