import type { DataSource, EntityManager } from 'typeorm';
import type { Actor } from '../../modules/shared/application/contracts.js';
import type {
  NodeRegistration,
  ProvisioningRepository,
  ProvisioningRequestRecord,
  ProvisioningResolution,
  ProvisioningTransaction,
} from '../../modules/provisioning/repositories/provisioning-repository.js';

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
}

const REQUEST_COLUMNS = `
  id, uid, label, firmware, requested_by, requested_at, expires_at, status,
  resolved_at, resolved_by_id, resolved_by_kind, registered_uid
`;

/** TypeORM adapter for the provisioning repository; no ORM entity escapes this module. */
export class PostgresProvisioningRepository implements ProvisioningRepository {
  constructor(private readonly source: DataSource) {}

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
      'SELECT uid, label FROM public.registered_nodes WHERE uid = $1', [uid],
    );
    return rows[0] ? mapNode(rows[0]) : null;
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
    return this.source.transaction(async (manager) => work(transactionFor(manager)));
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
        'SELECT uid, label FROM public.registered_nodes WHERE uid = $1', [uid],
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
        `INSERT INTO public.registered_nodes (uid, label, simulated, rgb) VALUES ($1, $2, false, false)`,
        [node.uid, node.label],
      );
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
  return { uid: row.uid, label: row.label, floorId: null, pose: null, owns: [] };
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
