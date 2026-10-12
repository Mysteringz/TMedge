import type { DataSource, EntityManager } from 'typeorm';
import type { Actor } from '../../modules/shared/application/contracts.js';
import type {
  NodeRegistration,
  ProvisioningRepository,
  ProvisioningRequestRecord,
  ProvisioningResolution,
  ApprovalCommitResolution,
  ProvisioningTransaction,
} from '../../modules/provisioning/repositories/provisioning-repository.js';
import { incrementLocationRegistryRevision, readLocationRegistryRevision } from './location-registry-revision.js';

const PENDING_QUEUE_LOCK_ID = 1_414_412_097;

interface RequestRow {
  id: string;
  uid: string;
  label: string;
  firmware: string | null;
  requested_by: string;
  requested_at: Date | string;
  expires_at: Date | string;
  status: ProvisioningRequestRecord['status'];
  resolved_at: Date | string | null;
  resolved_by_id: string | null;
  resolved_by_kind: Actor['kind'] | null;
  registered_uid: string | null;
}

interface NodeRow {
  uid: string;
  label: string;
  simulated: boolean;
  rgb: boolean;
  detector: 'node' | 'edge';
}

const REQUEST_COLUMNS = `
  id, uid, label, firmware, requested_by, requested_at, expires_at, status,
  resolved_at, resolved_by_id, resolved_by_kind, registered_uid
`;

/** TypeORM adapter for the provisioning repository; no ORM entity escapes this module. */
export class PostgresProvisioningRepository implements ProvisioningRepository {
  constructor(
    private readonly source: DataSource,
    private readonly runTransaction: <T>(work: (manager: EntityManager) => Promise<T>) => Promise<T> = (work) => source.transaction(work),
  ) {}

  async findRequest(requestId: string): Promise<ProvisioningRequestRecord | null> {
    const rows = await this.source.query<RequestRow[]>(
      `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests WHERE id = $1`, [requestId],
    );
    return rows[0] ? mapRequest(rows[0]) : null;
  }

  async findRequestByNodeUid(uid: string): Promise<ProvisioningRequestRecord | null> {
    const rows = await this.source.query<RequestRow[]>(
      `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests
       WHERE uid = $1 AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`, [uid],
    );
    return rows[0] ? mapRequest(rows[0]) : null;
  }

  async listPendingRequests(): Promise<ProvisioningRequestRecord[]> {
    const rows = await this.source.query<RequestRow[]>(
      `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests
       WHERE status = 'pending' ORDER BY requested_at, id`,
    );
    return rows.map(mapRequest);
  }

  async findNode(uid: string): Promise<NodeRegistration | null> {
    const rows = await this.source.query<NodeRow[]>(
      'SELECT uid, label, simulated, rgb, detector FROM public.registered_nodes WHERE uid = $1', [uid],
    );
    return rows[0] ? mapNode(rows[0]) : null;
  }

  async registryRevision(): Promise<number> {
    return readLocationRegistryRevision(this.source.manager);
  }

  async reconcileApproval(
    expectedRequest: ProvisioningRequestRecord,
    expectedResolution: { resolvedAt: number; resolvedBy: Actor },
    expectedNode: NodeRegistration,
    expectedBaseRevision: number,
  ): Promise<ApprovalCommitResolution> {
    const registryRevision = await this.registryRevision();
    const request = await this.findRequest(expectedRequest.id);
    const nodeRows = await this.source.query<NodeRow[]>(
      'SELECT uid, label, simulated, rgb, detector FROM public.registered_nodes WHERE uid = $1', [expectedNode.uid],
    );
    const placements = await this.source.query<Array<{ uid: string }>>(
      'SELECT uid FROM public.node_placements WHERE uid = $1', [expectedNode.uid],
    );
    const ownership = await this.source.query<Array<{ uid: string }>>(
      'SELECT uid FROM public.node_table_owners WHERE uid = $1', [expectedNode.uid],
    );
    const audits = await this.source.query<Array<{ actor_id: string; actor_kind: Actor['kind']; occurred_at: Date | string }>>(
      `SELECT actor_id, actor_kind, occurred_at FROM public.provisioning_audit_events
       WHERE action = 'request.approved' AND subject_id = $1`, [expectedRequest.id],
    );
    const audit = audits[0];
    const row = nodeRows[0];
    const exactNode = !!row && row.uid === expectedNode.uid && row.label === expectedNode.label
      && row.simulated === expectedNode.simulated && row.rgb === expectedNode.rgb && row.detector === expectedNode.detector
      && placements.length === 0 && ownership.length === 0;
    const exactRequestIdentity = !!request && request.id === expectedRequest.id && request.uid === expectedRequest.uid
      && request.label === expectedRequest.label && request.firmware === expectedRequest.firmware
      && request.requestedBy === expectedRequest.requestedBy && request.requestedAt === expectedRequest.requestedAt
      && request.expiresAt === expectedRequest.expiresAt;
    const exactResolution = request?.resolvedAt === expectedResolution.resolvedAt
      && request.resolvedBy?.id === expectedResolution.resolvedBy.id
      && request.resolvedBy?.kind === expectedResolution.resolvedBy.kind;
    const exactAudit = audits.length === 1 && !!audit
      && audit.actor_id === expectedResolution.resolvedBy.id
      && audit.actor_kind === expectedResolution.resolvedBy.kind
      && toEpochMs(audit.occurred_at) === expectedResolution.resolvedAt;

    if (registryRevision === expectedBaseRevision + 1 && exactRequestIdentity && request?.status === 'approved'
      && exactResolution && request.registeredUid === expectedNode.uid && exactNode && exactAudit) {
      return { kind: 'committed', request, node: mapNode(row!), registryRevision };
    }
    if (registryRevision === expectedBaseRevision && exactRequestIdentity && request?.status === 'pending'
      && request.resolvedAt === null && request.resolvedBy === null && request.registeredUid === null
      && !row && placements.length === 0 && ownership.length === 0 && audits.length === 0) {
      return { kind: 'not-committed', registryRevision };
    }
    return { kind: 'unknown' };
  }

