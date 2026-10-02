import type { DataSource } from 'typeorm';
import type { OccupancyHistoryRecord, OccupancyHistoryRepository } from '../../modules/occupancy-history/repositories/occupancy-history-repository.js';

const COLUMNS_PER_ROW = 9;
const MAX_ROWS_PER_STATEMENT = Math.floor(60_000 / COLUMNS_PER_ROW);

/** PostgreSQL minute-history adapter; rows never feed live occupancy or freshness state. */
export class PostgresOccupancyHistoryRepository implements OccupancyHistoryRepository {
  constructor(private readonly source: DataSource) {}

  async writeBatch(records: readonly OccupancyHistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.source.transaction(async (manager) => {
      for (let offset = 0; offset < records.length; offset += MAX_ROWS_PER_STATEMENT) {
        const batch = records.slice(offset, offset + MAX_ROWS_PER_STATEMENT);
        const values: unknown[] = [];
        const placeholders = batch.map((record, index) => {
          const start = index * COLUMNS_PER_ROW;
          values.push(new Date(record.minuteAt), new Date(record.sampledAt), record.edgeId, record.floorId,
            record.tableId, record.capacity, record.occupied, record.free, record.coverage);
          return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9})`;
        });
        await manager.query(
          `INSERT INTO public.occupancy_history
           (minute_at, sampled_at, edge_id, floor_id, table_id, capacity, occupied, free, coverage)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (minute_at, edge_id, floor_id, table_id) DO UPDATE SET
             sampled_at = EXCLUDED.sampled_at, capacity = EXCLUDED.capacity,
             occupied = EXCLUDED.occupied, free = EXCLUDED.free, coverage = EXCLUDED.coverage
           WHERE public.occupancy_history.sampled_at <= EXCLUDED.sampled_at`, values,
        );
      }
    });
  }
}
