import type { LocationDocument, LocationSensorAssignment } from '../../modules/location-config/domain/location-document.js';
import { LocationConflictError } from '../../modules/location-config/domain/location-records.js';

interface AssignmentQueryExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

interface RegisteredNodeRow { uid: string; rgb: boolean; }
interface PlacementRow { uid: string; floor_id: string; }

/**
 * Persists every node placement and table owner for one location in a fixed
 * number of parameterized statements. The caller owns the surrounding
 * transaction and registry mutation lock.
 */
export async function persistLocationNodeAssignments(
  manager: AssignmentQueryExecutor,
  locationId: string,
  document: LocationDocument,
): Promise<void> {
  const desired = new Map<string, LocationSensorAssignment>();
  for (const assignment of document.sensorAssignments) {
    const uid = assignment.uid.toLowerCase();
    if (desired.has(uid)) throw new TypeError('Sensor assignments contain duplicate UIDs.');
    desired.set(uid, assignment);
  }
  const assignments = [...desired.entries()].sort(([left], [right]) => left.localeCompare(right));
  const uids = assignments.map(([uid]) => uid);

  const placementRows = await manager.query(
    `SELECT uid, floor_id FROM public.node_placements
     WHERE floor_id = $1 OR uid = ANY($2::text[])
     ORDER BY uid FOR UPDATE`,
    [locationId, uids],
  ) as PlacementRow[];
  const placementsByUid = new Map(placementRows.map((row) => [row.uid.toLowerCase(), row]));
  const removedUids = placementRows
    .filter((row) => row.floor_id === locationId && !desired.has(row.uid.toLowerCase()))
    .map((row) => row.uid.toLowerCase())
    .sort();

  if (assignments.length > 0) {
    const registeredRows = await manager.query(
      `SELECT uid, rgb FROM public.registered_nodes
       WHERE uid = ANY($1::text[])
       ORDER BY uid FOR UPDATE`,
      [uids],
    ) as RegisteredNodeRow[];
    const registeredByUid = new Map(registeredRows.map((row) => [row.uid.toLowerCase(), row]));
    for (const [uid] of assignments) {
      const node = registeredByUid.get(uid);
      if (!node) throw new LocationConflictError(`Sensor ${uid} is not registered on this edge.`);
      if (node.rgb === true && document.visibility !== 'console') {
        throw new LocationConflictError(`RGB sensor ${uid} cannot be assigned to a public location.`);
      }
      const placement = placementsByUid.get(uid);
      if (placement && placement.floor_id !== locationId) {
        throw new LocationConflictError(`Sensor ${uid} already belongs to another location.`);
      }
    }
  }

  const affectedUids = [...new Set([...uids, ...removedUids])].sort();
  if (affectedUids.length > 0) {
    await manager.query(
      'DELETE FROM public.node_table_owners WHERE uid = ANY($1::text[])',
      [affectedUids],
    );
  }
  if (removedUids.length > 0) {
    await manager.query(
      'DELETE FROM public.node_placements WHERE floor_id = $1 AND uid = ANY($2::text[])',
      [locationId, removedUids],
    );
  }
  if (assignments.length > 0) {
    const x = assignments.map(([, assignment]) => assignment.pose.x);
    const y = assignments.map(([, assignment]) => assignment.pose.y);
    const heightCm = assignments.map(([, assignment]) => assignment.pose.heightCm);
    const yawDeg = assignments.map(([, assignment]) => assignment.pose.yawDeg);
    const mirror = assignments.map(([, assignment]) => assignment.pose.mirror);
    await manager.query(
      `INSERT INTO public.node_placements (uid, floor_id, x, y, height_cm, yaw_deg, mirror)
       SELECT placement.uid, $2, placement.x, placement.y, placement.height_cm, placement.yaw_deg, placement.mirror
       FROM unnest($1::text[], $3::double precision[], $4::double precision[], $5::double precision[], $6::double precision[], $7::boolean[])
         AS placement(uid, x, y, height_cm, yaw_deg, mirror)
       ON CONFLICT (uid) DO UPDATE SET floor_id = EXCLUDED.floor_id, x = EXCLUDED.x, y = EXCLUDED.y,
         height_cm = EXCLUDED.height_cm, yaw_deg = EXCLUDED.yaw_deg, mirror = EXCLUDED.mirror`,
      [uids, locationId, x, y, heightCm, yawDeg, mirror],
    );

    const owners = assignments.flatMap(([uid, assignment]) => assignment.owns.map((tableId) => ({ tableId, uid })))
      .sort((left, right) => left.tableId.localeCompare(right.tableId) || left.uid.localeCompare(right.uid));
    if (owners.length > 0) {
      await manager.query(
        `INSERT INTO public.node_table_owners (table_id, uid)
         SELECT owner.table_id, owner.uid
         FROM unnest($1::text[], $2::text[]) AS owner(table_id, uid)`,
        [owners.map((owner) => owner.tableId), owners.map((owner) => owner.uid)],
      );
    }
  }
}
