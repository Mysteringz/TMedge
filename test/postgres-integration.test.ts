import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
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
import { PostgresRegistryRepository } from '../src/infrastructure/postgres/registry-repository.js';
import { RegistrationImportExport } from '../src/modules/registration/application/registration-import-export.js';
import { nodesJson, siteJson } from './fixtures.js';
import {
  PostgresFirmwareArtifactRepository,
  PostgresFirmwareBuildJobRepository,
} from '../src/infrastructure/postgres/firmware-build-repositories.js';
import type { FirmwareBuildJobRecord } from '../src/modules/firmware/repositories/firmware-build-job-repository.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = [
  join(testDirectory, 'postgres-foundation-probe-migration.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790812800000-CreateRegistrationProvisioningAuditSchema.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790985600000-CreateFirmwareBuildPersistence.js'),
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

  try {
    await migrator.initialize();
    assert.deepEqual(await postgresAvailability(migrator), { available: true });
    appliedMigrations = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(appliedMigrations, 3, 'foundation, registration, and build migrations all run');
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
      await runtime.query('DELETE FROM provisioning_audit_events WHERE subject_id = ANY($1::text[])', [requestIds]);
      await runtime.query('DELETE FROM provisioning_requests WHERE id = ANY($1::uuid[])', [requestIds]);
      await runtime.query('DELETE FROM registered_nodes WHERE uid = ANY($1::text[])', [nodeUids]);
    }

    const registryRepository = new PostgresRegistryRepository(runtime);
    const importExport = new RegistrationImportExport(registryRepository);
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

    assert.deepEqual(await postgresAvailability(runtime), { available: true });
    await assert.rejects(
      runtime.query('CREATE TABLE public.tmedge_runtime_must_not_ddl (id integer)'),
      /permission denied/i,
    );

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
