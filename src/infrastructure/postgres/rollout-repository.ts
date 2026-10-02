import type { DataSource, EntityManager } from 'typeorm';
import type {
  RolloutNodeRecord, RolloutRecord, RolloutRepository, RolloutTargetRecord,
} from '../../modules/rollouts/repositories/rollout-repository.js';

interface RolloutRow {
  id: string; build_id: string; version: string; target: RolloutTargetRecord | string; started_by: string;
  started_at: Date | string; finished_at: Date | string | null; stage: RolloutRecord['stage'];
  recovery_state: RolloutRecord['recoveryState'] | null; note: string;
}
interface RolloutNodeRow {
  uid: string; label: string; floor_id: string | null; gateway_id: string | null;
  transport: RolloutNodeRecord['transport']; state: RolloutNodeRecord['state']; percent: number;
  error: string | null; started_at: Date | string | null; updated_at: Date | string; outcome_uncertain: boolean;
}
interface ExistingRolloutNodeRow {
  uid: string; state: RolloutNodeRecord['state']; percent: number; error: string | null;
  updated_at: Date | string; outcome_uncertain: boolean;
}

/** TypeORM adapter for durable rollout snapshots and per-node state. */
export class PostgresRolloutRepository implements RolloutRepository {
  constructor(private readonly source: DataSource) {}

  async current(): Promise<RolloutRecord | null> {
    const rows = await this.source.query(
      `SELECT id FROM public.firmware_rollouts WHERE stage IN ('pilot', 'rest') ORDER BY started_at DESC LIMIT 1`,
    ) as Array<{ id: string }>;
    return rows[0] ? getRollout(this.source.manager, rows[0].id) : null;
  }

  async history(): Promise<RolloutRecord[]> {
    const rows = await this.source.query(
      `SELECT id FROM public.firmware_rollouts WHERE stage IN ('done', 'stopped') ORDER BY started_at DESC, id`,
    ) as Array<{ id: string }>;
    const records: RolloutRecord[] = [];
    for (const row of rows) {
      const record = await getRollout(this.source.manager, row.id);
      if (record) records.push(record);
    }
    return records;
  }

  /** Saves the application snapshot atomically; callers must await before dispatching the next step. */
  async saveSnapshot(current: RolloutRecord | null, history: readonly RolloutRecord[]): Promise<void> {
    const byId = new Map(history.map((rollout) => [rollout.id, rollout]));
    if (current) byId.set(current.id, current);
    await this.source.transaction(async (manager) => {
      for (const rollout of byId.values()) await saveRollout(manager, rollout);
    });
  }

