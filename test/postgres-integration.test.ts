import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import express from 'express';
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
import { PostgresRegistryMutationCoordinator } from '../src/infrastructure/location-config/postgres-registry-mutation-coordinator.js';
import {
  PostgresLocationAssetStore,
  PostgresLocationAssetMetadataRepository,
  PostgresLocationDraftRepository,
  PostgresPublishedLocationRepository,
} from '../src/infrastructure/postgres/location-configuration-repositories.js';
import { bootstrapPostgresLegacyLocations } from '../src/infrastructure/postgres/location-storage-bootstrap.js';
import type { OccupancyHistoryRecord } from '../src/modules/occupancy-history/repositories/occupancy-history-repository.js';
import { createLocationId, parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { LocationConflictError, LocationStorageUnavailableError, type LocationDraft } from '../src/modules/location-config/domain/location-records.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';
import { createLocationRouter, type LocationRouterDependencies } from '../src/modules/location-config/routes/location-router.js';
import { computeLocationCoverageSuggestions } from '../src/infrastructure/location-config/location-coverage.js';
import { createEdgeApplication, createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { EdgeLocationPublicationRuntime } from '../src/edge/location-publication-runtime.js';
import { buildRegistryFromLocationDocuments } from '../src/edge/registry.js';
import { PostgresLocationRegistrySnapshotRepository } from '../src/infrastructure/postgres/location-registry-snapshot-repository.js';
import { PublishLocationUseCase } from '../src/modules/location-config/use-cases/publish-location.js';
import { CreateLocationDraftUseCase } from '../src/modules/location-config/use-cases/create-location-draft.js';
import { StartLocationEditDraftUseCase } from '../src/modules/location-config/use-cases/start-location-edit-draft.js';
import { SaveLocationDraftUseCase } from '../src/modules/location-config/use-cases/save-location-draft.js';
import { UploadLocationAssetUseCase } from '../src/modules/location-config/use-cases/upload-location-asset.js';
import { ReadLocationDraftAssetUseCase } from '../src/modules/location-config/use-cases/read-location-draft-asset.js';
import { exposeLocationCandidate, parseLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import type { LocationRegistrySnapshot } from '../src/modules/location-config/repositories/location-storage.js';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { isSnapshot } from '../src/web/store.js';
import { assertPostgresBuildLogBoundary } from './postgres-build-log-regression.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = [
  join(testDirectory, 'postgres-foundation-probe-migration.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790812800000-CreateRegistrationProvisioningAuditSchema.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1790985600000-CreateFirmwareBuildPersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791072000000-CreateFirmwareRolloutPersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791158400000-CreateCommandOutcomePersistence.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791244800000-CreateOccupancyHistory.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791590400000-AddRegistrationDetector.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791676800000-CreateLocationConfigurationStorage.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791763200000-PersistLocationSpatialProvenance.js'),
  join(testDirectory, '../src/infrastructure/postgres/migrations/1791849600000-PersistLocationAssetProvenance.js'),
];

function postgresStorageTestDocument(locationId: string, tableId: string, seatId: string, sensorUid?: string) {
  return parseLocationDocument({
    schemaVersion: 1, locationId, name: 'PostgreSQL storage test', building: 'Test building', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: `${tableId}-zone`, name: 'Test zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{
      id: tableId, name: 'Test table', zoneId: `${tableId}-zone`, capacity: 1,
      shape: { type: 'rect', x: 120, y: 100, width: 80, height: 60 },
      seats: [{ id: seatId, x: 120, y: 80, neighbors: [] }],
    }],
    sensorAssignments: sensorUid ? [{
      uid: sensorUid,
      pose: { x: 100, y: 100, heightCm: 350, yawDeg: 0, mirror: false },
      owns: [tableId],
    }] : [],
  });
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

function postgresBatchAssignmentDocument(locationId: string, sensorUids: readonly string[]) {
  const tableCount = sensorUids.length * 3;
  const tables = Array.from({ length: tableCount }, (_, index) => {
    const x = 10 + (index % 8) * 45;
    const y = 10 + Math.floor(index / 8) * 45;
    return {
      id: `PG-BATCH-TABLE-${String(index).padStart(2, '0')}`,
      name: `Batch table ${index}`,
      zoneId: 'PG-BATCH-ZONE',
      capacity: 1,
      shape: { type: 'rect' as const, x, y, width: 20, height: 20 },
      seats: [{ id: `PG-BATCH-SEAT-${String(index).padStart(2, '0')}`, x: x + 10, y: y + 30, neighbors: [] }],
    };
  });
  return parseLocationDocument({
    schemaVersion: 1, locationId, name: 'PostgreSQL assignment batch', building: 'Test building', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'PG-BATCH-ZONE', name: 'Batch zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables,
    sensorAssignments: sensorUids.map((uid, index) => ({
      uid,
      pose: { x: 100 + index, y: 100, heightCm: 350, yawDeg: 0, mirror: false },
      owns: Array.from({ length: 3 }, (_, offset) => tables[index * 3 + offset]!.id),
    })),
  });
}

function postgresLegacyOutline(): number[][] {
  const outline = Array.from({ length: 257 }, (_, index) => {
    const angle = (index / 257) * Math.PI * 2;
    return [200 + Math.cos(angle) * 100, 150 + Math.sin(angle) * 100];
  });
  outline[0] = [-10, -10];
  return outline;
}

function emittedLocationSnapshot(site: unknown, snapshot: LocationRegistrySnapshot, edgeId: string) {
  const documents = snapshot.locations.flatMap((state) => {
    if (state.activeRevision === 0) return [];
    const active = state.history.find((revision) => revision.revision === state.activeRevision);
    return active ? [parseLocationDocument(active.document)] : [];
  });
  const legacySpatial = new Map(snapshot.locations.flatMap((state) => {
    const active = state.history.find((revision) => revision.revision === state.activeRevision);
    return state.activeRevision !== 0 && active?.legacySpatial ? [[state.locationId, active.legacySpatial] as const] : [];
  }));
  const nodeInput = { nodes: snapshot.nodes.map((node) => ({
    uid: node.uid, label: node.label,
    ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
    owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
  })) };
  return new OccupancyEngine(
    buildRegistryFromLocationDocuments(site, nodeInput, documents, legacySpatial), edgeId,
  ).snapshot(100);
}

function postgresTestEdgeConfig(dataDir: string): EdgeConfig {
  return {
    edgeId: 'pg-location-integration', keys: [], allowUnsigned: true, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'postgres', postgres: null,
    dataDir, recordRaw: false, consolePort: 0, consoleHost: '127.0.0.1', algoPort: 0,
    adminPassword: null, flashToken: null, pushUrls: [], pushToken: '', publishMs: 60_000,
    gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0,
    nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
}

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
  const node: NodeRegistration = {
    uid: request.uid, label: request.label, floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node',
  };
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
    assert.equal(appliedMigrations, 10, 'foundation, registration, build, rollout, command, occupancy, detector, location storage, spatial provenance and asset provenance migrations all run');
    assert.equal((await migrator.query("SELECT to_regclass('public.location_published_revisions') AS table_name"))[0].table_name, 'location_published_revisions');
    await assertPostgresBuildLogBoundary(runtime);
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
      assert.deepEqual(approvalA, {
        uid: concurrent.uid, label: 'Concurrent approval', floorId: null, pose: null, owns: [],
        simulated: false, rgb: false, detector: 'node',
      }, 'concurrent approval preserves the complete canonical node registration');
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
        await transaction.registerNode({
          uid: request.uid, label: request.label, floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node',
        });
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

    const mutationCoordinator = new PostgresRegistryMutationCoordinator(runtime);
    const registryRepository = new PostgresRegistryRepository(runtime, mutationCoordinator);
    const importExport = new RegistrationImportExport(registryRepository, mutationCoordinator);
    const provisionedUid = '30:ed:a0:cc:dd:05';
    const provisionedRequestIds: string[] = [];
    try {
      const liveRegistry = await importExport.loadRegistry(siteJson());
      const service = new DatabaseProvisioningService(new PostgresProvisioningRepository(runtime), liveRegistry, {
        token: 'integration-provisioning-token-32chars',
        mutationCoordinator,
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
    registrationFile.nodes[0]!.detector = 'edge';
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
    assert.equal(exported.nodes.find((node) => node.uid === importedRegistryUids[0])?.detector, 'edge');
    assert.equal((await importExport.loadRegistry(siteJson())).nodes.get(importedRegistryUids[0]!)?.detector, 'edge');
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
    assert.equal((await migrator.query(
      "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('location_drafts', 'location_published_revisions') AND column_name = 'legacy_spatial'",
    ))[0].count, 0, 'the exact-base provenance migration can be reverted independently');
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query("SELECT to_regclass('public.location_published_revisions') AS table_name"))[0].table_name, null,
      'the location-storage migration can be reverted independently');
    await migrator.undoLastMigration({ transaction: 'all' });
    appliedMigrations -= 1;
    assert.equal((await migrator.query(
      "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registered_nodes' AND column_name = 'detector'",
    ))[0].count, 0, 'the detector migration can be reverted independently');
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

test('location PostgreSQL storage bootstraps legacy state idempotently and commits history, placements and assets atomically', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrator = createPostgresDataSource(config.migrator, migrations);
  const runtime = await openPostgres(config.runtime);
  const dataDirectory = mkdtempSync(join(tmpdir(), 'tmedge-location-pg-'));
  let applied = 0;
  let approvalEdgeRuntime: ReturnType<typeof createEdgeRuntime> | null = null;
  const registeredUids = Array.from({ length: 32 }, (_, index) => `aa:bb:cc:dd:ff:${(0x11 + index).toString(16).padStart(2, '0')}`);
  const locationIds = [
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000031'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000032'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000033'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000034'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000035'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000037'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000038'),
    createLocationId('pg-test', '00000000-0000-4000-8000-000000000039'),
  ];
  try {
    await migrator.initialize();
    applied = (await migrator.runMigrations({ transaction: 'all' })).length;
    assert.equal(applied, 10);
    const runtimePrivileges = (await migrator.query(`
      SELECT
        (SELECT tableowner FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'registered_nodes') AS registered_nodes_owner,
        has_schema_privilege($1, 'public', 'USAGE') AS runtime_schema_usage,
        has_schema_privilege($1, 'public', 'CREATE') AS runtime_schema_create,
        has_table_privilege($1, 'public.registered_nodes', 'SELECT') AS registered_nodes_select,
        has_table_privilege($1, 'public.registered_nodes', 'INSERT') AS registered_nodes_insert,
        has_table_privilege($1, 'public.registered_nodes', 'UPDATE') AS registered_nodes_update,
        has_table_privilege($1, 'public.registered_nodes', 'DELETE') AS registered_nodes_delete,
        has_table_privilege($1, 'public.location_drafts', 'SELECT') AS drafts_select,
        has_table_privilege($1, 'public.location_drafts', 'INSERT') AS drafts_insert,
        has_table_privilege($1, 'public.location_drafts', 'UPDATE') AS drafts_update,
        has_table_privilege($1, 'public.location_drafts', 'DELETE') AS drafts_delete,
        has_table_privilege($1, 'public.location_assets', 'SELECT') AS assets_select,
        has_table_privilege($1, 'public.location_assets', 'INSERT') AS assets_insert,
        has_table_privilege($1, 'public.location_assets', 'UPDATE') AS assets_update,
        has_table_privilege($1, 'public.location_assets', 'DELETE') AS assets_delete,
        has_table_privilege($1, 'public.migrations', 'SELECT') AS migration_ledger_select
    `, [config.runtime.username]))[0];
    assert.deepEqual(runtimePrivileges, {
      registered_nodes_owner: config.migrator.username,
      runtime_schema_usage: true,
      runtime_schema_create: false,
      registered_nodes_select: true,
      registered_nodes_insert: true,
      registered_nodes_update: true,
      registered_nodes_delete: true,
      drafts_select: true,
      drafts_insert: true,
      drafts_update: true,
      drafts_delete: true,
      assets_select: true,
      assets_insert: true,
      assets_update: true,
      assets_delete: true,
      migration_ledger_select: false,
    }, 'migrator owns durable tables; runtime has required DML without schema creation or migration-ledger access');

    const site = siteJson() as { floors: Array<Record<string, unknown> & { id: string; visibility?: 'public' | 'console' }> };
    assert.ok(site.floors[0]);
    site.floors[0].visibility = 'console';
    const legacyBridgeFloor = site.floors[1];
    assert.ok(legacyBridgeFloor, 'the seeded site has an independent legacy floor for bridge coverage');
    legacyBridgeFloor.outline = postgresLegacyOutline();
    const legacyBridgeZones = legacyBridgeFloor.zones as Array<Record<string, unknown>>;
    legacyBridgeZones[0]!.polygon = [[-10, -10], [410, -10], [400, 300]];
    const legacyBridgeTables = legacyBridgeFloor.tables as Array<Record<string, unknown>>;
    Object.assign(legacyBridgeTables[0]!, { x: 0, y: 100, width: 40, height: 60, capacity: 1 });
    delete legacyBridgeTables[0]!.shape;
    delete legacyBridgeTables[0]!.seats;
    const seedNode = nodesJson().nodes.find((node) => typeof node.floor === 'string'
      && Array.isArray(node.owns) && node.owns.length > 0);
    assert.ok(seedNode, 'test configuration has a legacy placed sensor with table ownership');
    const seedRegistration = structuredClone(seedNode);
    seedRegistration.uid = registeredUids[0];
    const mutationCoordinator = new PostgresRegistryMutationCoordinator(runtime);
    const nodeRepository = new PostgresRegistryRepository(runtime, mutationCoordinator);
    const registration = new RegistrationImportExport(nodeRepository, mutationCoordinator);
    // A prior interrupted run in this disposable test database may have left
    // these fixed integration identities behind before its finally cleanup.
    await runtime.query('DELETE FROM public.node_table_owners WHERE uid = ANY($1::text[])', [registeredUids]);
    await runtime.query('DELETE FROM public.node_placements WHERE uid = ANY($1::text[])', [registeredUids]);
    await runtime.query('DELETE FROM public.registered_nodes WHERE uid = ANY($1::text[])', [registeredUids]);
    const seedPreview = await registration.preview(site, { nodes: [seedRegistration] });
    assert.equal(seedPreview.valid, true, JSON.stringify(seedPreview));
    const seedImport = await registration.import(site, { nodes: [seedRegistration] });
    assert.equal(seedImport.inserted, 1, JSON.stringify(seedImport));

    const placementsBefore = await runtime.query(
      'SELECT uid, floor_id, x, y, height_cm, yaw_deg, mirror FROM public.node_placements ORDER BY uid',
    );
    const ownersBefore = await runtime.query('SELECT table_id, uid FROM public.node_table_owners ORDER BY table_id');
    const registry = await registration.loadRegistry(site);
    const seedIds = new Set(registry.floors.map((floor) => floor.id));
    const published = new PostgresPublishedLocationRepository(runtime, seedIds, mutationCoordinator);

    await bootstrapPostgresLegacyLocations(runtime, registry, mutationCoordinator);
    await bootstrapPostgresLegacyLocations(runtime, registry, mutationCoordinator);
    assert.deepEqual(await runtime.query(
      'SELECT uid, floor_id, x, y, height_cm, yaw_deg, mirror FROM public.node_placements ORDER BY uid',
    ), placementsBefore, 'bootstrap leaves existing placements untouched');
    assert.deepEqual(await runtime.query('SELECT table_id, uid FROM public.node_table_owners ORDER BY table_id'), ownersBefore,
      'bootstrap leaves existing table ownership untouched');
    assert.equal((await runtime.query('SELECT count(*)::int AS count FROM public.location_published_revisions WHERE revision = 0'))[0].count, site.floors.length,
      'repeated bootstrap creates exactly one revision-zero document per seed floor');
    assert.equal((await published.getActive(registry.floors[0]!.id))?.activeRevision, 0);
    await assert.rejects(published.assertLocationIdAvailable(registry.floors[0]!.id), LocationConflictError);
    const consoleBaseline = await published.getActive(registry.floors[0]!.id);
    assert.equal(consoleBaseline?.history[0]?.document.visibility, 'console', 'revision zero preserves legacy console-only visibility');
    const beforeVisibilityEdit = await published.registryRevision();
    const attemptedPublicEdit = parseLocationDocument({
      ...postgresStorageTestDocument(registry.floors[0]!.id, 'PG-BASELINE-TABLE', 'PG-BASELINE-SEAT'), visibility: 'public',
    });
    const visibilityBase = consoleBaseline!.history[0]!;
    const visibilityCandidate = parseLocationCandidate(attemptedPublicEdit, {
      revision: 0, document: visibilityBase.document, legacySpatial: visibilityBase.legacySpatial,
    }, 0);
    await assert.rejects(mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: beforeVisibilityEdit, expectedPublishedRevision: 0,
      revision: {
        locationId: visibilityCandidate.document.locationId, revision: 1,
        createdBy: 'pg-operator', createdAt: 2, document: visibilityCandidate.document,
        legacySpatial: visibilityCandidate.legacySpatial,
      },
      assignments: visibilityCandidate.document.sensorAssignments,
    })), LocationConflictError);
    assert.equal(await published.registryRevision(), beforeVisibilityEdit, 'a rejected visibility edit leaves the global revision unchanged');
    assert.equal((await published.getActive(registry.floors[0]!.id))?.activeRevision, 0);

    const bridgeBaseline = await published.getActive(legacyBridgeFloor.id);
    assert.equal(bridgeBaseline?.activeRevision, 0);
    assert.deepEqual(bridgeBaseline?.history[0]?.document.outline, postgresLegacyOutline());
    assert.deepEqual(bridgeBaseline?.history[0]?.document.zones[0]?.polygon, [[-10, -10], [410, -10], [400, 300]]);
    assert.equal(bridgeBaseline?.history[0]?.document.tables[0]?.shape, undefined);
    assert.equal(bridgeBaseline?.history[0]?.document.tables[0]?.seats[0]?.x, -35,
      'PostgreSQL revision zero retains the legacy perimeter seat outside the floor');

    const drafts = new PostgresLocationDraftRepository(runtime);
    const locationSnapshots = new PostgresLocationRegistrySnapshotRepository(site, nodeRepository, published);
    const startLegacyEdit = new StartLocationEditDraftUseCase({
      drafts, snapshots: locationSnapshots, mutationCoordinator, now: () => 20,
      createDraftId: () => '00000000-0000-4000-8000-000000000071',
    });
    let legacyDraftUpdateTime = 21;
    const saveLegacyEdit = new SaveLocationDraftUseCase({ drafts, published, now: () => legacyDraftUpdateTime });
    const firstLegacyDraft = await startLegacyEdit.execute({
      creatorId: 'pg-legacy-editor', locationId: legacyBridgeFloor.id, expectedPublishedRevision: 0,
    });
    const firstLegacyCandidate = exposeLocationCandidate(firstLegacyDraft.draft.document, firstLegacyDraft.draft.legacySpatial) as { name: string };
    firstLegacyCandidate.name = 'PG legacy edit';
    const savedLegacyDraft = await saveLegacyEdit.execute({
      creatorId: 'pg-legacy-editor', draftId: firstLegacyDraft.draft.draftId,
      expectedDraftRevision: 1, document: firstLegacyCandidate,
    });
    assert.equal(savedLegacyDraft.draft.legacySpatial?.basePublishedRevision, 0);
    const bridgeRuntime = {
      prepare: () => 'prepared', refresh: (prepared: string) => prepared, activate: () => undefined, quarantine: () => undefined,
    };
    const bridgePublisher = new PublishLocationUseCase({
      drafts, published, snapshots: locationSnapshots, mutationCoordinator, runtime: bridgeRuntime, now: () => 22,
    });
    await bridgePublisher.execute({
      creatorId: 'pg-legacy-editor', draftId: firstLegacyDraft.draft.draftId,
      expectedDraftRevision: 2, expectedPublishedRevision: 0,
    });

    const secondLegacyDraft = await new StartLocationEditDraftUseCase({
      drafts, snapshots: locationSnapshots, mutationCoordinator, now: () => 23,
      createDraftId: () => '00000000-0000-4000-8000-000000000072',
    }).execute({ creatorId: 'pg-legacy-editor', locationId: legacyBridgeFloor.id, expectedPublishedRevision: 1 });
    assert.equal(secondLegacyDraft.draft.legacySpatial?.basePublishedRevision, 1);
    assert.deepEqual({ ...secondLegacyDraft.draft.legacySpatial!, basePublishedRevision: 0 }, firstLegacyDraft.draft.legacySpatial,
      'a later editor gets only the prior server-derived spatial values from the exact published base');
    const secondLegacyCandidate = exposeLocationCandidate(secondLegacyDraft.draft.document, secondLegacyDraft.draft.legacySpatial) as { name: string };
    secondLegacyCandidate.name = 'PG legacy edit twice';
    legacyDraftUpdateTime = 24;
    const savedSecondLegacyDraft = await saveLegacyEdit.execute({
      creatorId: 'pg-legacy-editor', draftId: secondLegacyDraft.draft.draftId,
      expectedDraftRevision: 1, document: secondLegacyCandidate,
    });
    assert.deepEqual({ ...savedSecondLegacyDraft.draft.legacySpatial!, basePublishedRevision: 0 }, firstLegacyDraft.draft.legacySpatial);
    await bridgePublisher.execute({
      creatorId: 'pg-legacy-editor', draftId: secondLegacyDraft.draft.draftId,
      expectedDraftRevision: 2, expectedPublishedRevision: 1,
    });

    const bridgeHistory = await published.listHistory(legacyBridgeFloor.id);
    assert.deepEqual(bridgeHistory.map((row) => row.revision), [0, 1, 2]);
    assert.deepEqual({ ...bridgeHistory[2]?.legacySpatial!, basePublishedRevision: 0 }, bridgeHistory[1]?.legacySpatial,
      'the second PostgreSQL edit keeps inherited geometry while advancing its base revision');
    const bridgedSnapshot = await locationSnapshots.readSnapshot();
    const emittedBridgeSnapshot = emittedLocationSnapshot(site, bridgedSnapshot, 'pg-legacy-bridge');
    assert.equal(emittedBridgeSnapshot.version, 2);
    assert.equal(emittedBridgeSnapshot.floors.find((floor) => floor.id === legacyBridgeFloor.id)?.outline.length, 257);
    assert.deepEqual(emittedBridgeSnapshot.floors.find((floor) => floor.id === legacyBridgeFloor.id)?.zones[0]?.polygon, [[-10, -10], [410, -10], [400, 300]]);
    assert.equal(emittedBridgeSnapshot.floors.find((floor) => floor.id === legacyBridgeFloor.id)?.tables[0]?.shape, undefined);
    assert.equal(emittedBridgeSnapshot.floors.find((floor) => floor.id === legacyBridgeFloor.id)?.tables[0]?.seats[0]?.x, -35);
    assert.equal(isSnapshot(emittedBridgeSnapshot), true, 'the PostgreSQL startup path restores the actual legacy v2 envelope');

    const reopenedRuntime = await openPostgres(config.runtime);
    try {
      const reopenedCoordinator = new PostgresRegistryMutationCoordinator(reopenedRuntime);
      const reopenedNodes = new PostgresRegistryRepository(reopenedRuntime, reopenedCoordinator);
      const reopenedPublished = new PostgresPublishedLocationRepository(reopenedRuntime, seedIds, reopenedCoordinator);
      const reopenedSnapshot = await new PostgresLocationRegistrySnapshotRepository(site, reopenedNodes, reopenedPublished).readSnapshot();
      const reopenedBridge = reopenedSnapshot.locations.find((row) => row.locationId === legacyBridgeFloor.id);
      assert.deepEqual(reopenedBridge?.history.at(-1)?.legacySpatial, bridgeHistory[2]?.legacySpatial);
      assert.equal(reopenedBridge?.history.at(-1)?.document.name, 'PG legacy edit twice');
      assert.equal(isSnapshot(emittedLocationSnapshot(site, reopenedSnapshot, 'pg-legacy-bridge-reopened')), true,
        'a fresh PostgreSQL connection reconstructs the exact spatial baseline and provenance');
    } finally { await closePostgres(reopenedRuntime); }

    const draftDocument = postgresStorageTestDocument(locationIds[0]!, 'PG-DRAFT-TABLE', 'PG-DRAFT-SEAT');
    const draft: LocationDraft = {
      draftId: '00000000-0000-4000-8000-000000000041', creatorId: 'pg-operator', locationId: draftDocument.locationId,
      draftRevision: 1, basePublishedRevision: null, createdAt: 1, updatedAt: 1, document: draftDocument,
    };
    await drafts.createDraft(draft);
    assert.equal(await drafts.getDraft('another-operator', draft.draftId), null);
    await assert.rejects(drafts.saveDraft('pg-operator', draft.draftId, 0, { document: draftDocument, legacySpatial: null }, 2), LocationConflictError);
    assert.equal((await drafts.getDraft('pg-operator', draft.draftId))?.draftRevision, 1);

    const assetStore = new PostgresLocationAssetStore(runtime, dataDirectory);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const asset = await assetStore.put('pg-operator', 'floor-plan', 'image/png', png, 2);
    assert.deepEqual((await assetStore.read('pg-operator', asset.assetId))?.bytes, png);
    assert.equal(await assetStore.read('another-operator', asset.assetId), null);
    const assetMetadata = new PostgresLocationAssetMetadataRepository(runtime);
    await assert.rejects(assetMetadata.saveAssetMetadata({ ...asset, assetId: randomUUID(), byteLength: 20 * 1024 * 1024 + 1 }), TypeError);
    await assert.rejects(runtime.query(
      `INSERT INTO public.location_assets (asset_id, creator_id, purpose, media_type, sha256, byte_length, created_at)
       VALUES ($1, 'pg-operator', 'floor-plan', 'image/png', $2, $3, 3)`,
      [randomUUID(), '0'.repeat(64), 20 * 1024 * 1024 + 1],
    ), (error: { driverError?: { code?: string } }) => error.driverError?.code === '23514');
    await assert.rejects(runtime.query(
      'UPDATE public.location_assets SET creator_id = $2 WHERE asset_id = $1', [asset.assetId, 'another-operator'],
    ), (error: { driverError?: { code?: string } }) => error.driverError?.code === '55000');
    await assert.rejects(runtime.query(
      'DELETE FROM public.location_assets WHERE asset_id = $1', [asset.assetId],
    ), (error: { driverError?: { code?: string } }) => error.driverError?.code === '55000');

    const managerAssetLocationId = createLocationId('pg-test', '00000000-0000-4000-8000-000000000099');
    const managerAInitial = await new CreateLocationDraftUseCase({
      edgeId: 'pg-test', drafts, published, snapshots: locationSnapshots, coordinator: mutationCoordinator,
      now: () => 10, createUuid: () => '00000000-0000-4000-8000-000000000099',
    }).execute({ creatorId: 'manager-a', name: 'Manager asset room', building: 'Test building', widthCm: 400, heightCm: 300 });
    assert.equal(managerAInitial.draft.locationId, managerAssetLocationId);
    let managerAssetClock = 11;
    const managerAssetSave = () => new SaveLocationDraftUseCase({
      drafts, published, assetMetadata, now: () => managerAssetClock++,
    });
    const managerAssetUpload = () => new UploadLocationAssetUseCase({
      drafts, assets: assetStore, saveDraft: managerAssetSave(), now: () => managerAssetClock++,
    });
    const managerAInitialDocument = structuredClone(managerAInitial.draft.document);
    managerAInitialDocument.zones = [{
      id: 'PG-MANAGER-ASSET-ZONE', name: 'Manager asset zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]],
    }];
    const managerAGeometry = await managerAssetSave().execute({
      creatorId: 'manager-a', draftId: managerAInitial.draft.draftId, expectedDraftRevision: 1,
      document: managerAInitialDocument,
    });
    const managerPlanBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x22]);
    const managerModelBytes = postgresTestGlb();
    const managerPlan = await managerAssetUpload().execute({
      creatorId: 'manager-a', draftId: managerAInitial.draft.draftId,
      expectedDraftRevision: managerAGeometry.draft.draftRevision, purpose: 'floor-plan', mediaType: 'image/png', bytes: managerPlanBytes,
    });
    const managerModel = await managerAssetUpload().execute({
      creatorId: 'manager-a', draftId: managerAInitial.draft.draftId,
      expectedDraftRevision: managerPlan.outcome.draft.draftRevision, purpose: 'model', mediaType: 'model/gltf-binary', bytes: managerModelBytes,
    });
    const managerUnrelatedPrivate = await assetStore.put('manager-a', 'floor-plan', 'image/png', managerPlanBytes, managerAssetClock++);
    const managerDistributorOwners: string[] = [];
    const managerAssetDistributor = {
      async acknowledge({ candidate }: { candidate: import('../src/modules/location-config/domain/location-records.js').PublishedLocationRevision }) {
        const provenance = candidate.assetProvenance?.modelAssetId;
        assert.ok(provenance && provenance.kind === 'upload');
        assert.ok(candidate.document.modelAssetId);
        const stored = await assetStore.read(provenance.ownerId, candidate.document.modelAssetId);
        assert.ok(stored, 'public transfer resolves bytes through the original asset owner');
        assert.deepEqual(stored.bytes, managerModelBytes);
        managerDistributorOwners.push(provenance.ownerId);
      },
    };
    const managerAssetRuntime = {
      prepare: () => 'prepared', refresh: (prepared: string) => prepared,
      activate: () => undefined, quarantine: () => undefined,
    };
    const managerPublisher = () => new PublishLocationUseCase({
      drafts, published, snapshots: locationSnapshots, mutationCoordinator, runtime: managerAssetRuntime,
      assetMetadata, modelDistributor: managerAssetDistributor, now: () => managerAssetClock++,
    });
    await managerPublisher().execute({
      creatorId: 'manager-a', draftId: managerAInitial.draft.draftId,
      expectedDraftRevision: managerModel.outcome.draft.draftRevision, expectedPublishedRevision: null,
    });
    const managerStartEdit = (creatorId: string, baseRevision: number, draftId: string) => new StartLocationEditDraftUseCase({
      drafts, snapshots: locationSnapshots, mutationCoordinator, now: () => managerAssetClock++, createDraftId: () => draftId,
    }).execute({ creatorId, locationId: managerAssetLocationId, expectedPublishedRevision: baseRevision });
    const managerAssetReader = (sourceDrafts: PostgresLocationDraftRepository, sourcePublished: PostgresPublishedLocationRepository,
      sourceMetadata: PostgresLocationAssetMetadataRepository, sourceAssets: PostgresLocationAssetStore) => new ReadLocationDraftAssetUseCase({
      drafts: sourceDrafts, published: sourcePublished, metadata: sourceMetadata, assets: sourceAssets,
    });
    const assertManagerAssetPreviews = async (creatorId: string, draftId: string) => {
      const reader = managerAssetReader(drafts, published, assetMetadata, assetStore);
      const planPreview = await reader.execute({ creatorId, draftId, assetId: managerPlan.metadata.assetId });
      const modelPreview = await reader.execute({ creatorId, draftId, assetId: managerModel.metadata.assetId });
      assert.deepEqual(planPreview.bytes, managerPlanBytes);
      assert.deepEqual(modelPreview.bytes, managerModelBytes);
      await assert.rejects(reader.execute({ creatorId, draftId, assetId: managerUnrelatedPrivate.assetId }), /asset/i,
        'another manager cannot preview an unrelated private upload from the base creator');
    };

    const managerBDraft = await managerStartEdit('manager-b', 1, '00000000-0000-4000-8000-000000000073');
    assert.equal(managerBDraft.draft.assetProvenance?.planAssetId?.kind, 'upload');
    assert.equal(managerBDraft.draft.assetProvenance?.planAssetId?.kind === 'upload'
      ? managerBDraft.draft.assetProvenance.planAssetId.ownerId : undefined, 'manager-a');
    assert.equal(managerBDraft.draft.assetProvenance?.modelAssetId?.kind === 'upload'
      ? managerBDraft.draft.assetProvenance.modelAssetId.ownerId : undefined, 'manager-a');
    await assertManagerAssetPreviews('manager-b', managerBDraft.draft.draftId);
    const managerBCandidate = exposeLocationCandidate(managerBDraft.draft.document, managerBDraft.draft.legacySpatial) as { name: string };
    managerBCandidate.name = 'Edited by manager B';
    const managerBSaved = await managerAssetSave().execute({
      creatorId: 'manager-b', draftId: managerBDraft.draft.draftId, expectedDraftRevision: 1, document: managerBCandidate,
    });
    await managerPublisher().execute({
      creatorId: 'manager-b', draftId: managerBDraft.draft.draftId,
      expectedDraftRevision: managerBSaved.draft.draftRevision, expectedPublishedRevision: 1,
    });

    const managerCDraft = await managerStartEdit('manager-c', 2, '00000000-0000-4000-8000-000000000074');
    assert.equal(managerCDraft.draft.assetProvenance?.planAssetId?.kind === 'upload'
      ? managerCDraft.draft.assetProvenance.planAssetId.ownerId : undefined, 'manager-a');
    assert.equal(managerCDraft.draft.assetProvenance?.modelAssetId?.kind === 'upload'
      ? managerCDraft.draft.assetProvenance.modelAssetId.ownerId : undefined, 'manager-a');
    await assertManagerAssetPreviews('manager-c', managerCDraft.draft.draftId);
    const managerCCandidate = exposeLocationCandidate(managerCDraft.draft.document, managerCDraft.draft.legacySpatial) as { name: string };
    managerCCandidate.name = 'Edited by manager C';
    const managerCSaved = await managerAssetSave().execute({
      creatorId: 'manager-c', draftId: managerCDraft.draft.draftId, expectedDraftRevision: 1, document: managerCCandidate,
    });
    await managerPublisher().execute({
      creatorId: 'manager-c', draftId: managerCDraft.draft.draftId,
      expectedDraftRevision: managerCSaved.draft.draftRevision, expectedPublishedRevision: 2,
    });

    const managerAssetHistory = await published.listHistory(managerAssetLocationId);
    assert.deepEqual(managerAssetHistory.map((revision) => revision.revision), [1, 2, 3]);
    for (const revision of managerAssetHistory) {
      assert.equal(revision.assetProvenance?.planAssetId?.kind === 'upload'
        ? revision.assetProvenance.planAssetId.ownerId : undefined, 'manager-a');
      assert.equal(revision.assetProvenance?.modelAssetId?.kind === 'upload'
        ? revision.assetProvenance.modelAssetId.ownerId : undefined, 'manager-a');
    }
    assert.deepEqual(managerDistributorOwners, ['manager-a', 'manager-a', 'manager-a']);
    assert.equal(await assetStore.read('manager-b', managerModel.metadata.assetId), null);
    assert.equal(await assetStore.read('manager-c', managerPlan.metadata.assetId), null);

    const managerReopenedRuntime = await openPostgres(config.runtime);
    try {
      const managerReopenedCoordinator = new PostgresRegistryMutationCoordinator(managerReopenedRuntime);
      const managerReopenedPublished = new PostgresPublishedLocationRepository(managerReopenedRuntime, seedIds, managerReopenedCoordinator);
      const managerReopenedDrafts = new PostgresLocationDraftRepository(managerReopenedRuntime);
      const managerReopenedAssets = new PostgresLocationAssetStore(managerReopenedRuntime, dataDirectory);
      const managerReopenedMetadata = new PostgresLocationAssetMetadataRepository(managerReopenedRuntime);
      const reader = managerAssetReader(managerReopenedDrafts, managerReopenedPublished, managerReopenedMetadata, managerReopenedAssets);
      const reopenedPlan = await reader.execute({ creatorId: 'manager-c', draftId: managerCDraft.draft.draftId, assetId: managerPlan.metadata.assetId });
      const reopenedModel = await reader.execute({ creatorId: 'manager-c', draftId: managerCDraft.draft.draftId, assetId: managerModel.metadata.assetId });
      assert.deepEqual(reopenedPlan.bytes, managerPlanBytes);
      assert.deepEqual(reopenedModel.bytes, managerModelBytes);
      await assert.rejects(reader.execute({ creatorId: 'manager-c', draftId: managerCDraft.draft.draftId, assetId: managerUnrelatedPrivate.assetId }), /asset/i);
      const reopenedHistory = await managerReopenedPublished.listHistory(managerAssetLocationId);
      assert.deepEqual(reopenedHistory.map((revision) => revision.revision), [1, 2, 3]);
      for (const revision of reopenedHistory) {
        assert.equal(revision.assetProvenance?.planAssetId?.kind === 'upload'
          ? revision.assetProvenance.planAssetId.ownerId : undefined, 'manager-a');
        assert.equal(revision.assetProvenance?.modelAssetId?.kind === 'upload'
          ? revision.assetProvenance.modelAssetId.ownerId : undefined, 'manager-a');
      }
    } finally { await closePostgres(managerReopenedRuntime); }

    await mutationCoordinator.withMutationLock(() => nodeRepository.importNodes([{
      uid: registeredUids[1]!, label: 'Unplaced for location publication', floorId: null, pose: null,
      owns: [], simulated: false, rgb: false, detector: 'node',
    }]));
    const document = postgresStorageTestDocument(locationIds[1]!, 'PG-LOCATION-TABLE', 'PG-LOCATION-SEAT', registeredUids[1]);
    const revision = { locationId: document.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 3, document };
    const committed = await mutationCoordinator.withMutationLock(async () => published.commitWithinMutation({
      expectedRegistryRevision: await published.registryRevision(), expectedPublishedRevision: null,
      revision, assignments: document.sensorAssignments,
    }));
    assert.equal(committed.activeRevision, 1);
    assert.equal(committed.registryRevision, await published.registryRevision());
    assert.deepEqual(await runtime.query('SELECT floor_id FROM public.node_placements WHERE uid = $1', [registeredUids[1]]), [{ floor_id: document.locationId }]);
    assert.deepEqual(await runtime.query('SELECT table_id FROM public.node_table_owners WHERE uid = $1', [registeredUids[1]]), [{ table_id: 'PG-LOCATION-TABLE' }]);
    assert.equal((await published.getActive(document.locationId))?.activeRevision, 1);
    assert.equal((await published.listActive()).find((state) => state.locationId === document.locationId)?.activeRevision, 1);
    await assert.rejects(runtime.query(
      'UPDATE public.location_published_revisions SET created_by = $3 WHERE location_id = $1 AND revision = $2',
      [document.locationId, 1, 'mutated'],
    ), (error: { driverError?: { code?: string } }) => error.driverError?.code === '55000');

    // Leave index 4 reserved for the later lost-ack registration case.
    const batchUids = registeredUids.slice(5, 17);
    await mutationCoordinator.withMutationLock(() => nodeRepository.importNodes(batchUids.map((uid, index) => ({
      uid, label: `Batch sensor ${index}`, floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node',
    }))));
    const batchLocationId = createLocationId('pg-test', '00000000-0000-4000-8000-000000000040');
    const batchDocument = postgresBatchAssignmentDocument(batchLocationId, batchUids);
    const duplicateOwnerLocationId = createLocationId('pg-test', '00000000-0000-4000-8000-000000000041');
    const duplicateTableId = batchDocument.tables[0]!.id;
    const duplicateOwnerDocument = parseLocationDocument({
      ...batchDocument,
      locationId: duplicateOwnerLocationId,
      sensorAssignments: batchDocument.sensorAssignments.slice(0, 2).map((assignment) => ({ ...assignment, owns: [duplicateTableId] })),
    });
    const batchBaseRevision = await published.registryRevision();
    await assert.rejects(mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: batchBaseRevision, expectedPublishedRevision: null,
      revision: { locationId: duplicateOwnerLocationId, revision: 1, createdBy: 'pg-operator', createdAt: 30, document: duplicateOwnerDocument },
      assignments: duplicateOwnerDocument.sensorAssignments,
    })), LocationStorageUnavailableError, 'duplicate table ownership remains a constraint failure that rolls the transaction back');
    assert.equal(await published.registryRevision(), batchBaseRevision);
    assert.equal(await published.getActive(duplicateOwnerLocationId), null);
    assert.deepEqual(await runtime.query('SELECT uid FROM public.node_placements WHERE uid = ANY($1::text[])', [batchUids]), [],
      'the batched placement upsert rolls back when the owner batch violates the unique table constraint');

    const batchCommitted = await mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: batchBaseRevision, expectedPublishedRevision: null,
      revision: { locationId: batchLocationId, revision: 1, createdBy: 'pg-operator', createdAt: 31, document: batchDocument },
      assignments: batchDocument.sensorAssignments,
    }));
    assert.equal(batchCommitted.activeRevision, 1);
    assert.deepEqual(await runtime.query(
      'SELECT uid FROM public.node_placements WHERE floor_id = $1 ORDER BY uid', [batchLocationId],
    ), batchUids.map((uid) => ({ uid })).sort((left, right) => left.uid.localeCompare(right.uid)),
    'one publication places all assigned nodes in the same transaction');
    assert.equal((await runtime.query(
      'SELECT count(*)::int AS count FROM public.node_table_owners WHERE uid = ANY($1::text[])', [batchUids],
    ))[0].count, 36, 'all owned table rows are written by the batched owner statement');

    const retainedBatchUids = batchUids.slice(6);
    const reducedBatchDocument = parseLocationDocument({
      ...batchDocument,
      sensorAssignments: batchDocument.sensorAssignments.slice(6),
    });
    const afterBatchRevision = await published.registryRevision();
    await mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: afterBatchRevision, expectedPublishedRevision: 1,
      revision: { locationId: batchLocationId, revision: 2, createdBy: 'pg-operator', createdAt: 32, document: reducedBatchDocument },
      assignments: reducedBatchDocument.sensorAssignments,
    }));
    assert.deepEqual(await runtime.query(
      'SELECT uid FROM public.node_placements WHERE floor_id = $1 ORDER BY uid', [batchLocationId],
    ), retainedBatchUids.map((uid) => ({ uid })).sort((left, right) => left.uid.localeCompare(right.uid)),
    'removed same-location assignments are cleared while retained assignments remain placed');
    assert.equal((await runtime.query(
      'SELECT count(*)::int AS count FROM public.node_table_owners WHERE uid = ANY($1::text[])', [batchUids],
    ))[0].count, 18, 'owners of retained assignments are restored and removed assignments are cleared');

    const afterFirstPublication = await published.registryRevision();
    const missingSensorDocument = postgresStorageTestDocument(locationIds[2]!, 'PG-ROLLBACK-TABLE', 'PG-ROLLBACK-SEAT', 'aa:bb:cc:dd:ff:99');
    await assert.rejects(mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: afterFirstPublication, expectedPublishedRevision: null,
      revision: { locationId: missingSensorDocument.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 4, document: missingSensorDocument },
      assignments: missingSensorDocument.sensorAssignments,
    })), LocationConflictError);
    assert.equal(await published.registryRevision(), afterFirstPublication, 'failed assignment rolls back the global revision');
    assert.equal(await published.getActive(missingSensorDocument.locationId), null, 'failed assignment creates no revision or active pointer');

    const originalAssignment = document.sensorAssignments[0]!;
    const rollbackDocument = parseLocationDocument({
      ...document,
      sensorAssignments: [
        { ...originalAssignment, pose: { ...originalAssignment.pose, x: originalAssignment.pose.x + 20 }, owns: [] },
        {
          uid: 'aa:bb:cc:dd:ff:99',
          pose: { x: 100, y: 100, heightCm: 350, yawDeg: 0, mirror: false },
          owns: [],
        },
      ],
    });
    const placementBeforeRollback = await runtime.query(
      'SELECT floor_id, x, y, height_cm, yaw_deg, mirror FROM public.node_placements WHERE uid = $1', [registeredUids[1]],
    );
    const ownershipBeforeRollback = await runtime.query(
      'SELECT table_id FROM public.node_table_owners WHERE uid = $1 ORDER BY table_id', [registeredUids[1]],
    );
    await assert.rejects(mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: afterFirstPublication, expectedPublishedRevision: 1,
      revision: { locationId: document.locationId, revision: 2, createdBy: 'pg-operator', createdAt: 9, document: rollbackDocument },
      assignments: rollbackDocument.sensorAssignments,
    })), LocationConflictError);
    assert.equal(await published.registryRevision(), afterFirstPublication, 'a later assignment failure rolls back the global revision');
    assert.equal((await published.getActive(document.locationId))?.activeRevision, 1, 'a later assignment failure leaves the active pointer unchanged');
    assert.deepEqual(await runtime.query(
      'SELECT floor_id, x, y, height_cm, yaw_deg, mirror FROM public.node_placements WHERE uid = $1', [registeredUids[1]],
    ), placementBeforeRollback, 'earlier placement writes roll back when a later assignment fails');
    assert.deepEqual(await runtime.query(
      'SELECT table_id FROM public.node_table_owners WHERE uid = $1 ORDER BY table_id', [registeredUids[1]],
    ), ownershipBeforeRollback, 'earlier owner deletions roll back when a later assignment fails');

    const conflictingGeometry = postgresStorageTestDocument(locationIds[2]!, 'PG-OTHER-TABLE', 'PG-LOCATION-SEAT');
    await assert.rejects(mutationCoordinator.withMutationLock(() => published.commitWithinMutation({
      expectedRegistryRevision: afterFirstPublication, expectedPublishedRevision: null,
      revision: { locationId: conflictingGeometry.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 5, document: conflictingGeometry },
      assignments: [],
    })), LocationConflictError);
    assert.equal(await published.registryRevision(), afterFirstPublication, 'global seat-ID collision leaves the global revision unchanged');

    const importAndPublishStarted = await published.registryRevision();
    let imported!: () => void;
    let release!: () => void;
    const importReady = new Promise<void>((resolve) => { imported = resolve; });
    const holdImport = new Promise<void>((resolve) => { release = resolve; });
    const serializedImport = mutationCoordinator.withMutationLock(async () => {
      await nodeRepository.importNodes([{
        uid: registeredUids[2]!, label: 'Imported while publishing', floorId: null, pose: null,
        owns: [], simulated: false, rgb: false, detector: 'node',
      }]);
      imported();
      await holdImport;
    });
    await importReady;
    const serializedPublication = mutationCoordinator.withMutationLock(async () => {
      const nextDocument = postgresStorageTestDocument(locationIds[3]!, 'PG-RACE-TABLE', 'PG-RACE-SEAT', registeredUids[2]);
      return published.commitWithinMutation({
        expectedRegistryRevision: await published.registryRevision(), expectedPublishedRevision: null,
        revision: { locationId: nextDocument.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 6, document: nextDocument },
        assignments: nextDocument.sensorAssignments,
      });
    });
    release();
    await Promise.all([serializedImport, serializedPublication]);
    assert.equal(await published.registryRevision(), importAndPublishStarted + 2);
    assert.equal((await published.getActive(locationIds[3]!))?.activeRevision, 1);
    assert.deepEqual(await runtime.query('SELECT floor_id FROM public.node_placements WHERE uid = $1', [registeredUids[2]]), [{ floor_id: locationIds[3] }]);

    const importAckRevision = await published.registryRevision();
    const importAckUid = 'aa:bb:cc:dd:ff:15';
    const importAckRepository = new PostgresRegistryRepository(runtime, mutationCoordinator, async (work) => {
      await runtime.transaction(work);
      throw new Error('simulated lost registration import COMMIT acknowledgement');
    });
    const importAckOutcome = await mutationCoordinator.withMutationLock(() => importAckRepository.importNodes([{
      uid: importAckUid, label: 'Import with lost acknowledgement', floorId: null, pose: null,
      owns: [], simulated: false, rgb: false, detector: 'node',
    }]));
    assert.deepEqual(importAckOutcome, { inserted: 1, unchanged: 0 }, 'an exact imported candidate is reconciled as committed');
    assert.equal(await published.registryRevision(), importAckRevision + 1);
    assert.equal((await new PostgresRegistryRepository(runtime, mutationCoordinator).listNodes()).find((node) => node.uid === importAckUid)?.label,
      'Import with lost acknowledgement');

    const approvalRequestId = '00000000-0000-4000-8000-000000000036';
    const approvedUid = registeredUids[3]!;
    const approvalSnapshots = new PostgresLocationRegistrySnapshotRepository(site, nodeRepository, published);
    const approvalSnapshot = await mutationCoordinator.withMutationLock(() => approvalSnapshots.readSnapshot());
    const approvalNodes = { nodes: approvalSnapshot.nodes.map((node) => ({
      uid: node.uid, label: node.label,
      ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
      owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
    })) };
    const approvalDocuments = approvalSnapshot.locations.flatMap((location) => {
      if (location.activeRevision === 0) return [];
      const active = location.history.find((revision) => revision.revision === location.activeRevision);
      return active ? [parseLocationDocument(active.document)] : [];
    });
    const approvalRegistry = buildRegistryFromLocationDocuments(site, approvalNodes, approvalDocuments);
    approvalEdgeRuntime = createEdgeRuntime(postgresTestEdgeConfig(join(dataDirectory, 'approval-runtime')), approvalRegistry);
    let loseApprovalAcknowledgement = false;
    const approvalRepository = new PostgresProvisioningRepository(runtime, async (work) => {
      const result = await runtime.transaction(work);
      if (loseApprovalAcknowledgement) {
        loseApprovalAcknowledgement = false;
        throw new Error('simulated lost approval COMMIT acknowledgement');
      }
      return result;
    });
    const provisioning = new DatabaseProvisioningService(approvalRepository, approvalRegistry, {
      token: 'integration-provisioning-token-32chars',
      requestId: () => approvalRequestId,
      mutationCoordinator,
      registryProvider: () => approvalEdgeRuntime!.captureGeneration().reg,
      prepareRegistryAddition: (node) => approvalEdgeRuntime!.prepareNodeRegistration(node),
      quarantineRegistry: (reason) => approvalEdgeRuntime!.quarantine(reason),
    });
    const pending = await provisioning.request({ uid: approvedUid, label: 'Approved during publication' }, 'integration-test');
    assert.equal(pending.status, 'pending');
    if (pending.status !== 'pending') throw new Error('expected a pending provisioning request');
    const approvalAndPublicationStarted = await published.registryRevision();
    const approvalDocument = postgresStorageTestDocument(locationIds[4]!, 'PG-APPROVAL-TABLE', 'PG-APPROVAL-SEAT');
    const approvalDraft: LocationDraft = {
      draftId: randomUUID(), creatorId: 'pg-operator', locationId: approvalDocument.locationId,
      draftRevision: 1, basePublishedRevision: null, createdAt: 7, updatedAt: 7, document: approvalDocument,
    };
    await drafts.createDraft(approvalDraft);
    const publication = new PublishLocationUseCase({
      drafts, published, snapshots: approvalSnapshots, mutationCoordinator,
      runtime: new EdgeLocationPublicationRuntime(approvalEdgeRuntime, site),
    });
    loseApprovalAcknowledgement = true;
    const approvalPromise = provisioning.approve(pending.request.id, 'integration-operator');
    const publicationPromise = publication.execute({
      creatorId: approvalDraft.creatorId, draftId: approvalDraft.draftId,
      expectedDraftRevision: approvalDraft.draftRevision, expectedPublishedRevision: null,
    });
    const [approvedNode, approvalPublication] = await Promise.all([approvalPromise, publicationPromise]);
    assert.equal(loseApprovalAcknowledgement, false, 'the approval COMMIT acknowledgement was deliberately lost and reconciled');
    assert.equal(approvedNode.uid, approvedUid);
    assert.ok(approvalPublication.registryRevision === approvalAndPublicationStarted + 1
      || approvalPublication.registryRevision === approvalAndPublicationStarted + 2,
    'publication returns the revision at its own point in the serialized order');
    assert.equal(await published.registryRevision(), approvalAndPublicationStarted + 2);
    assert.equal((await published.getActive(locationIds[4]!))?.activeRevision, 1,
      'the publication survives concurrent node approval');
    assert.deepEqual(await runtime.query('SELECT label FROM public.registered_nodes WHERE uid = $1', [approvedUid]), [
      { label: 'Approved during publication' },
    ], 'the approved identity survives concurrent location publication');
    assert.equal(approvalEdgeRuntime.captureGeneration().reg.nodes.get(approvedUid)?.label, 'Approved during publication',
      'the exact reconciled approval activates in the live generation');
    assert.ok(approvalEdgeRuntime.captureGeneration().reg.floors.some((floor) => floor.id === locationIds[4]),
      'the concurrently published location activates in the same runtime generation');
    assert.equal((await runtime.query('SELECT status, registered_uid FROM public.provisioning_requests WHERE id = $1', [approvalRequestId]))[0]?.status,
      'approved', 'provisioning approval commits with the registration');

    const assignedApprovedDocument = postgresStorageTestDocument(locationIds[4]!, 'PG-APPROVAL-TABLE-2', 'PG-APPROVAL-SEAT-2', approvedUid);
    const assignedDraft: LocationDraft = {
      draftId: randomUUID(), creatorId: 'pg-operator', locationId: assignedApprovedDocument.locationId,
      draftRevision: 1, basePublishedRevision: 1, createdAt: 8, updatedAt: 8, document: assignedApprovedDocument,
    };
    await drafts.createDraft(assignedDraft);
    const assignedApproved = await publication.execute({
      creatorId: assignedDraft.creatorId, draftId: assignedDraft.draftId,
      expectedDraftRevision: assignedDraft.draftRevision, expectedPublishedRevision: 1,
    });
    assert.equal(assignedApproved.publishedRevision, 2, 'a node approved during the race can be assigned by a later publication');
    assert.deepEqual(await runtime.query('SELECT floor_id FROM public.node_placements WHERE uid = $1', [approvedUid]), [
      { floor_id: locationIds[4] },
    ]);
    assert.equal(approvalEdgeRuntime.captureGeneration().reg.nodes.get(approvedUid)?.floorId, locationIds[4],
      'the subsequent sensor placement activates with the edited location');
    assert.ok(approvalEdgeRuntime.captureGeneration().reg.tables.has('PG-APPROVAL-TABLE-2'));

    const restartedRuntime = await openPostgres(config.runtime);
    try {
      const restartedCoordinator = new PostgresRegistryMutationCoordinator(restartedRuntime);
      const restartedPublished = new PostgresPublishedLocationRepository(restartedRuntime, seedIds, restartedCoordinator);
      const restartedDrafts = new PostgresLocationDraftRepository(restartedRuntime);
      const restartedAssets = new PostgresLocationAssetStore(restartedRuntime, dataDirectory);
      const reopenedHistory = await restartedPublished.listHistory(approvalDocument.locationId);
      assert.deepEqual(reopenedHistory.map((row) => row.revision), [1, 2]);
      assert.equal((await restartedPublished.getActive(approvalDocument.locationId))?.activeRevision, 2);
      assert.equal((await restartedDrafts.getDraft('pg-operator', draft.draftId))?.draftRevision, 1);
      assert.deepEqual((await restartedAssets.read('pg-operator', asset.assetId))?.bytes, png);
      assert.equal((await restartedAssets.read('pg-operator', asset.assetId))?.metadata.sha256, asset.sha256);
      assert.deepEqual((await new PostgresRegistryRepository(restartedRuntime).listNodes()).find((node) => node.uid === approvedUid)?.floorId,
        locationIds[4], 'the registry placement survives a fresh database connection');
    } finally { await closePostgres(restartedRuntime); }

    const lostAckRevision = await published.registryRevision();
    const lostAckDocument = postgresStorageTestDocument(locationIds[5]!, 'PG-ACK-TABLE', 'PG-ACK-SEAT');
    const lostAckRepository = new PostgresPublishedLocationRepository(runtime, seedIds, mutationCoordinator, async (work) => {
      await runtime.transaction(work);
      throw new Error('simulated lost COMMIT acknowledgement');
    });
    const reconciled = await mutationCoordinator.withMutationLock(() => lostAckRepository.commitWithinMutation({
      expectedRegistryRevision: lostAckRevision, expectedPublishedRevision: null,
      revision: { locationId: lostAckDocument.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 10, document: lostAckDocument },
      assignments: [],
    }));
    assert.equal(reconciled.acknowledgement, 'reconciled');
    assert.equal(reconciled.registryRevision, lostAckRevision + 1);
    assert.equal((await published.getActive(lostAckDocument.locationId))?.activeRevision, 1,
      'exact candidate readback classifies a lost acknowledgement as committed');

    const beforeNoCommit = await published.registryRevision();
    const noCommitDocument = postgresStorageTestDocument(locationIds[6]!, 'PG-NO-ACK-TABLE', 'PG-NO-ACK-SEAT');
    const noCommitRepository = new PostgresPublishedLocationRepository(runtime, seedIds, mutationCoordinator, async () => {
      throw new Error('simulated failure before COMMIT');
    });
    await assert.rejects(mutationCoordinator.withMutationLock(() => noCommitRepository.commitWithinMutation({
      expectedRegistryRevision: beforeNoCommit, expectedPublishedRevision: null,
      revision: { locationId: noCommitDocument.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 11, document: noCommitDocument },
      assignments: [],
    })), /Location storage is unavailable/);
    assert.equal(await published.registryRevision(), beforeNoCommit, 'unchanged base state is classified as not committed');
    assert.equal(await published.getActive(noCommitDocument.locationId), null);

    const beforeUnknown = await published.registryRevision();
    const unknownDocument = postgresStorageTestDocument(locationIds[7]!, 'PG-UNKNOWN-TABLE', 'PG-UNKNOWN-SEAT');
    const unreadableSource = new Proxy(runtime, {
      get(target, property) {
        if (property === 'manager') return { query: async () => { throw new Error('simulated readback outage'); } };
        if (property === 'query') return async () => { throw new Error('simulated readback outage'); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof runtime;
    const quarantinedCoordinator = new PostgresRegistryMutationCoordinator(runtime);
    const unknownRepository = new PostgresPublishedLocationRepository(unreadableSource, seedIds, quarantinedCoordinator, async (work) => {
      await runtime.transaction(work);
      throw new Error('simulated lost COMMIT acknowledgement');
    });
    await assert.rejects(quarantinedCoordinator.withMutationLock(() => unknownRepository.commitWithinMutation({
      expectedRegistryRevision: beforeUnknown, expectedPublishedRevision: null,
      revision: { locationId: unknownDocument.locationId, revision: 1, createdBy: 'pg-operator', createdAt: 12, document: unknownDocument },
      assignments: [],
    })), (error: { name?: string }) => error.name === 'UnknownRegistryCommitOutcomeError');
    assert.throws(() => quarantinedCoordinator.assertHealthy(), (error: { name?: string }) => error.name === 'RegistryMutationQuarantinedError');
    await assert.rejects(quarantinedCoordinator.withMutationLock(async () => undefined), (error: { name?: string }) => error.name === 'RegistryMutationQuarantinedError');

    const apiApp = express();
    apiApp.use('/api', createLocationRouter({
      auth: {
        principalOf: (request) => request.headers.cookie === 'tm_algo=pg-owner'
          ? principal('pg-route-owner', 'operator')
          : request.headers.cookie === 'tm_algo=pg-other'
            ? principal('pg-route-other', 'operator') : null,
      },
      edgeId: 'pg-route-test', siteSeed: site, drafts, published, snapshots: locationSnapshots,
      assets: assetStore, assetMetadata: new PostgresLocationAssetMetadataRepository(runtime), coordinator: mutationCoordinator,
      runtime: {
        prepare: () => ({}), refresh: (prepared: object) => prepared,
        activate: () => undefined, quarantine: () => undefined,
      } as unknown as LocationRouterDependencies['runtime'],
      suggestCoverage: computeLocationCoverageSuggestions, now: () => 40,
    }));
    const apiServer = createHttpServer(apiApp);
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    const apiOwnerHeaders = { cookie: 'tm_algo=pg-owner', origin: apiBase, 'x-tm-algo': '1', 'content-type': 'application/json' };
    try {
      const createdDraftResponse = await fetch(`${apiBase}/api/locations/drafts`, {
        method: 'POST', headers: apiOwnerHeaders,
        body: JSON.stringify({ name: 'PostgreSQL route location', building: 'Test building', widthCm: 400, heightCm: 300 }),
      });
      assert.equal(createdDraftResponse.status, 201);
      const createdDraft = (await createdDraftResponse.json() as { data: { draftId: string; locationId: string; draftRevision: number } }).data;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const uploadResponse = await fetch(`${apiBase}/api/locations/drafts/${createdDraft.draftId}/assets/floor-plan`, {
        method: 'PUT', headers: { cookie: 'tm_algo=pg-owner', origin: apiBase, 'x-tm-algo': '1', 'content-type': 'image/png', 'if-match': String(createdDraft.draftRevision) },
        body: png,
      });
      assert.equal(uploadResponse.status, 200);
      const uploaded = (await uploadResponse.json() as { data: { assetId: string; draftRevision: number } }).data;
      const foreignDraftResponse = await fetch(`${apiBase}/api/locations/drafts/${createdDraft.draftId}`, { headers: { cookie: 'tm_algo=pg-other' } });
      assert.equal(foreignDraftResponse.status, 404, 'PostgreSQL route reads remain creator-private');
      const previewResponse = await fetch(`${apiBase}/api/locations/drafts/${createdDraft.draftId}/assets/${uploaded.assetId}`, { headers: { cookie: 'tm_algo=pg-owner' } });
      assert.equal(previewResponse.status, 200);
      assert.deepEqual(Buffer.from(await previewResponse.arrayBuffer()), png, 'preview uses the PostgreSQL metadata plus durable owner-scoped bytes');
      const publicationResponse = await fetch(`${apiBase}/api/locations/drafts/${createdDraft.draftId}/publications`, {
        method: 'POST', headers: apiOwnerHeaders,
        body: JSON.stringify({ expectedDraftRevision: uploaded.draftRevision, expectedPublishedRevision: null }),
      });
      assert.equal(publicationResponse.status, 200);
      assert.equal((await published.getActive(createdDraft.locationId))?.activeRevision, 1,
        'the HTTP publication route commits its draft through PostgreSQL and survives repository readback');
      const persistedApiDraft = await drafts.getDraft('pg-route-owner', createdDraft.draftId);
      assert.equal(persistedApiDraft?.assetProvenance?.planAssetId?.kind, 'upload');
      assert.equal(persistedApiDraft?.assetProvenance?.planAssetId?.ownerId, 'pg-route-owner');
    } finally {
      apiServer.closeAllConnections();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  } finally {
    if (approvalEdgeRuntime) await approvalEdgeRuntime.stop().catch(() => undefined);
    if (runtime.isInitialized) {
      await runtime.query('DELETE FROM public.node_table_owners WHERE uid = ANY($1::text[])', [registeredUids]).catch(() => undefined);
      await runtime.query('DELETE FROM public.node_placements WHERE uid = ANY($1::text[])', [registeredUids]).catch(() => undefined);
      await runtime.query('DELETE FROM public.provisioning_audit_events WHERE subject_id = $1', ['00000000-0000-4000-8000-000000000036']).catch(() => undefined);
      await runtime.query('DELETE FROM public.provisioning_requests WHERE id = $1', ['00000000-0000-4000-8000-000000000036']).catch(() => undefined);
      await runtime.query('DELETE FROM public.registered_nodes WHERE uid = ANY($1::text[])', [registeredUids]).catch(() => undefined);
    }
    await closePostgres(runtime);
    while (applied > 0 && migrator.isInitialized) {
      await migrator.undoLastMigration({ transaction: 'all' }).catch(() => undefined);
      applied -= 1;
    }
    await closePostgres(migrator);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('registration detector migration preserves legacy rows and enforces detector values', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const detectorMigration = join(testDirectory, '../src/infrastructure/postgres/migrations/1791590400000-AddRegistrationDetector.js');
  const baseline = createPostgresDataSource(config.migrator, migrations.slice(0, 2));
  const upgraded = createPostgresDataSource(config.migrator, [...migrations.slice(0, 2), detectorMigration]);
  const uid = 'aa:bb:cc:00:00:01';
  let applied = 0;
  try {
    await baseline.initialize();
    applied += (await baseline.runMigrations({ transaction: 'all' })).length;
    assert.equal(applied, 2, 'a disposable legacy registration schema is required');
    await baseline.query('INSERT INTO public.registered_nodes (uid, label) VALUES ($1, $2)', [uid, 'Legacy detector node']);
    await closePostgres(baseline);
    await upgraded.initialize();
    const added = (await upgraded.runMigrations({ transaction: 'all' })).length;
    applied += added;
    assert.equal(added, 1);
    assert.deepEqual((await upgraded.query('SELECT label, detector FROM public.registered_nodes WHERE uid = $1', [uid]))[0],
      { label: 'Legacy detector node', detector: 'node' });
    await upgraded.query('UPDATE public.registered_nodes SET detector = $2 WHERE uid = $1', [uid, 'edge']);
    await assert.rejects(upgraded.query('UPDATE public.registered_nodes SET detector = $2 WHERE uid = $1', [uid, 'invalid']),
      /check constraint/i);
    await upgraded.undoLastMigration({ transaction: 'all' });
    applied -= 1;
    assert.equal((await upgraded.query('SELECT label FROM public.registered_nodes WHERE uid = $1', [uid]))[0].label,
      'Legacy detector node', 'schema rollback retains the registration');
    applied += (await upgraded.runMigrations({ transaction: 'all' })).length;
    assert.equal((await upgraded.query('SELECT detector FROM public.registered_nodes WHERE uid = $1', [uid]))[0].detector, 'node');
  } finally {
    const cleanup = upgraded.isInitialized ? upgraded : baseline;
    while (applied > 0 && cleanup.isInitialized) {
      await cleanup.undoLastMigration({ transaction: 'all' });
      applied -= 1;
    }
    await closePostgres(upgraded);
    await closePostgres(baseline);
  }
});

async function exerciseDurableEdgeLifecycle(
  pg: ReturnType<typeof loadPostgresConfig>['runtime'],
  database: import('typeorm').DataSource,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-durable-lifecycle-'));
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

    controlPostgresTestService('stop');
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

    controlPostgresTestService('start');
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
      controlPostgresTestService('start');
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
    assert.equal((await decideNode(base, { ...queued, pairingCode: 'WRONG' }, 'approve')).status, 400);
    assert.equal((await decideNode(base, queued, 'approve')).status, 200);
    const outagePending = await queueNode(base, token, outageUid, 'Outage retry node');
    requestIds.push(outagePending.id);

    controlPostgresTestService('stop');
    databaseStopped = true;
    await waitForAcceptedPacketDuringOutage(base, live, uid);
    const rejectedWhileDown = await decideNode(base, outagePending, 'approve');
    assert.equal(rejectedWhileDown.status, 503, 'durable approval reports PostgreSQL unavailability');
    assert.deepEqual(await rejectedWhileDown.json(), { error: 'provisioning storage is unavailable' });
    assert.equal(live.child.exitCode, null, 'the edge process remains running during database outage');
    const liveUids = await readLiveNodeUids(base);
    assert.ok(liveUids.includes(uid), 'the last committed identity remains active during outage');
    assert.ok(!liveUids.includes(outageUid), 'the failed approval does not activate an uncommitted identity');
    assert.equal(existsSync(nodesPath), false, 'the outage does not trigger a nodes.json fallback');

    controlPostgresTestService('start');
    databaseStopped = false;
    await waitForDatabase(database);
    assert.equal((await decideNode(base, outagePending, 'approve')).status, 200, 'operator retry commits after recovery');
    await stopChild(live.child);

    restarted = await launchPostgresEdge(pg, directory, pg.port);
    const restartedLine = await waitForOutput(restarted, /registered nodes/, 15_000);
    assert.match(restartedLine, /2 registered nodes/, 'restart loads both committed registrations from PostgreSQL');
    assert.equal(existsSync(nodesPath), false, 'approval and restart did not create or mutate nodes.json');
  } finally {
    let cleanupFailure: unknown;
    if (databaseStopped) {
      try {
        controlPostgresTestService('start');
        await waitForDatabase(database);
        databaseStopped = false;
      } catch (error) {
        cleanupFailure = error;
      }
    }
    for (const edge of [failed, live, restarted]) {
      if (edge && !hasExited(edge.child)) {
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

function controlPostgresTestService(action: 'start' | 'stop'): void {
  // CI supplies its service-container ID; local rehearsals use disposable Compose.
  const containerId = process.env.PG_TEST_CONTAINER_ID;
  const args = containerId
    ? [action, containerId]
    : ['compose', '-f', 'docker-compose.postgres-test.yml', action, 'postgres-test'];
  execFileSync('docker', args, {
    cwd: dirname(dirname(testDirectory)), stdio: 'pipe', encoding: 'utf8',
  });
}

interface QueuedNode { id: string; uid: string; pairingCode: string }

async function queueNode(base: string, token: string, uid: string, label: string): Promise<QueuedNode> {
  const response = await fetch(`${base}/api/provision/request`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ uid, label }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const queued = await response.json() as QueuedNode;
  assert.equal(queued.uid, uid);
  assert.match(queued.pairingCode, /^[0-9A-F]{8}$/);
  return queued;
}

async function decideNode(base: string, request: QueuedNode, verdict: 'approve' | 'deny'): Promise<Response> {
  return fetch(`${base}/api/provision/requests/${request.id}/${verdict}`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Basic ${Buffer.from('edge-admin:edge-admin-password').toString('base64')}`,
      'x-tm-console': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ uid: request.uid, pairingCode: request.pairingCode }),
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
    if (hasExited(edge.child)) throw new Error(`edge exited before readiness: ${edge.state.output}`);
    if (Date.now() - started > timeoutMs) throw new Error(`edge did not become ready: ${edge.state.output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return edge.state.output;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge process did not exit')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  await waitForExit(child, 15_000);
  if (process.platform === 'win32') {
    // Windows force-kills child processes for SIGTERM; this checks stop/recovery,
    // while exerciseDurableEdgeLifecycle checks graceful in-process shutdown.
    assert.equal(child.signalCode, 'SIGTERM', 'edge terminates after the Windows stop request');
  } else {
    assert.equal(child.exitCode, 0, 'edge exits cleanly after SIGTERM');
  }
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
