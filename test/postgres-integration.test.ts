import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import dgram from 'node:dgram';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { closePostgres, createPostgresDataSource, openPostgres, postgresAvailability } from '../src/infrastructure/postgres/data-source.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  NodeRegistration,
  ProvisioningRepository,
  ProvisioningRequestRecord,
  ProvisioningTransaction,
} from '../src/modules/provisioning/repositories/provisioning-repository.js';
import { PostgresProvisioningRepository } from '../src/infrastructure/postgres/provisioning-repository.js';
import { DatabaseProvisioningService } from '../src/modules/provisioning/application/database-provisioning-service.js';
import { PostgresRegistryRepository } from '../src/infrastructure/postgres/registry-repository.js';
import { RegistrationImportExport } from '../src/modules/registration/application/registration-import-export.js';
import { identity, nodesJson, report, siteJson } from './fixtures.js';
import {
  PostgresFirmwareArtifactRepository,
  PostgresFirmwareBuildJobRepository,
} from '../src/infrastructure/postgres/firmware-build-repositories.js';
import type { FirmwareBuildJobRecord } from '../src/modules/firmware/repositories/firmware-build-job-repository.js';
import { PostgresRolloutRepository } from '../src/infrastructure/postgres/rollout-repository.js';
import type { RolloutRecord } from '../src/modules/rollouts/repositories/rollout-repository.js';
import { PostgresCommandOutcomeRepository } from '../src/infrastructure/postgres/command-outcome-repository.js';
import { PostgresOccupancyHistoryRepository } from '../src/infrastructure/postgres/occupancy-history-repository.js';
import type { OccupancyHistoryRecord } from '../src/modules/occupancy-history/repositories/occupancy-history-repository.js';
import { createEdgeApplication } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = [
  join(testDirectory, 'postgres-foundation-probe-migration.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790812800000-CreateRegistrationProvisioningAuditSchema.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790985600000-CreateFirmwareBuildPersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791072000000-CreateFirmwareRolloutPersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791158400000-CreateCommandOutcomePersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791244800000-CreateOccupancyHistory.js'),
];

async function approveTransaction(
  transaction: ProvisioningTransaction,
  requestId: string,
  actorId: string,
): Promise<NodeRegistration> {
  const request = await transaction.findRequestForUpdate(requestId);
  assert.ok(request);
  if (request.status === 'approved' && request.registeredUid === request.uid) {
    const existing = await transaction.findNode(request.uid);
    assert.ok(existing);
    return existing;
  }
  assert.equal(request.status, 'pending');
  const node: NodeRegistration = { uid: request.uid, label: request.label, floorId: null, pose: null, owns: [] };
  const now = 1_800_000_000_000;
  await transaction.registerNode(node);
  await transaction.saveRequest({
    ...request, status: 'approved', resolvedAt: now,
    resolvedBy: { id: actorId, kind: 'console' }, registeredUid: request.uid,
  });
  await transaction.appendAudit({
    actor: { id: actorId, kind: 'console' }, action: 'request.approved', subjectId: request.id, at: now,
  });
  return node;
}