  /** Startup recovery moves active history to stopped and marks in-flight node outcomes uncertain. */
  async interruptActive(at: number): Promise<RolloutRecord | null> {
    return this.source.transaction(async (manager) => {
      const active = await manager.query(
        `SELECT id FROM public.firmware_rollouts WHERE stage IN ('pilot', 'rest') ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      ) as Array<{ id: string }>;
      const id = active[0]?.id;
      if (!id) return null;
      await manager.query(
        `UPDATE public.firmware_rollouts SET stage = 'stopped', recovery_state = 'interrupted', finished_at = $2,
           note = CASE WHEN note LIKE 'Interrupted after restart:%' THEN note
             ELSE 'Interrupted after restart: explicit operator action required. ' || note END
         WHERE id = $1`, [id, new Date(at)],
      );
      await manager.query(
        `WITH changed AS (
           UPDATE public.firmware_rollout_nodes SET outcome_uncertain = true,
             error = COALESCE(error, 'dispatch or confirmation outcome uncertain after restart'), updated_at = $2
           WHERE rollout_id = $1 AND state IN ('sending', 'downloading', 'verifying', 'applying', 'rebooting')
             AND outcome_uncertain = false
           RETURNING rollout_id, uid, state, percent, error, outcome_uncertain
         )
         INSERT INTO public.firmware_rollout_node_events
           (rollout_id, uid, state, percent, error, occurred_at, outcome_uncertain)
         SELECT rollout_id, uid, state, percent, error, $2, outcome_uncertain FROM changed`, [id, new Date(at)],
      );
      return getRollout(manager, id);
    });
  }
}

async function saveRollout(manager: EntityManager, rollout: RolloutRecord): Promise<void> {
  const existingNodes = await manager.query(
    `SELECT uid, state, percent, error, updated_at, outcome_uncertain
     FROM public.firmware_rollout_nodes WHERE rollout_id = $1`, [rollout.id],
  ) as ExistingRolloutNodeRow[];
  const previousByUid = new Map(existingNodes.map((node) => [node.uid, node]));
  await manager.query(
    `INSERT INTO public.firmware_rollouts
       (id, build_id, version, target, started_by, started_at, finished_at, stage, recovery_state, note)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET build_id = EXCLUDED.build_id, version = EXCLUDED.version,
       target = EXCLUDED.target, started_by = EXCLUDED.started_by, started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at, stage = EXCLUDED.stage, recovery_state = EXCLUDED.recovery_state,
       note = EXCLUDED.note`,
    [rollout.id, rollout.buildId, rollout.version, JSON.stringify(rollout.target), rollout.startedBy,
      new Date(rollout.startedAt), rollout.finishedAt === null ? null : new Date(rollout.finishedAt),
      rollout.stage, rollout.recoveryState ?? null, rollout.note],
  );
  for (const node of rollout.nodes) {
    const previous = previousByUid.get(node.uid);
    if (previous && previous.state === node.state && previous.percent === node.percent
      && previous.error === (node.error ?? null) && previous.outcome_uncertain === (node.outcomeUncertain ?? false)
      && epoch(previous.updated_at) === node.updatedAt) continue;
    await manager.query(
      `INSERT INTO public.firmware_rollout_node_events
       (rollout_id, uid, state, percent, error, occurred_at, outcome_uncertain)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rollout.id, node.uid, node.state, node.percent, node.error ?? null, new Date(node.updatedAt), node.outcomeUncertain ?? false],
    );
  }
  await manager.query('DELETE FROM public.firmware_rollout_nodes WHERE rollout_id = $1', [rollout.id]);
  for (const node of rollout.nodes) {
    await manager.query(
      `INSERT INTO public.firmware_rollout_nodes
       (rollout_id, uid, label, floor_id, gateway_id, transport, state, percent, error, started_at, updated_at, outcome_uncertain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [rollout.id, node.uid, node.label, node.floorId, node.gatewayId, node.transport, node.state, node.percent,
        node.error ?? null, node.startedAt === null ? null : new Date(node.startedAt), new Date(node.updatedAt), node.outcomeUncertain ?? false],
    );
  }
}

async function getRollout(manager: EntityManager, id: string): Promise<RolloutRecord | null> {
  const rows = await manager.query('SELECT * FROM public.firmware_rollouts WHERE id = $1', [id]) as RolloutRow[];
  const row = rows[0];
  if (!row) return null;
  const nodeRows = await manager.query(
    `SELECT uid, label, floor_id, gateway_id, transport, state, percent, error, started_at, updated_at, outcome_uncertain
     FROM public.firmware_rollout_nodes WHERE rollout_id = $1 ORDER BY uid`, [id],
  ) as RolloutNodeRow[];
  const target = typeof row.target === 'string' ? JSON.parse(row.target) as RolloutTargetRecord : row.target;
  return {
    id: row.id, buildId: row.build_id, version: row.version, target, startedBy: row.started_by,
    startedAt: epoch(row.started_at), finishedAt: row.finished_at === null ? null : epoch(row.finished_at),
    stage: row.stage, ...(row.recovery_state ? { recoveryState: row.recovery_state } : {}), note: row.note,
    nodes: nodeRows.map((node) => ({
      uid: node.uid, label: node.label, floorId: node.floor_id, gatewayId: node.gateway_id,
      transport: node.transport, state: node.state, percent: node.percent,
      ...(node.error === null ? {} : { error: node.error }),
      startedAt: node.started_at === null ? null : epoch(node.started_at), updatedAt: epoch(node.updated_at),
      ...(node.outcome_uncertain ? { outcomeUncertain: true } : {}),
    })),
  };
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