  async reconcile(requestId: string, uid: string): Promise<ProvisioningResolution | null> {
    const request = await this.findRequest(requestId);
    if (!request || request.uid !== uid) return null;
    if (request.status !== 'approved') return { status: request.status, request };
    if (request.registeredUid !== uid) return null;
    const node = await this.findNode(uid);
    return node ? { status: 'approved', request, node } : null;
  }

  async transaction<T>(work: (transaction: ProvisioningTransaction) => Promise<T>): Promise<T> {
    return this.runTransaction(async (manager) => work(transactionFor(manager)));
  }
}

function transactionFor(manager: EntityManager): ProvisioningTransaction {
  return {
    async findRequestForUpdate(requestId) {
      const rows = await manager.query(
        `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests WHERE id = $1 FOR UPDATE`, [requestId],
      ) as RequestRow[];
      return rows[0] ? mapRequest(rows[0]) : null;
    },
    async lockPendingQueue() {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [PENDING_QUEUE_LOCK_ID]);
    },
    async countPendingRequests() {
      const rows = await manager.query(
        "SELECT count(*)::int AS count FROM public.provisioning_requests WHERE status = 'pending'",
      ) as Array<{ count: number }>;
      return Number(rows[0]?.count ?? 0);
    },
    async findExpiredPendingRequestsForUpdate(at) {
      const rows = await manager.query(
        `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests
         WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at, id FOR UPDATE`, [new Date(at)],
      ) as RequestRow[];
      return rows.map(mapRequest);
    },
    async findPendingRequestByNodeUid(uid) {
      const rows = await manager.query(
        `SELECT ${REQUEST_COLUMNS} FROM public.provisioning_requests
         WHERE uid = $1 AND status = 'pending' ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`, [uid],
      ) as RequestRow[];
      return rows[0] ? mapRequest(rows[0]) : null;
    },
    async findNode(uid) {
      const rows = await manager.query(
        'SELECT uid, label, simulated, rgb, detector FROM public.registered_nodes WHERE uid = $1', [uid],
      ) as NodeRow[];
      return rows[0] ? mapNode(rows[0]) : null;
    },
    async saveRequest(request) {
      await manager.query(
        `INSERT INTO public.provisioning_requests (
           id, uid, label, firmware, requested_by, requested_at, expires_at, status,
           resolved_at, resolved_by_id, resolved_by_kind, registered_uid
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           uid = EXCLUDED.uid, label = EXCLUDED.label, firmware = EXCLUDED.firmware,
           requested_by = EXCLUDED.requested_by, requested_at = EXCLUDED.requested_at,
           expires_at = EXCLUDED.expires_at, status = EXCLUDED.status,
           resolved_at = EXCLUDED.resolved_at, resolved_by_id = EXCLUDED.resolved_by_id,
           resolved_by_kind = EXCLUDED.resolved_by_kind, registered_uid = EXCLUDED.registered_uid`,
        [request.id, request.uid, request.label, request.firmware, request.requestedBy,
          new Date(request.requestedAt), new Date(request.expiresAt), request.status,
          request.resolvedAt === null ? null : new Date(request.resolvedAt), request.resolvedBy?.id ?? null,
          request.resolvedBy?.kind ?? null, request.registeredUid],
      );
    },
    async registerNode(node) {
      await manager.query(
        `INSERT INTO public.registered_nodes (uid, label, simulated, rgb, detector) VALUES ($1, $2, $3, $4, $5)`,
        [node.uid, node.label, node.simulated, node.rgb, node.detector],
      );
      await incrementLocationRegistryRevision(manager);
    },
    async appendAudit(event) {
      await manager.query(
        `INSERT INTO public.provisioning_audit_events (actor_id, actor_kind, action, subject_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [event.actor.id, event.actor.kind, event.action, event.subjectId, new Date(event.at)],
      );
    },
  };
}

function mapRequest(row: RequestRow): ProvisioningRequestRecord {
  return {
    id: row.id,
    uid: row.uid,
    label: row.label,
    firmware: row.firmware,
    requestedBy: row.requested_by,
    requestedAt: toEpochMs(row.requested_at),
    expiresAt: toEpochMs(row.expires_at),
    status: row.status,
    resolvedAt: row.resolved_at === null ? null : toEpochMs(row.resolved_at),
    resolvedBy: row.resolved_by_id === null || row.resolved_by_kind === null
      ? null : { id: row.resolved_by_id, kind: row.resolved_by_kind },
    registeredUid: row.registered_uid,
  };
}

function mapNode(row: NodeRow): NodeRegistration {
  return {
    uid: row.uid, label: row.label, floorId: null, pose: null, owns: [],
    simulated: row.simulated, rgb: row.rgb, detector: row.detector,
  };
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
