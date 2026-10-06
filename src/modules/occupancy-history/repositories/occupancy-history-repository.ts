export interface OccupancyHistoryRecord {
  edgeId: string;
  floorId: string;
  tableId: string;
  minuteAt: number;
  sampledAt: number;
  capacity: number;
  occupied: number | null;
  free: number | null;
  coverage: 'ok' | 'fallback' | 'unknown';
}

/** Batch insert/upsert contract; it is called only by the asynchronous sink. */
export interface OccupancyHistoryRepository {
  writeBatch(records: readonly OccupancyHistoryRecord[]): Promise<void>;
}