test('registration schema and provisioning repository enforce persistence invariants', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrator = createPostgresDataSource(config.migrator, migrations);
  const runtime = await openPostgres(config.runtime);
  let appliedMigrations = 0;
  let importedRegistryUids: string[] = [];
  let buildJobIds: string[] = [];
  let buildArtifactIds: string[] = [];
  let rolloutIds: string[] = [];
  let commandIds: string[] = [];
  let historyEdgeIds: string[] = [];

  try {
    await migrator.initialize();
    assert.deepEqual(await postgresAvailability(migrator), { available: true });
    appliedMigrations = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(appliedMigrations, 6, 'foundation, registration, build, rollout, command, and occupancy migrations all run');
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

    const repository = new PostgresProvisioningRepository(runtime);
    const requestIds: string[] = [];
    const nodeUids = ['30:ed:a0:cc:dd:01', '30:ed:a0:cc:dd:02', '30:ed:a0:cc:dd:03', '30:ed:a0:cc:dd:04'];
    const makePending = async (uid: string, label: string, expiresAt = 1_900_000_000_000): Promise<ProvisioningRequestRecord> => {
      const request: ProvisioningRequestRecord = {
        id: randomUUID(), uid, label, firmware: null, requestedBy: 'integration-client',
        requestedAt: 1_800_000_000_000, expiresAt, status: 'pending',
        resolvedAt: null, resolvedBy: null, registeredUid: null,
      };
      requestIds.push(request.id);
      await repository.transaction(async (transaction) => {
        await transaction.lockPendingQueue();
        assert.equal(await transaction.findPendingRequestByNodeUid(uid), null);
        assert.equal(await transaction.countPendingRequests(), 0);
        await transaction.saveRequest(request);
        await transaction.appendAudit({
          actor: { id: 'integration-client', kind: 'system' },
          action: 'request.submitted', subjectId: request.id, at: request.requestedAt,
        });
      });
      return request;
    };
    const approve = (requestId: string, actorId: string) =>
      repository.transaction((transaction) => approveTransaction(transaction, requestId, actorId));

    try {
      const concurrent = await makePending(nodeUids[0]!, 'Concurrent approval');
      assert.equal((await repository.findRequest(concurrent.id))?.uid, concurrent.uid);
      assert.equal((await repository.findRequestByNodeUid(concurrent.uid))?.id, concurrent.id);
      assert.ok((await repository.listPendingRequests()).some((request) => request.id === concurrent.id));
      const [approvalA, approvalB] = await Promise.all([
        approve(concurrent.id, 'operator-one'), approve(concurrent.id, 'operator-two'),
      ]);
      assert.deepEqual(approvalA, approvalB);
      assert.deepEqual(await repository.findNode(concurrent.uid), approvalA);
      assert.equal((await repository.reconcile(concurrent.id, concurrent.uid))?.status, 'approved');
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.approved'",
        [concurrent.id],
      ))[0].count, 1, 'concurrent approvals serialize and append one audit event');
      assert.equal((await runtime.query('SELECT count(*)::int AS count FROM registered_nodes WHERE uid = $1', [concurrent.uid]))[0].count, 1);

      const uncertain = await makePending(nodeUids[1]!, 'Uncertain commit');
      let loseAcknowledgment = true;
      const uncertainRepository = new Proxy(repository, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (work: (transaction: ProvisioningTransaction) => Promise<unknown>) => {
              const committed = await target.transaction(work);
              if (loseAcknowledgment) {
                loseAcknowledgment = false;
                throw new Error('simulated lost commit acknowledgment');
              }
              return committed;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ProvisioningRepository;
      await assert.rejects(uncertainRepository.transaction((transaction) => approveTransaction(transaction, uncertain.id, 'operator-one')),
        /simulated lost commit acknowledgment/);
      const reconciled = await repository.reconcile(uncertain.id, uncertain.uid);
      assert.equal(reconciled?.status, 'approved');
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.approved'",
        [uncertain.id],
      ))[0].count, 1, 'reconciliation identifies the committed outcome without replaying the event');

      const expiring = await makePending(nodeUids[2]!, 'Expired request', 1_800_000_000_001);
      await repository.transaction(async (transaction) => {
        const expiredRequests = await transaction.findExpiredPendingRequestsForUpdate(expiring.expiresAt);
        assert.deepEqual(expiredRequests.map((request) => request.id), [expiring.id],
          'the expiry selector returns only requests past their deadline');
        const request = expiredRequests[0];
        assert.ok(request);
        const expired = {
          ...request, status: 'expired' as const, resolvedAt: expiring.expiresAt,
          resolvedBy: { id: 'provisioning-expiry', kind: 'system' as const },
        };
        await transaction.saveRequest(expired);
        await transaction.appendAudit({
          actor: expired.resolvedBy, action: 'request.expired', subjectId: request.id, at: expired.resolvedAt,
        });
      });
      assert.equal((await repository.reconcile(expiring.id, expiring.uid))?.status, 'expired');
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.expired'",
        [expiring.id],
      ))[0].count, 1, 'expired request resolution has one audit event');

      const rollback = await makePending(nodeUids[3]!, 'Rollback request');
      await assert.rejects(repository.transaction(async (transaction) => {
        const request = await transaction.findRequestForUpdate(rollback.id);
        assert.ok(request);
        await transaction.registerNode({ uid: request.uid, label: request.label, floorId: null, pose: null, owns: [] });
        await transaction.saveRequest({
          ...request, status: 'approved', resolvedAt: 1_800_000_000_000,
          resolvedBy: { id: 'operator-one', kind: 'console' }, registeredUid: request.uid,
        });
        await transaction.appendAudit({
          actor: { id: 'operator-one', kind: 'console' }, action: '', subjectId: request.id, at: 1_800_000_000_000,
        });
      }), (error: { driverError?: { code?: string } }) => error.driverError?.code === '23514');
      assert.equal((await repository.findRequest(rollback.id))?.status, 'pending');
      assert.equal(await repository.findNode(rollback.uid), null);
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.approved'",
        [rollback.id],
      ))[0].count, 0, 'audit failure rolled back both decision and registration');
      await approve(rollback.id, 'operator-one');
      assert.equal((await repository.findRequest(rollback.id))?.status, 'approved', 'rolled-back decision can be retried');
      assert.equal((await runtime.query('SELECT count(*)::int AS count FROM registered_nodes WHERE uid = $1', [rollback.uid]))[0].count, 1,
        'retry creates exactly one registered identity');
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.approved'",
        [rollback.id],
      ))[0].count, 1, 'retry creates exactly one approval audit event');
    } finally {
      await migrator.query('DELETE FROM provisioning_audit_events WHERE subject_id = ANY($1::text[])', [requestIds]);
      await migrator.query('DELETE FROM provisioning_requests WHERE id = ANY($1::uuid[])', [requestIds]);
      await migrator.query('DELETE FROM registered_nodes WHERE uid = ANY($1::text[])', [nodeUids]);
    }

    const registryRepository = new PostgresRegistryRepository(runtime);
    const importExport = new RegistrationImportExport(registryRepository);
    const provisionedUid = '30:ed:a0:cc:dd:05';
    const provisionedRequestIds: string[] = [];
    try {
      const liveRegistry = await importExport.loadRegistry(siteJson());
      const service = new DatabaseProvisioningService(new PostgresProvisioningRepository(runtime), liveRegistry, {
        token: 'integration-provisioning-token-32chars',
      });
      const queued = await service.request({ uid: provisionedUid, label: 'DB admitted identity' }, 'integration-test');
      assert.equal(queued.status, 'pending');
      if (queued.status !== 'pending') throw new Error('expected a pending provisioning request');
      provisionedRequestIds.push(queued.request.id);
      const approved = await service.approve(queued.request.id, 'integration-operator');
      assert.equal(approved.uid, provisionedUid);
      assert.equal(liveRegistry.nodes.get(provisionedUid)?.floorId, null, 'live activation only admits an unplaced identity');
      const restartedRegistry = await importExport.loadRegistry(siteJson());
      assert.equal(restartedRegistry.nodes.get(provisionedUid)?.label, 'DB admitted identity', 'a fresh startup loader sees the committed identity');
      assert.equal(restartedRegistry.nodes.get(provisionedUid)?.pose, null);
      assert.equal((await runtime.query(
        "SELECT count(*)::int AS count FROM provisioning_audit_events WHERE subject_id = $1 AND action = 'request.approved'",
        [queued.request.id],
      ))[0].count, 1, 'approval and its audit event commit once');
    } finally {
      if (provisionedRequestIds.length) {
        await migrator.query('DELETE FROM provisioning_audit_events WHERE subject_id = ANY($1::text[])', [provisionedRequestIds]);
        await migrator.query('DELETE FROM provisioning_requests WHERE id = ANY($1::uuid[])', [provisionedRequestIds]);
      }
      await migrator.query('DELETE FROM registered_nodes WHERE uid = $1', [provisionedUid]);
    }

    await exerciseDurableEdgeLifecycle(config.runtime, runtime);
    await exercisePostgresEdgeCutover(config.runtime, runtime, migrator);

    const registrationFile = nodesJson();
    importedRegistryUids = registrationFile.nodes.map((node, index) => {
      const uid = `aa:bb:cc:dd:ee:${(index + 1).toString(16).padStart(2, '0')}`;
      node.uid = uid;
      return uid;
    });
    registrationFile.nodes.push({ uid: 'aa:bb:cc:dd:ee:fe', label: 'Unplaced integration identity', owns: [] });
    importedRegistryUids.push('aa:bb:cc:dd:ee:fe');
    const preview = await importExport.import(siteJson(), registrationFile, { dryRun: true });
    assert.equal(preview.valid, true);
    assert.equal(preview.insertable, importedRegistryUids.length);
    assert.deepEqual(await registryRepository.listNodes(), []);
    const importResult = await importExport.import(siteJson(), registrationFile);
    assert.equal(importResult.inserted, importedRegistryUids.length);
    const rerun = await importExport.import(siteJson(), registrationFile);
    assert.equal(rerun.inserted, 0);
    assert.equal(rerun.unchanged, importedRegistryUids.length);
    const exported = await importExport.export(siteJson());
    assert.equal(exported.nodes.length, importedRegistryUids.length);
    const unplaced = exported.nodes.find((node) => node.uid === 'aa:bb:cc:dd:ee:fe');
    assert.ok(unplaced);
    assert.equal('floor' in unplaced, false);
    assert.equal('pose' in unplaced, false);
    assert.equal((await importExport.loadRegistry(siteJson())).nodes.size, importedRegistryUids.length);

    const artifactRepository = new PostgresFirmwareArtifactRepository(runtime);
    const jobRepository = new PostgresFirmwareBuildJobRepository(runtime);
    const imageBytes = Buffer.alloc(512, 7);
    const hash = createHash('sha256').update(imageBytes).digest('hex');
    const artifact = { id: hash.slice(0, 16), sha256: hash, size: imageBytes.length, version: 'test-fw-1' };
    await artifactRepository.save(artifact);
    await artifactRepository.save(artifact);
    assert.deepEqual(await artifactRepository.get(artifact.id), artifact);
    await assert.rejects(artifactRepository.save({ ...artifact, version: 'mutated' }), /metadata conflict/);
    const unverifiedJobRepository = new PostgresFirmwareBuildJobRepository(runtime);
    const interruptedJob: FirmwareBuildJobRecord = {
      id: randomUUID(), uploadId: 'upload-interrupted', actor: { id: 'tester', kind: 'console' },
      lifecycle: 'running', startedAt: 1_800_000_000_000, finishedAt: null, artifact: null,
      log: Array.from({ length: 450 }, (_, index) => `log-${index}`), error: null,
    };
    const successfulJob: FirmwareBuildJobRecord = {
      id: randomUUID(), uploadId: 'upload-success', actor: { id: 'tester', kind: 'console' },
      lifecycle: 'succeeded', startedAt: 1_800_000_000_001, finishedAt: 1_800_000_000_100,
      artifact, log: ['compile complete'], error: null,
    };
    const acceptedJob: FirmwareBuildJobRecord = {
      id: randomUUID(), uploadId: 'upload-accepted', actor: { id: 'tester', kind: 'console' },
      lifecycle: 'accepted', startedAt: 1_800_000_000_002, finishedAt: null, artifact: null, log: [], error: null,
    };
    buildJobIds = [interruptedJob.id, successfulJob.id, acceptedJob.id];
    buildArtifactIds = [artifact.id];
    await jobRepository.create(interruptedJob);
    await jobRepository.create(acceptedJob);
    await assert.rejects(unverifiedJobRepository.create(successfulJob), /artifact content verifier/);
    const missingBytesRepository = new PostgresFirmwareBuildJobRepository(runtime, { read: () => null });
    await assert.rejects(missingBytesRepository.create(successfulJob), /artifact bytes are missing/);
    const wrongBytesRepository = new PostgresFirmwareBuildJobRepository(runtime, {
      read: () => Buffer.alloc(512, 8),
    });
    await assert.rejects(wrongBytesRepository.create(successfulJob), /fail SHA-256 verification/);
    const wrongLengthRepository = new PostgresFirmwareBuildJobRepository(runtime, { read: () => imageBytes });
    await assert.rejects(wrongLengthRepository.create({
      ...successfulJob, artifact: { ...artifact, size: artifact.size - 1 },
    }), /fail SHA-256 verification/);
    assert.equal(await jobRepository.get(successfulJob.id), null, 'invalid artifact bytes cannot create a succeeded job');
    const verifiedJobRepository = new PostgresFirmwareBuildJobRepository(runtime, {
      read: (id, sha256, size) => id === artifact.id && sha256 === artifact.sha256 && size === artifact.size ? imageBytes : null,
    });
    await assert.rejects(verifiedJobRepository.create({
      ...successfulJob, artifact: { ...artifact, version: 'uncommitted-metadata' },
    }), /committed firmware artifact metadata is missing or mismatched/);
    assert.equal(await jobRepository.get(successfulJob.id), null, 'mismatched metadata cannot create a succeeded job');
    await verifiedJobRepository.create(successfulJob);
    assert.equal((await jobRepository.get(interruptedJob.id))?.log.length, 400, 'persisted build logs are bounded');
    assert.equal((await jobRepository.get(interruptedJob.id))?.lifecycle, 'running', 'running state was committed before restart recovery');
    assert.deepEqual((await runtime.query('SELECT lifecycle FROM public.firmware_build_jobs WHERE id = $1', [interruptedJob.id]))[0],
      { lifecycle: 'running' }, 'database stores the state that restart reconciliation must find');
    await jobRepository.save({ ...interruptedJob, log: Array.from({ length: 40 }, () => 'x'.repeat(4096)) });
    const boundedJob = await jobRepository.get(interruptedJob.id);
    assert.ok(boundedJob);
    assert.ok(Buffer.byteLength(JSON.stringify(boundedJob.log)) <= 128 * 1024, 'persisted log payload has a byte cap');
    assert.deepEqual(await artifactRepository.list(), [artifact]);
    const interrupted = await jobRepository.markActiveInterrupted(1_800_000_000_200);
    assert.equal(interrupted.length, 2);
    const interruptedById = new Map(interrupted.map((job) => [job.id, job]));
    assert.equal(interruptedById.get(interruptedJob.id)?.lifecycle, 'interrupted');
    assert.equal(interruptedById.get(acceptedJob.id)?.lifecycle, 'interrupted');
    assert.equal(interruptedById.get(interruptedJob.id)?.finishedAt, 1_800_000_000_200);
    assert.match(interruptedById.get(interruptedJob.id)?.error ?? '', /process restart/);
    assert.deepEqual(await jobRepository.markActiveInterrupted(1_800_000_000_300), [], 'recovery is idempotent and never replays an active job');
    assert.equal((await jobRepository.get(successfulJob.id))?.artifact?.sha256, hash);
    await assert.rejects(artifactRepository.delete(artifact.id), /foreign key/i, 'job history keeps referenced artifact metadata');
    await runtime.query('DELETE FROM public.firmware_build_jobs WHERE id = ANY($1::text[])', [buildJobIds]);
    await artifactRepository.delete(artifact.id);
    buildJobIds = [];
    buildArtifactIds = [];

    const rolloutRepository = new PostgresRolloutRepository(runtime);
    const rollout: RolloutRecord = {
      id: randomUUID(), buildId: artifact.id, version: artifact.version,
      target: { kind: 'all' }, startedBy: 'operator', startedAt: 1_800_000_000_300,
      finishedAt: null, stage: 'pilot', note: 'Pilot first', nodes: [
        { uid: '30:ed:a0:cc:dd:01', label: 'Pilot', floorId: 'iw-maker-a', gatewayId: null,
          transport: 'direct', state: 'sending', percent: 55, startedAt: 1_800_000_000_310, updatedAt: 1_800_000_000_320 },
        { uid: '30:ed:a0:cc:dd:02', label: 'Queued node', floorId: 'iw-maker-a', gatewayId: null,
          transport: 'udp', state: 'queued', percent: 0, startedAt: null, updatedAt: 1_800_000_000_320 },
      ],
    };
    rolloutIds = [rollout.id];
    await rolloutRepository.saveSnapshot(rollout, []);
    assert.deepEqual(await rolloutRepository.current(), rollout);
    const badSnapshot: RolloutRecord = {
      ...rollout, id: randomUUID(), stage: 'done', finishedAt: rollout.startedAt + 1,
      nodes: [{ ...rollout.nodes[0]!, percent: 101 }],
    };
    const uncommittedUpdate = { ...rollout, note: 'must roll back' };
    await assert.rejects(rolloutRepository.saveSnapshot(uncommittedUpdate, [uncommittedUpdate, badSnapshot]), /check constraint/i);
    assert.equal((await rolloutRepository.current())?.note, rollout.note, 'failed snapshot rolls back every record in the transaction');
    const updatedRollout: RolloutRecord = {
      ...rollout, stage: 'rest', note: 'Pilot confirmed; batch in progress',
      nodes: [
        { ...rollout.nodes[0]!, state: 'confirmed', percent: 100 },
        { ...rollout.nodes[1]!, state: 'sending', percent: 20 },
      ],
    };
    await rolloutRepository.saveSnapshot(updatedRollout, []);
    assert.deepEqual(await rolloutRepository.current(), updatedRollout, 'per-node state and pilot-first stage survive reads');
    const interruptedRollout = await rolloutRepository.interruptActive(1_800_000_000_400);
    assert.equal(interruptedRollout?.stage, 'stopped');
    assert.equal(interruptedRollout?.recoveryState, 'interrupted');
    assert.equal(interruptedRollout?.finishedAt, 1_800_000_000_400);
    assert.equal(interruptedRollout?.nodes[0]?.state, 'confirmed');
    assert.equal(interruptedRollout?.nodes[1]?.outcomeUncertain, true);
    assert.match(interruptedRollout?.nodes[1]?.error ?? '', /uncertain after restart/);
    assert.deepEqual(await runtime.query(
      'SELECT state, outcome_uncertain FROM public.firmware_rollout_node_events WHERE rollout_id = $1 AND uid = $2 ORDER BY id',
      [rollout.id, '30:ed:a0:cc:dd:02'],
    ), [
      { state: 'queued', outcome_uncertain: false },
      { state: 'sending', outcome_uncertain: false },
      { state: 'sending', outcome_uncertain: true },
    ], 'per-node state transitions and restart uncertainty remain in append-only history');
    assert.equal(await rolloutRepository.current(), null, 'interrupted rollout is not resumed as active');
    assert.deepEqual(await rolloutRepository.history(), [interruptedRollout]);
    assert.equal(await rolloutRepository.interruptActive(1_800_000_000_500), null, 'restart recovery does not dispatch or re-interrupt history');
    await runtime.query('DELETE FROM public.firmware_rollouts WHERE id = ANY($1::text[])', [rolloutIds]);
    rolloutIds = [];

    const commandRepository = new PostgresCommandOutcomeRepository(runtime);
    const commandId = randomUUID();
    const ambiguousCommandId = randomUUID();
    const failedCommandId = randomUUID();
    commandIds = [commandId, ambiguousCommandId, failedCommandId];
    const intent = {
      id: commandId, nodeId: '30:ed:a0:cb:f5:f8', command: 'reboot',
      actor: { id: 'operator', kind: 'console' as const }, outcome: 'requested' as const, at: 1_800_000_000_500,
    };
    await commandRepository.record(intent);
    let dispatched = false;
    await (async () => {
      assert.deepEqual((await runtime.query(
        'SELECT outcome, actor_id, actor_kind FROM public.command_outcomes WHERE command_id = $1', [commandId],
      ))[0], { outcome: 'requested', actor_id: 'operator', actor_kind: 'console' },
      'intent and actor are durable before dispatch is attempted');
      dispatched = true;
    })();
    assert.equal(dispatched, true);
    await commandRepository.record({ ...intent, outcome: 'sent', at: intent.at + 1 });
    await commandRepository.record({ ...intent, outcome: 'acknowledged', at: intent.at + 2 });
    await commandRepository.record({ ...intent, outcome: 'sent', at: intent.at + 1 });
    assert.deepEqual(await runtime.query(
      'SELECT outcome FROM public.command_outcomes WHERE command_id = $1 ORDER BY id', [commandId],
    ), [{ outcome: 'requested' }, { outcome: 'sent' }, { outcome: 'acknowledged' }]);
    await assert.rejects(commandRepository.record({ ...intent, outcome: 'sent', at: intent.at + 10 }), /Conflicting command outcome/);
    assert.equal((await runtime.query('SELECT count(*)::int AS count FROM public.command_outcomes WHERE command_id = $1', [commandId]))[0].count, 3);
    const ambiguous = { ...intent, id: ambiguousCommandId, command: 'set-param:occupancy-threshold' };
    await commandRepository.record(ambiguous);
    await commandRepository.record({ ...ambiguous, outcome: 'sent', at: intent.at + 1 });
    await commandRepository.record({ ...ambiguous, outcome: 'timed-out', at: intent.at + 5 });
    await commandRepository.record({ ...ambiguous, outcome: 'uncertain', at: intent.at + 6 });
    assert.deepEqual(await runtime.query(
      'SELECT outcome FROM public.command_outcomes WHERE command_id = $1 ORDER BY id', [ambiguousCommandId],
    ), [{ outcome: 'requested' }, { outcome: 'sent' }, { outcome: 'timed-out' }, { outcome: 'uncertain' }]);
    await assert.rejects(commandRepository.record({ ...intent, id: failedCommandId, command: '   ' }), /check constraint/i);
    assert.equal((await runtime.query('SELECT count(*)::int AS count FROM public.command_outcomes WHERE command_id = $1', [failedCommandId]))[0].count, 0,
      'failed intent persistence leaves no partial command row to dispatch');
    await runtime.query('DELETE FROM public.command_outcomes WHERE command_id = ANY($1::text[])', [commandIds]);
    commandIds = [];

    const historyRepository = new PostgresOccupancyHistoryRepository(runtime);
    const historyEdgeId = 'edge-task-history-test';
    historyEdgeIds = [historyEdgeId];
    const historyRows: OccupancyHistoryRecord[] = [
      { edgeId: historyEdgeId, floorId: 'floor-a', tableId: 'T1', minuteAt: 1_800_000_000_000,
        sampledAt: 1_800_000_000_001, capacity: 4, occupied: 2, free: 2, coverage: 'ok' },
      { edgeId: historyEdgeId, floorId: 'floor-a', tableId: 'T2', minuteAt: 1_800_000_000_000,
        sampledAt: 1_800_000_000_001, capacity: 2, occupied: null, free: null, coverage: 'unknown' },
    ];
    await historyRepository.writeBatch(historyRows);
    await historyRepository.writeBatch([
      { ...historyRows[0]!, sampledAt: 1_800_000_010_000, occupied: 3, free: 1 }, historyRows[1]!,
    ]);
    const historyResult = await runtime.query(
      'SELECT table_id, sampled_at, occupied, free, coverage FROM public.occupancy_history WHERE edge_id = $1 ORDER BY table_id',
      [historyEdgeId],
    );
    assert.equal(historyResult.length, 2, 'same-minute retries upsert one row per table');
    assert.deepEqual(historyResult[0], {
      table_id: 'T1', sampled_at: new Date(1_800_000_010_000), occupied: 3, free: 1, coverage: 'ok',
    });
    await historyRepository.writeBatch([
      { ...historyRows[0]!, sampledAt: 1_800_000_002_000, occupied: 1, free: 3 },
    ]);
    const newestHistoryResult = await runtime.query(
      'SELECT sampled_at, occupied FROM public.occupancy_history WHERE edge_id = $1 AND table_id = $2',
      [historyEdgeId, 'T1'],
    );
    assert.deepEqual(newestHistoryResult[0], { sampled_at: new Date(1_800_000_010_000), occupied: 3 },
      'late retry cannot replace a newer minute sample');
    assert.equal(historyResult[1]?.coverage, 'unknown');
    assert.equal(historyResult[1]?.occupied, null);
    assert.equal(historyResult[1]?.free, null);
    const nextMinuteInvalid = { ...historyRows[0]!, minuteAt: 1_800_000_060_000, sampledAt: 1_800_000_060_001, occupied: 4, free: 0 };
    await assert.rejects(historyRepository.writeBatch([
      { ...nextMinuteInvalid, edgeId: 'edge-rollback-probe', tableId: 'T3' },
      { ...nextMinuteInvalid, edgeId: 'edge-rollback-probe', tableId: 'T4', coverage: 'unknown' },
    ]), /check constraint/i);
    assert.equal((await runtime.query('SELECT count(*)::int AS count FROM public.occupancy_history WHERE edge_id = $1', ['edge-rollback-probe']))[0].count, 0,
      'failed history batch is atomic');
    await runtime.query('DELETE FROM public.occupancy_history WHERE edge_id = ANY($1::text[])', [historyEdgeIds]);
    historyEdgeIds = [];

    assert.deepEqual(await postgresAvailability(runtime), { available: true });
    await assert.rejects(
      runtime.query('CREATE TABLE public.tmedge_runtime_must_not_ddl (id integer)'),
      /permission denied/i,
    );

    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.occupancy_history') AS table_name"))[0].table_name, null);
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.command_outcomes') AS table_name"))[0].table_name, null);
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.firmware_rollouts') AS table_name"))[0].table_name, null);
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.firmware_artifacts') AS table_name"))[0].table_name, null);
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
    if (runtime.isInitialized && historyEdgeIds.length > 0) {
      await runtime.query('DELETE FROM public.occupancy_history WHERE edge_id = ANY($1::text[])', [historyEdgeIds]).catch(() => undefined);
    }
    if (runtime.isInitialized && commandIds.length > 0) {
      await runtime.query('DELETE FROM public.command_outcomes WHERE command_id = ANY($1::text[])', [commandIds]).catch(() => undefined);
    }
    if (runtime.isInitialized && rolloutIds.length > 0) {
      await runtime.query('DELETE FROM public.firmware_rollouts WHERE id = ANY($1::text[])', [rolloutIds]).catch(() => undefined);
    }
    if (runtime.isInitialized && buildJobIds.length > 0) {
      await runtime.query('DELETE FROM public.firmware_build_jobs WHERE id = ANY($1::text[])', [buildJobIds]).catch(() => undefined);
    }
    if (runtime.isInitialized && buildArtifactIds.length > 0) {
      await runtime.query('DELETE FROM public.firmware_artifacts WHERE id = ANY($1::text[])', [buildArtifactIds]).catch(() => undefined);
    }
    if (runtime.isInitialized && importedRegistryUids.length > 0) {
      await runtime.query('DELETE FROM public.node_table_owners WHERE uid = ANY($1::text[])', [importedRegistryUids]).catch(() => undefined);
      await runtime.query('DELETE FROM public.node_placements WHERE uid = ANY($1::text[])', [importedRegistryUids]).catch(() => undefined);
      await runtime.query('DELETE FROM public.registered_nodes WHERE uid = ANY($1::text[])', [importedRegistryUids]).catch(() => undefined);
    }
    await closePostgres(runtime);
    while (appliedMigrations > 0 && migrator.isInitialized) {
      await migrator.undoLastMigration({ transaction: 'all' }).catch(() => undefined);
      appliedMigrations -= 1;
    }
    await closePostgres(migrator);
  }
});

