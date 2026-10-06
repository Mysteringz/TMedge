import type { DataSource, EntityManager } from 'typeorm';
import type { NodePose } from '../../shared/types.js';
import { RegistrationConflictError, type RegistryNodeRecord, type RegistryRepository } from '../../modules/registration/repositories/registry-repository.js';

interface RegistryNodeRow {
  uid: string;
  label: string;
  simulated: boolean;
  rgb: boolean;
  detector: 'node' | 'edge';
  floor_id: string | null;
  x: number | string | null;
  y: number | string | null;
  height_cm: number | string | null;
  yaw_deg: number | string | null;
  mirror: boolean | null;
  owns: string[] | null;
}

/** PostgreSQL adapter for registered identities, placements, and ownership. */
export class PostgresRegistryRepository implements RegistryRepository {
  constructor(private readonly source: DataSource) {}

  async listNodes(): Promise<RegistryNodeRecord[]> {
    return queryNodes(this.source.manager);
  }

  async importNodes(nodes: readonly RegistryNodeRecord[]): Promise<{ inserted: number; unchanged: number }> {
    return this.source.transaction(async (manager) => {
      let inserted = 0;
      let unchanged = 0;
      for (const node of nodes) {
        const existing = await queryNode(manager, node.uid, true);
        if (existing) {
          if (!sameNode(existing, node)) throw new RegistrationConflictError(`Registration ${node.uid} already exists with different data`);
          unchanged += 1;
          continue;
        }
        await manager.query(
          'INSERT INTO public.registered_nodes (uid, label, simulated, rgb, detector) VALUES ($1, $2, $3, $4, $5)',
          [node.uid, node.label, node.simulated, node.rgb, node.detector],
        );
        if (node.floorId !== null && node.pose !== null) {
          await manager.query(
            `INSERT INTO public.node_placements (uid, floor_id, x, y, height_cm, yaw_deg, mirror)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [node.uid, node.floorId, node.pose.x, node.pose.y, node.pose.heightCm, node.pose.yawDeg, node.pose.mirror],
          );
        }
        for (const tableId of node.owns) {
          await manager.query('INSERT INTO public.node_table_owners (table_id, uid) VALUES ($1, $2)', [tableId, node.uid]);
        }
        inserted += 1;
      }
      return { inserted, unchanged };
    });
  }
}

async function queryNodes(manager: EntityManager): Promise<RegistryNodeRecord[]> {
  const rows = await manager.query(
    `SELECT n.uid, n.label, n.simulated, n.rgb, n.detector, p.floor_id, p.x, p.y, p.height_cm, p.yaw_deg, p.mirror,
       COALESCE(array_agg(o.table_id ORDER BY o.table_id) FILTER (WHERE o.table_id IS NOT NULL), '{}') AS owns
     FROM public.registered_nodes n
     LEFT JOIN public.node_placements p ON p.uid = n.uid
     LEFT JOIN public.node_table_owners o ON o.uid = n.uid
     GROUP BY n.uid, n.label, n.simulated, n.rgb, n.detector, p.floor_id, p.x, p.y, p.height_cm, p.yaw_deg, p.mirror
     ORDER BY n.uid`,
  ) as RegistryNodeRow[];
  return rows.map(mapNode);
}

async function queryNode(manager: EntityManager, uid: string, lock: boolean): Promise<RegistryNodeRecord | null> {
  if (lock) await manager.query('SELECT uid FROM public.registered_nodes WHERE uid = $1 FOR UPDATE', [uid]);
  const rows = await manager.query(
    `SELECT n.uid, n.label, n.simulated, n.rgb, n.detector, p.floor_id, p.x, p.y, p.height_cm, p.yaw_deg, p.mirror,
       COALESCE(array_agg(o.table_id ORDER BY o.table_id) FILTER (WHERE o.table_id IS NOT NULL), '{}') AS owns
     FROM public.registered_nodes n
     LEFT JOIN public.node_placements p ON p.uid = n.uid
     LEFT JOIN public.node_table_owners o ON o.uid = n.uid
     WHERE n.uid = $1
     GROUP BY n.uid, n.label, n.simulated, n.rgb, n.detector, p.floor_id, p.x, p.y, p.height_cm, p.yaw_deg, p.mirror`,
    [uid],
  ) as RegistryNodeRow[];
  return rows[0] ? mapNode(rows[0]) : null;
}

function mapNode(row: RegistryNodeRow): RegistryNodeRecord {
  const placed = row.floor_id !== null;
  const pose: NodePose | null = placed ? {
    x: Number(row.x), y: Number(row.y), heightCm: Number(row.height_cm),
    yawDeg: Number(row.yaw_deg), mirror: row.mirror === true,
  } : null;
  return {
    uid: row.uid, label: row.label, floorId: row.floor_id, pose,
    owns: row.owns ?? [], simulated: row.simulated, rgb: row.rgb, detector: row.detector,
  };
}

function sameNode(a: RegistryNodeRecord, b: RegistryNodeRecord): boolean {
  return a.uid === b.uid && a.label === b.label && a.floorId === b.floorId
    && JSON.stringify(a.pose) === JSON.stringify(b.pose)
    && [...a.owns].sort().join('\0') === [...b.owns].sort().join('\0')
    && a.simulated === b.simulated && a.rgb === b.rgb && a.detector === b.detector;
}
