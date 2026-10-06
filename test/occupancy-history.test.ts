import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedOccupancyHistorySink } from '../src/modules/occupancy-history/application/bounded-occupancy-history-sink.js';
import type { OccupancyHistoryRecord, OccupancyHistoryRepository } from '../src/modules/occupancy-history/repositories/occupancy-history-repository.js';
import type { OccupancySnapshot } from '../src/shared/types.js';

function snapshot(at: number, occupied = 2): OccupancySnapshot {
  return {
    version: 1, edgeId: 'edge-test', site: { id: 'site-test', name: 'Test site' }, generatedAt: at,
    floors: [{
      id: 'floor-a', building: 'Building', name: 'Floor A', width: 1000, height: 500, outline: [], zones: [],
      totals: { seats: 6, free: 2, occupied: 2, unknownSeats: 2, tablesFullyFree: 0 },
      tables: [
        { id: 'T1', name: 'T1', zoneId: 'Z1', rect: { x: 0, y: 0, width: 100, height: 100 },
          capacity: 4, occupied, free: 4 - occupied, status: 'ok', seats: [] },
        { id: 'T2', name: 'T2', zoneId: 'Z1', rect: { x: 100, y: 0, width: 100, height: 100 },
          capacity: 2, occupied: null, free: null, status: 'unknown', seats: [] },
      ],
    }],
  };
}

function singleTableSnapshot(at: number, occupied: number): OccupancySnapshot {
  const value = snapshot(at, occupied);
  value.floors[0]!.tables = value.floors[0]!.tables.slice(0, 1);
  return value;
}

class BlockingRepository implements OccupancyHistoryRepository {
  batches: OccupancyHistoryRecord[][] = [];
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;

  constructor() { this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; }); }

  release(): void { this.releaseGate(); }

  async writeBatch(records: readonly OccupancyHistoryRecord[]): Promise<void> {
    this.batches.push([...records]);
    await this.gate;
  }
}

test('enqueue does not wait for database I/O and queue size stays bounded', async () => {
  const repository = new BlockingRepository();
  const sink = new BoundedOccupancyHistorySink(repository, { maxPendingRows: 2, batchSize: 2 });
  assert.equal(sink.enqueue(snapshot(1_800_000_000_001)), true);
  assert.equal(repository.batches.length, 1, 'the async write started without awaiting it');
  assert.equal(sink.enqueue(snapshot(1_800_000_060_001, 1)), true, 'the bounded pending queue accepts the next minute during an in-flight batch');
  assert.deepEqual(sink.stats(), { queuedRows: 2, droppedRows: 0, failedBatches: 0, lastError: null, lastSuccessfulWriteAt: null },
    'a successful in-flight write is not reported as dropped');
  repository.release();
  await sink.flush();
  assert.equal(sink.stats().queuedRows, 0);
  assert.deepEqual(repository.batches[1]?.map((row) => row.minuteAt), [1_800_000_060_000, 1_800_000_060_000]);
  await sink.dispose();
});

test('coalesced values count against capacity while an older version is in flight', async () => {
  const repository = new BlockingRepository();
  const sink = new BoundedOccupancyHistorySink(repository, { maxPendingRows: 1, batchSize: 1 });
  sink.enqueue(singleTableSnapshot(1_800_000_000_001, 2));
  sink.enqueue(singleTableSnapshot(1_800_000_010_001, 3));
  assert.equal(sink.stats().queuedRows, 1, 'the newer value waits separately from the write already in flight');
  assert.equal(sink.enqueue(singleTableSnapshot(1_800_000_060_001, 1)), false);
  assert.equal(sink.stats().queuedRows, 1, 'queue depth never exceeds its configured waiting-row cap');
  assert.equal(sink.stats().droppedRows, 1, 'only the coalesced waiting value was dropped');
  repository.release();
  await sink.flush();
  assert.deepEqual(repository.batches.flat().map((row) => row.minuteAt), [
    1_800_000_000_000, 1_800_000_060_000,
  ]);
  await sink.dispose();
});

test('same minute is coalesced and unknown occupancy stays unknown in history', async () => {
  const repository = new BlockingRepository();
  const sink = new BoundedOccupancyHistorySink(repository);
  sink.enqueue(snapshot(1_800_000_000_001, 2));
  sink.enqueue(snapshot(1_800_000_010_000, 3));
  repository.release();
  await sink.flush();
  const allRows = repository.batches.flat();
  assert.equal(new Set(allRows.map((row) => `${row.edgeId}/${row.floorId}/${row.tableId}/${row.minuteAt}`)).size, 2,
    'the pending map retains one latest value per table/minute key');
  const latestT1 = allRows.filter((row) => row.tableId === 'T1').at(-1);
  assert.equal(latestT1?.occupied, 3, 'the newest same-minute snapshot is retained');
  const unknown = allRows.find((row) => row.tableId === 'T2');
  assert.ok(unknown);
  assert.equal(unknown.coverage, 'unknown');
  assert.equal(unknown.occupied, null);
  assert.equal(unknown.free, null);
  assert.equal('updatedAt' in unknown, false, 'history rows carry their sample time without becoming a live freshness signal');
  await sink.dispose();
});

test('failed batches retry a bounded number of times and expose dropped rows', async () => {
  let attempts = 0;
  const repository: OccupancyHistoryRepository = {
    async writeBatch() { attempts += 1; throw new Error('database unavailable'); },
  };
  const sink = new BoundedOccupancyHistorySink(repository, { maxAttempts: 2, retryDelayMs: 10_000 });
  sink.enqueue(snapshot(1_800_000_000_001));
  await sink.flush();
  assert.equal(sink.stats().queuedRows, 2);
  await sink.flush();
  assert.equal(attempts, 2);
  assert.deepEqual(sink.stats(), { queuedRows: 0, droppedRows: 2, failedBatches: 2, lastError: 'database unavailable', lastSuccessfulWriteAt: null });
  await sink.dispose();
});

test('coalescing during a failed write cannot reset the retry limit', async () => {
  let attempts = 0;
  const rejectAttempts: Array<() => void> = [];
  const repository: OccupancyHistoryRepository = {
    writeBatch() {
      attempts += 1;
      return new Promise<void>((_resolve, reject) => rejectAttempts.push(() => reject(new Error('database unavailable'))));
    },
  };
  const sink = new BoundedOccupancyHistorySink(repository, { maxAttempts: 2, retryDelayMs: 10_000 });
  sink.enqueue(snapshot(1_800_000_000_001));
  for (let occupied = 1; occupied <= 5; occupied += 1) sink.enqueue(snapshot(1_800_000_010_000 + occupied, occupied));
  rejectAttempts.shift()?.();
  await sink.flush();
  const secondAttempt = sink.flush();
  assert.equal(attempts, 2);
  rejectAttempts.shift()?.();
  await secondAttempt;
  assert.equal(attempts, 2);
  assert.equal(sink.stats().queuedRows, 0, 'the row is dropped after the configured number of failed writes');
  assert.equal(sink.stats().droppedRows, 2);
  await sink.dispose();
});
