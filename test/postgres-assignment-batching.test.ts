import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { persistLocationNodeAssignments } from '../src/infrastructure/postgres/location-node-assignment-writer.js';

interface RecordedQuery { sql: string; parameters: unknown[]; }

function assignmentDocument(assignmentCount: number, tablesPerAssignment: number) {
  const tableCount = assignmentCount * tablesPerAssignment;
  const tables = Array.from({ length: tableCount }, (_, index) => {
    const x = 10 + (index % 20) * 45;
    const y = 10 + Math.floor(index / 20) * 45;
    return {
      id: `BATCH-TABLE-${String(index).padStart(3, '0')}`,
      name: `Table ${index}`,
      zoneId: 'batch-zone',
      capacity: 1,
      shape: { type: 'rect' as const, x, y, width: 20, height: 20 },
      seats: [{ id: `BATCH-SEAT-${String(index).padStart(3, '0')}`, x: x + 10, y: y + 30, neighbors: [] }],
    };
  });
  return parseLocationDocument({
    schemaVersion: 1,
    locationId: 'location_batch-test_00000000-0000-4000-8000-000000000001',
    name: 'Batch test', building: 'Test', widthCm: 1000, heightCm: 1000,
    outline: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
    zones: [{ id: 'batch-zone', name: 'All tables', polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }],
    tables,
    sensorAssignments: Array.from({ length: assignmentCount }, (_, index) => {
      const ownedTables = Array.from({ length: tablesPerAssignment }, (_, offset) => {
        return tables[index * tablesPerAssignment + offset]!.id;
      });
      return {
        uid: `02:00:00:00:00:${(index + 1).toString(16).padStart(2, '0')}`,
        pose: { x: 100 + index, y: 100, heightCm: 350, yawDeg: 0, mirror: false },
        owns: ownedTables,
      };
    }),
  });
}

async function recordAssignmentQueries(assignmentCount: number, tablesPerAssignment: number): Promise<RecordedQuery[]> {
  const calls: RecordedQuery[] = [];
  const manager = {
    async query(sql: string, parameters: unknown[] = []): Promise<unknown> {
      calls.push({ sql, parameters });
      if (sql.includes('FROM public.registered_nodes')) {
        const uids = parameters[0] as string[];
        return uids.map((uid) => ({ uid, rgb: false }));
      }
      return [];
    },
  };
  const document = assignmentDocument(assignmentCount, tablesPerAssignment);
  await persistLocationNodeAssignments(manager, document.locationId, document);
  return calls;
}

test('PostgreSQL assignment SQL uses a fixed statement count as assigned nodes and owned tables grow', async () => {
  const small = await recordAssignmentQueries(2, 1);
  const large = await recordAssignmentQueries(32, 3);

  assert.equal(small.length, 5);
  assert.equal(large.length, small.length, 'queries are batched instead of scaling per assigned node or table');
  assert.equal(large.filter((call) => call.sql.includes('FROM public.node_placements')).length, 1);
  assert.equal(large.filter((call) => call.sql.includes('FROM public.registered_nodes')).length, 1);
  assert.equal(large.filter((call) => call.sql.startsWith('DELETE FROM public.node_table_owners')).length, 1);
  assert.equal(large.filter((call) => call.sql.startsWith('INSERT INTO public.node_placements')).length, 1);
  assert.equal(large.filter((call) => call.sql.startsWith('INSERT INTO public.node_table_owners')).length, 1);

  const placementBatch = large.find((call) => call.sql.startsWith('INSERT INTO public.node_placements'))!;
  assert.equal((placementBatch.parameters[0] as string[]).length, 32);
  assert.equal((placementBatch.parameters[2] as number[]).length, 32);
  const ownerBatch = large.find((call) => call.sql.startsWith('INSERT INTO public.node_table_owners'))!;
  assert.equal((ownerBatch.parameters[0] as string[]).length, 96);
  assert.equal((ownerBatch.parameters[1] as string[]).length, 96);
});
