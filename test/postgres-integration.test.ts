import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { closePostgres, createPostgresDataSource, openPostgres, postgresAvailability } from '../src/infrastructure/postgres/data-source.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = [
  join(testDirectory, 'postgres-foundation-probe-migration.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790812800000-CreateRegistrationProvisioningAuditSchema.js'),
];

test('registration, provisioning, and audit migrations enforce persistence invariants', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrator = createPostgresDataSource(config.migrator, migrations);
  const runtime = await openPostgres(config.runtime);
  let appliedMigrations = 0;

  try {
    await migrator.initialize();
    assert.deepEqual(await postgresAvailability(migrator), { available: true });
    appliedMigrations = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(appliedMigrations, 2, 'foundation and registration migrations both run');
    assert.equal(
      (await migrator.query("SELECT to_regclass('public.tmedge_foundation_probe') AS table_name"))[0].table_name,
      'tmedge_foundation_probe',
    );

    const runner = migrator.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const rejectsConstraint = async (sql: string, parameters: unknown[] = [], expectedCode?: string) => {
      await runner.query('SAVEPOINT expected_constraint');
      await assert.rejects(runner.query(sql, parameters), (error: { driverError?: { code?: string } }) =>
        expectedCode === undefined || error.driverError?.code === expectedCode);
      await runner.query('ROLLBACK TO SAVEPOINT expected_constraint');
      await runner.query('RELEASE SAVEPOINT expected_constraint');
    };
    try {
      const uid = '30:ed:a0:cb:f5:f8';
      const otherUid = '02:00:00:00:00:02';
      await runner.query('INSERT INTO registered_nodes (uid, label) VALUES ($1, $2), ($3, $4)', [
        uid, 'Existing node', otherUid, 'Second node',
      ]);
      assert.equal((await runner.query('SELECT uid FROM registered_nodes WHERE uid = $1', [uid]))[0].uid, uid);
      assert.equal(
        (await runner.query('SELECT count(*)::int AS count FROM node_placements WHERE uid = $1', [uid]))[0].count,
        0,
        'identity-only registration has no placement',
      );
      await rejectsConstraint('INSERT INTO registered_nodes (uid, label) VALUES ($1, $2)', [uid, 'Duplicate'], '23505');
      await rejectsConstraint(
        'INSERT INTO node_placements (uid, floor_id, x, y, height_cm, yaw_deg, mirror) VALUES ($1, $2, 1, 2, 350, 0, false)',
        ['02:00:00:00:00:99', 'iw-maker-a'],
        '23503',
      );
      await runner.query(
        "INSERT INTO node_placements (uid, floor_id, x, y, height_cm, yaw_deg, mirror) VALUES ($1, 'iw-maker-a', 1, 2, 350, 0, false), ($2, 'iw-maker-a', 3, 4, 350, 0, false)",
        [uid, otherUid],
      );
      assert.equal((await runner.query('SELECT floor_id FROM node_placements WHERE uid = $1', [uid]))[0].floor_id, 'iw-maker-a');
      await runner.query('INSERT INTO node_table_owners (table_id, uid) VALUES ($1, $2), ($3, $4)', ['M3', uid, 'M4', otherUid]);
      assert.equal((await runner.query('SELECT table_id FROM node_table_owners WHERE uid = $1', [uid]))[0].table_id, 'M3');
      await rejectsConstraint('INSERT INTO node_table_owners (table_id, uid) VALUES ($1, $2)', ['M3', otherUid], '23505');
      await rejectsConstraint('INSERT INTO node_table_owners (table_id, uid) VALUES ($1, $2)', ['M5', '02:00:00:00:00:99'], '23503');

      const requestedAt = '2026-01-01T00:00:00.000Z';
      const expiresAt = '2026-01-02T00:00:00.000Z';
      const pendingUid = 'AA:BB:CC:DD:EE:FF';
      const pendingId = '10000000-0000-4000-8000-000000000001';
      await runner.query(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status) VALUES ($1, $2, 'Pending', 'operator', $3, $4, 'pending')",
        [pendingId, pendingUid, requestedAt, expiresAt],
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status) VALUES ('10000000-0000-4000-8000-000000000002', $1, 'Duplicate pending', 'operator', $2, $3, 'pending')",
        [pendingUid, requestedAt, expiresAt],
        '23505',
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status) VALUES ('10000000-0000-4000-8000-000000000005', 'AA:BB:CC:DD:EE:00', 'Bad expiry', 'operator', $1, $1, 'pending')",
        [requestedAt],
        '23514',
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status, resolved_at, resolved_by_id, resolved_by_kind) VALUES ('10000000-0000-4000-8000-000000000006', 'AA:BB:CC:DD:EE:01', 'Invalid pending', 'operator', $1, $2, 'pending', $2, 'operator', 'console')",
        [requestedAt, expiresAt],
        '23514',
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status, resolved_at, resolved_by_id, resolved_by_kind) VALUES ('10000000-0000-4000-8000-000000000007', 'AA:BB:CC:DD:EE:02', 'Unresolved expired', 'operator', $1, $2, 'expired', $2, null, null)",
        [requestedAt, expiresAt],
        '23514',
      );
      await rejectsConstraint(
        "UPDATE provisioning_requests SET status = 'expired', resolved_at = $2, resolved_by_id = 'system-expiry', resolved_by_kind = 'system' WHERE id = $1",
        [pendingId, '2026-01-01T23:59:59.999Z'],
        '23514',
      );
      await runner.query(
        "UPDATE provisioning_requests SET status = 'expired', resolved_at = $2, resolved_by_id = 'system-expiry', resolved_by_kind = 'system' WHERE id = $1",
        [pendingId, expiresAt],
      );
      await runner.query(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status) VALUES ('10000000-0000-4000-8000-000000000004', $1, 'New pending', 'operator', $2, $3, 'pending')",
        [pendingUid, expiresAt, '2026-01-03T00:00:00.000Z'],
      );
      await runner.query(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status, resolved_at, resolved_by_id, resolved_by_kind, registered_uid) VALUES ('10000000-0000-4000-8000-000000000008', $1, 'Approved', 'operator', $2, $3, 'approved', $3, 'operator-1', 'console', $1)",
        [uid, requestedAt, expiresAt],
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status, resolved_at, resolved_by_id, resolved_by_kind, registered_uid) VALUES ('10000000-0000-4000-8000-000000000010', $1, 'Duplicate approval', 'operator', $2, $3, 'approved', $3, 'operator-2', 'console', $1)",
        [uid, requestedAt, expiresAt],
        '23505',
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_requests (id, uid, label, requested_by, requested_at, expires_at, status, resolved_at, resolved_by_id, resolved_by_kind, registered_uid) VALUES ('10000000-0000-4000-8000-000000000009', $1, 'Mismatched approval', 'operator', $2, $3, 'approved', $3, 'operator-1', 'console', $4)",
        [uid, requestedAt, expiresAt, otherUid],
        '23514',
      );

      await runner.query(
        "INSERT INTO provisioning_audit_events (actor_id, actor_kind, action, subject_id, occurred_at) VALUES ('operator-1', 'console', 'request.approved', $1, $2)",
        [pendingId, requestedAt],
      );
      assert.equal(
        (await runner.query('SELECT subject_id FROM provisioning_audit_events WHERE action = $1', ['request.approved']))[0].subject_id,
        pendingId,
        'audit subject identifier is preserved exactly',
      );
      await rejectsConstraint(
        "INSERT INTO provisioning_audit_events (actor_id, actor_kind, action, subject_id, occurred_at) VALUES ('operator-1', 'unknown', 'request.approved', $1, $2)",
        [pendingId, requestedAt],
        '22P02',
      );
      await runner.rollbackTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }

    assert.deepEqual(await postgresAvailability(runtime), { available: true });
    await assert.rejects(
      runtime.query('CREATE TABLE public.tmedge_runtime_must_not_ddl (id integer)'),
      /permission denied/i,
    );

    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.registered_nodes') AS table_name"))[0].table_name, null);
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.tmedge_foundation_probe') AS table_name"))[0].table_name, null);
    await closePostgres(runtime);
    await closePostgres(runtime);
    assert.equal(runtime.isInitialized, false, 'shutdown can be repeated safely');
  } finally {
    await closePostgres(runtime);
    while (appliedMigrations > 0 && migrator.isInitialized) {
      await migrator.undoLastMigration({ transaction: 'all' }).catch(() => undefined);
      appliedMigrations -= 1;
    }
    await closePostgres(migrator);
  }
});