async function exerciseDurableEdgeLifecycle(
  pg: ReturnType<typeof loadPostgresConfig>['runtime'],
  database: import('typeorm').DataSource,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-durable-lifecycle-'));
  const composeArgs = ['compose', '-f', 'docker-compose.postgres-test.yml'];
  const projectRoot = dirname(dirname(testDirectory));
  const runCompose = (...args: string[]) => execFileSync('docker', [...composeArgs, ...args], {
    cwd: projectRoot, stdio: 'pipe', encoding: 'utf8',
  });
  const uid = randomMac();
  const uploadIds: string[] = [];
  const rolloutIds: string[] = [];
  const artifactIds: string[] = [];
  const previousWorkerUrl = process.env.FIRMWARE_BUILD_WORKER_URL;
  let app: ReturnType<typeof createEdgeApplication> | null = null;
  let restartedApp: ReturnType<typeof createEdgeApplication> | null = null;
  let databaseStopped = false;
  let workerRequestCount = 0;
  let holdNextBuild = false;
  let heldResponse: ServerResponse | null = null;
  let notifyHeldBuild: (() => void) | null = null;
  let heldBuildStarted = new Promise<void>((resolve) => { notifyHeldBuild = resolve; });
  const artifactBytes = Buffer.from('synthetic-firmware-for-postgres-lifecycle');
  const worker = createHttpServer((request, response) => {
    workerRequestCount += 1;
    request.resume();
    request.once('end', () => {
      if (holdNextBuild) {
        holdNextBuild = false;
        heldResponse = response;
        notifyHeldBuild?.();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end([
        { type: 'log', line: 'synthetic build complete' },
        { type: 'result', exitCode: 0, artifactBase64: artifactBytes.toString('base64') },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    });
  });

  let workerPort = 0;
  try {
    await new Promise<void>((resolve, reject) => worker.once('error', reject).listen(0, '127.0.0.1', resolve));
    workerPort = (worker.address() as AddressInfo).port;
    process.env.FIRMWARE_BUILD_WORKER_URL = `http://127.0.0.1:${workerPort}/build`;

    await database.query('INSERT INTO public.registered_nodes (uid, label) VALUES ($1, $2)', [uid, 'Durable lifecycle node']);
    const registration = new RegistrationImportExport(new PostgresRegistryRepository(database));
    const registry = await registration.loadRegistry(siteJson());
    const cfg: EdgeConfig = {
      edgeId: 'durable-lifecycle-test', keys: [Buffer.from('test-key')], allowUnsigned: false,
      udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: join(directory, 'must-not-be-used.json'),
      persistenceMode: 'postgres', postgres: pg, dataDir: directory, recordRaw: false,
      consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'lifecycle-admin', flashToken: null,
      pushUrls: [], pushToken: '', publishMs: 60_000, gatewayPort: 0, gatewayToken: null,
      nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
    };
    app = createEdgeApplication(cfg, registry, { postgres: database });
    await app.start();
    const consolePort = (app.consoleServer.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${consolePort}`;
    const authorization = `Basic ${Buffer.from('operator:lifecycle-admin').toString('base64')}`;
    const headers = { authorization, 'x-tm-console': '1', 'content-type': 'application/json' };
    const downlinks: Buffer[] = [];
    const nodeIdentity = identity(uid);
    const route = {
      kind: 'direct' as const,
      address: `ws:${uid}:synthetic-session`,
      session: {
        uid, sessionId: 'synthetic-session', key: Buffer.from('test-key'),
        send: (packet: Buffer) => { downlinks.push(packet); return true; },
        grantOta: () => true,
        admit: () => null,
      },
    };
    assert.equal(app.runtime.ingest.handle(report(nodeIdentity, [], 1), route).ok, true);

    const firstUpload = await createUpload(base, headers);
    uploadIds.push(firstUpload);
    assert.equal((await startBuild(base, headers, firstUpload)).status, 202);
    await waitForJobLifecycle(database, firstUpload, 'succeeded');
    const buildId = (await database.query(
      'SELECT artifact_id FROM public.firmware_build_jobs WHERE upload_id = $1', [firstUpload],
    ))[0].artifact_id as string;
    artifactIds.push(buildId);

    const commandResponse = await fetch(`${base}/api/nodes/${encodeURIComponent(uid)}/command`, {
      method: 'POST', headers, body: JSON.stringify({ op: 'identify' }),
    });
    assert.equal(commandResponse.status, 200, await commandResponse.text());
    assert.equal(downlinks.length, 1, 'the composed command service dispatches over the active direct-node route');
    assert.deepEqual(await database.query(
      'SELECT outcome FROM public.command_outcomes WHERE node_id = $1 ORDER BY id', [uid],
    ), [{ outcome: 'requested' }, { outcome: 'sent' }]);

    const startRollout = async () => {
      const response = await fetch(`${base}/api/firmware/rollout`, {
        method: 'POST', headers, body: JSON.stringify({ buildId, target: { kind: 'node', uid } }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ id: string }>;
    };
    const firstRollout = await startRollout();
    rolloutIds.push(firstRollout.id);
    await waitForDownlinkCount(downlinks, 2);
    assert.ok(downlinks.length >= 2, 'the persisted rollout dispatches its pilot OTA request');
    const firstCancel = await fetch(`${base}/api/firmware/rollout/cancel`, { method: 'POST', headers });
    assert.equal(firstCancel.status, 200, await firstCancel.text());
    assert.equal((await database.query('SELECT stage FROM public.firmware_rollouts WHERE id = $1', [firstRollout.id]))[0].stage, 'stopped');

    const secondRollout = await startRollout();
    rolloutIds.push(secondRollout.id);
    await waitForDownlinkCount(downlinks, 3);
    holdNextBuild = true;
    heldBuildStarted = new Promise<void>((resolve) => { notifyHeldBuild = resolve; });
    const secondUpload = await createUpload(base, headers);
    uploadIds.push(secondUpload);
    assert.equal((await startBuild(base, headers, secondUpload)).status, 202);
    await heldBuildStarted;
    await waitForJobLifecycle(database, secondUpload, 'running');

    runCompose('stop', 'postgres-test');
    databaseStopped = true;
    const readyResponse = await fetch(`${base}/readyz`, { headers: { authorization } });
    const readiness = await readyResponse.json() as { ready: boolean; components: { persistence: { available: boolean } } };
    assert.equal(readiness.ready, true, 'the edge process remains live through a running database outage');
    assert.equal(readiness.components.persistence.available, false);

    const sentBeforeOutageCommand = downlinks.length;
    const rejectedCommand = await fetch(`${base}/api/nodes/${encodeURIComponent(uid)}/command`, {
      method: 'POST', headers, body: JSON.stringify({ op: 'identify' }),
    });
    assert.equal(rejectedCommand.status, 503);
    assert.equal(downlinks.length, sentBeforeOutageCommand, 'a command is not dispatched when intent persistence is unavailable');

    const rejectedCancel = await fetch(`${base}/api/firmware/rollout/cancel`, { method: 'POST', headers });
    assert.equal(rejectedCancel.status, 503);
    assert.notEqual(app.runtime.rolloutService.current() && (app.runtime.rolloutService.current() as { stage: string }).stage, 'stopped',
      'failed cancellation restores the last in-memory rollout state');
    assert.equal(app.runtime.ingest.handle(report(nodeIdentity, [], 2), route).ok, true,
      'live packet ingestion continues without PostgreSQL calls');

    await app.stop();
    app = null;
    assert.ok(heldResponse, 'the worker had an active request when the edge shut down');
    heldResponse = null;

    runCompose('start', 'postgres-test');
    databaseStopped = false;
    await waitForDatabase(database);
    const restoredRegistry = await registration.loadRegistry(siteJson());
    restartedApp = createEdgeApplication(cfg, restoredRegistry, { postgres: database });
    await restartedApp.start();
    assert.equal(workerRequestCount, 2, 'startup recovery does not submit the interrupted build to the worker again');
    assert.equal((await database.query(
      'SELECT lifecycle FROM public.firmware_build_jobs WHERE upload_id = $1', [secondUpload],
    ))[0].lifecycle, 'interrupted');
    assert.ok((await database.query('SELECT outcome FROM public.command_outcomes WHERE node_id = $1', [uid]))
      .some((row: { outcome: string }) => row.outcome === 'uncertain'), 'restart reconciles the sent command to uncertain');
    const recoveredRollouts = await new PostgresRolloutRepository(database).history();
    assert.ok(recoveredRollouts.some((item) => item.id === secondRollout.id && item.recoveryState === 'interrupted'),
      'restart retains the rollout as interrupted and does not replay it');
  } finally {
    if (databaseStopped) {
      runCompose('start', 'postgres-test');
      await waitForDatabase(database);
      databaseStopped = false;
    }
    await restartedApp?.stop().catch(() => undefined);
    await app?.stop().catch(() => undefined);
    if (database.isInitialized) {
      await database.query('DELETE FROM public.command_outcomes WHERE node_id = $1', [uid]).catch(() => undefined);
      if (rolloutIds.length) await database.query('DELETE FROM public.firmware_rollouts WHERE id = ANY($1::text[])', [rolloutIds]).catch(() => undefined);
      if (uploadIds.length) {
        const jobs = await database.query('DELETE FROM public.firmware_build_jobs WHERE upload_id = ANY($1::text[]) RETURNING artifact_id', [uploadIds]).catch(() => []);
        for (const row of jobs as Array<{ artifact_id?: string }>) if (row.artifact_id) artifactIds.push(row.artifact_id);
      }
      if (artifactIds.length) await database.query('DELETE FROM public.firmware_artifacts WHERE id = ANY($1::text[])', [artifactIds]).catch(() => undefined);
      await database.query('DELETE FROM public.registered_nodes WHERE uid = $1', [uid]).catch(() => undefined);
    }
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    if (previousWorkerUrl === undefined) delete process.env.FIRMWARE_BUILD_WORKER_URL;
    else process.env.FIRMWARE_BUILD_WORKER_URL = previousWorkerUrl;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function createUpload(base: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(`${base}/api/firmware/uploads`, { method: 'POST', headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { uploadId: string };
  for (const [path, content] of [
    ['platformio.ini', '[env:tmflash]\nplatform = native\n'],
    ['include/tm_config.h', '#define TM_FW_VERSION "test-1"\n'],
  ] as const) {
    const file = await fetch(`${base}/api/firmware/uploads/${body.uploadId}/files?path=${encodeURIComponent(path)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: content,
    });
    assert.equal(file.status, 200, await file.text());
  }
  return body.uploadId;
}

async function startBuild(base: string, headers: Record<string, string>, uploadId: string): Promise<Response> {
  return fetch(`${base}/api/firmware/uploads/${uploadId}/build`, { method: 'POST', headers });
}

async function waitForJobLifecycle(
  database: import('typeorm').DataSource, uploadId: string, expected: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const rows = await database.query('SELECT lifecycle FROM public.firmware_build_jobs WHERE upload_id = $1', [uploadId]);
    if (rows[0]?.lifecycle === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`firmware build ${uploadId} did not reach ${expected}`);
}

async function waitForDownlinkCount(downlinks: readonly Buffer[], expected: number): Promise<void> {
  const started = Date.now();
  while (downlinks.length < expected && Date.now() - started < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(downlinks.length >= expected, `expected ${expected} downlink packet(s), observed ${downlinks.length}`);
}

function randomMac(): string {
  const hex = randomUUID().replaceAll('-', '').slice(0, 12).match(/.{2}/g);
  if (!hex) throw new Error('could not generate an integration-test node identity');
  return hex.join(':');
}

async function exercisePostgresEdgeCutover(
  pg: ReturnType<typeof loadPostgresConfig>['runtime'],
  database: import('typeorm').DataSource,
  migrator: import('typeorm').DataSource,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-cutover-'));
  const nodesPath = join(directory, 'must-not-be-read-or-created.json');
  const projectRoot = dirname(dirname(testDirectory));
  const composeArgs = ['compose', '-f', 'docker-compose.postgres-test.yml'];
  const runCompose = (...args: string[]) => execFileSync('docker', [...composeArgs, ...args], {
    cwd: projectRoot, stdio: 'pipe', encoding: 'utf8',
  });
  const failingPort = await freeTcpPort();
  let failed: EdgeProcess | null = null;
  let live: EdgeProcess | null = null;
  let restarted: EdgeProcess | null = null;
  let databaseStopped = false;
  const token = 'cutover-token-with-at-least-32-chars';
  const uid = '30:ed:a0:cc:dd:06';
  const outageUid = '30:ed:a0:cc:dd:07';
  const requestIds: string[] = [];
  try {
    failed = await launchPostgresEdge(pg, directory, failingPort);
    await waitForExit(failed.child, 15_000);
    assert.equal(failed.child.exitCode, 2, failed.state.output);
    assert.match(failed.state.output, /PostgreSQL registry could not be opened or validated/);

    live = await launchPostgresEdge(pg, directory, pg.port);
    const startupLine = await waitForOutput(live, /registered nodes/, 15_000);
    assert.match(startupLine, /0 registered nodes/, 'PostgreSQL mode starts from the database view');
    assert.equal(existsSync(nodesPath), false, 'approval and restart did not create or mutate nodes.json');

    const base = `http://127.0.0.1:${live.consolePort}`;
    const queued = await queueNode(base, token, uid, 'Process cutover node');
    requestIds.push(queued.id);
    assert.equal((await decideNode(base, queued.id, 'approve')).status, 200);
    const outagePending = await queueNode(base, token, outageUid, 'Outage retry node');
    requestIds.push(outagePending.id);

    runCompose('stop', 'postgres-test');
    databaseStopped = true;
    await waitForAcceptedPacketDuringOutage(base, live, uid);
    const rejectedWhileDown = await decideNode(base, outagePending.id, 'approve');
    assert.equal(rejectedWhileDown.status, 409, 'durable approval is rejected while PostgreSQL is unavailable');
    assert.equal(live.child.exitCode, null, 'the edge process remains running during database outage');
    const liveUids = await readLiveNodeUids(base);
    assert.ok(liveUids.includes(uid), 'the last committed identity remains active during outage');
    assert.ok(!liveUids.includes(outageUid), 'the failed approval does not activate an uncommitted identity');
    assert.equal(existsSync(nodesPath), false, 'the outage does not trigger a nodes.json fallback');

    runCompose('start', 'postgres-test');
    databaseStopped = false;
    await waitForDatabase(database);
    assert.equal((await decideNode(base, outagePending.id, 'approve')).status, 200, 'operator retry commits after recovery');
    await stopChild(live.child);

    restarted = await launchPostgresEdge(pg, directory, pg.port);
    const restartedLine = await waitForOutput(restarted, /registered nodes/, 15_000);
    assert.match(restartedLine, /2 registered nodes/, 'restart loads both committed registrations from PostgreSQL');
    assert.equal(existsSync(nodesPath), false, 'approval and restart did not create or mutate nodes.json');
  } finally {
    let cleanupFailure: unknown;
    if (databaseStopped) {
      try {
        runCompose('start', 'postgres-test');
        await waitForDatabase(database);
        databaseStopped = false;
      } catch (error) {
        cleanupFailure = error;
      }
    }
    for (const edge of [failed, live, restarted]) {
      if (edge && edge.child.exitCode === null) {
        try { await stopChild(edge.child); }
        catch (error) { cleanupFailure ??= error; }
      }
    }
    if (requestIds.length) {
      try {
        await migrator.query('DELETE FROM provisioning_audit_events WHERE subject_id = ANY($1::text[])', [requestIds]);
        await migrator.query('DELETE FROM provisioning_requests WHERE id = ANY($1::uuid[])', [requestIds]);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try { await migrator.query('DELETE FROM registered_nodes WHERE uid = ANY($1::text[])', [[uid, outageUid]]); }
    catch (error) { cleanupFailure ??= error; }
    rmSync(directory, { recursive: true, force: true });
    if (cleanupFailure) throw cleanupFailure;
  }
}

async function queueNode(base: string, token: string, uid: string, label: string): Promise<{ id: string }> {
  const response = await fetch(`${base}/api/provision/request`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ uid, label }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json() as Promise<{ id: string }>;
}

async function decideNode(base: string, id: string, verdict: 'approve' | 'deny'): Promise<Response> {
  return fetch(`${base}/api/provision/requests/${id}/${verdict}`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Basic ${Buffer.from('edge-admin:edge-admin-password').toString('base64')}`,
      'x-tm-console': '1',
    },
  });
}

async function waitForAcceptedPacketDuringOutage(base: string, edge: EdgeProcess, uid: string): Promise<void> {
  const auth = `Basic ${Buffer.from('edge-admin:edge-admin-password').toString('base64')}`;
  const tokenResponse = await fetch(`${base}/api/ws-token`, { headers: { authorization: auth } });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json() as { token: string };
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('console WebSocket failed during database outage')), { once: true });
    });
    const reportReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signed report did not reach the running edge during database outage')), 5000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; uid?: string };
        if (message.type === 'report' && message.uid === uid) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const packet = report(identity(uid), [], 1);
    const sender = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => sender.send(packet, edge.udpPort, '127.0.0.1', (error) => {
      sender.close();
      if (error) reject(error); else resolve();
    }));
    await reportReceived;
  } finally {
    socket.close();
  }
}

async function readLiveNodeUids(base: string): Promise<string[]> {
  const auth = `Basic ${Buffer.from('edge-admin:edge-admin-password').toString('base64')}`;
  const tokenResponse = await fetch(`${base}/api/ws-token`, { headers: { authorization: auth } });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json() as { token: string };
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  try {
    const state = await new Promise<{ nodes?: Array<{ uid?: string }> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('console state did not arrive during database outage')), 5000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; nodes?: Array<{ uid?: string }> };
        if (message.type === 'state') {
          clearTimeout(timer);
          resolve(message);
        }
      });
      socket.addEventListener('error', () => reject(new Error('console WebSocket failed while reading live state')), { once: true });
    });
    return (state.nodes ?? []).flatMap((node) => node.uid ? [node.uid] : []);
  } finally {
    socket.close();
  }
}

async function waitForDatabase(database: import('typeorm').DataSource): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      await database.query('SELECT 1');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('disposable PostgreSQL test service did not recover');
}

interface EdgeProcess {
  child: ChildProcess;
  state: { output: string };
  consolePort: number;
  udpPort: number;
}

async function launchPostgresEdge(
  pg: ReturnType<typeof loadPostgresConfig>['runtime'],
  directory: string,
  connectPort: number,
): Promise<EdgeProcess> {
  const consolePort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const projectRoot = dirname(dirname(testDirectory));
  const child = spawn(process.execPath, [join(projectRoot, 'dist/src/edge/main.js')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TM_KEY: 'test-key', WEB_PUSH_URLS: '', PERSISTENCE_MODE: 'postgres',
      PGHOST: pg.host, PGPORT: String(connectPort), PGDATABASE: pg.database,
      PG_RUNTIME_USER: pg.username, PG_RUNTIME_PASSWORD: pg.password,
      SITE_CONFIG: join(projectRoot, 'config/site.json'),
      NODES_CONFIG: join(directory, 'must-not-be-read-or-created.json'),
      DATA_DIR: directory, UDP_PORT: String(udpPort), UDP_HOST: '127.0.0.1',
      CONSOLE_PORT: String(consolePort), CONSOLE_HOST: '127.0.0.1',
      ADMIN_PASSWORD: 'edge-admin-password', TMFLASH_TOKEN: 'cutover-token-with-at-least-32-chars',
      ALGO_PORT: '0', NODE_PORT: '0', GATEWAY_PORT: '0', PUBLISH_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { output: '' };
  child.stdout?.on('data', (chunk: Buffer) => { state.output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { state.output += chunk.toString(); });
  return { child, state, consolePort, udpPort };
}

async function waitForOutput(edge: EdgeProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (!pattern.test(edge.state.output)) {
    if (edge.child.exitCode !== null) throw new Error(`edge exited before readiness: ${edge.state.output}`);
    if (Date.now() - started > timeoutMs) throw new Error(`edge did not become ready: ${edge.state.output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return edge.state.output;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge process did not exit')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child, 15_000);
  assert.equal(child.exitCode, 0, 'edge exits cleanly after SIGTERM');
}

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function freeUdpPort(): Promise<number> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => socket.once('error', reject).bind(0, '127.0.0.1', resolve));
  const address = socket.address();
  socket.close();
  return address.port;
}
