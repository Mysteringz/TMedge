import type { OccupancySnapshot } from '../../../shared/types.js';
import type { OccupancyHistoryRecord, OccupancyHistoryRepository } from '../repositories/occupancy-history-repository.js';

const MINUTE_MS = 60_000;
const DEFAULT_MAX_PENDING_ROWS = 5_000;
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface OccupancyHistorySinkOptions {
  maxPendingRows?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface OccupancyHistorySinkStats {
  queuedRows: number;
  droppedRows: number;
  failedBatches: number;
  lastError: string | null;
}

interface PendingEntry { record: OccupancyHistoryRecord; attempts: number }

/**
 * A bounded, non-blocking queue between live snapshots and PostgreSQL.
 * Queue pressure and exhausted retries are visible through `stats()`.
 */
export class BoundedOccupancyHistorySink {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly maxPendingRows: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private droppedRows = 0;
  private failedBatches = 0;
  private lastError: string | null = null;
  private flushing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly repository: OccupancyHistoryRepository, options: OccupancyHistorySinkOptions = {}) {
    this.maxPendingRows = positiveInt(options.maxPendingRows ?? DEFAULT_MAX_PENDING_ROWS, 'maxPendingRows');
    this.batchSize = positiveInt(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize');
    this.maxAttempts = positiveInt(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
    this.retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  /** Copies the compact minute rows and returns immediately; persistence proceeds in the background. */
  enqueue(snapshot: OccupancySnapshot): boolean {
    if (this.disposed) return false;
    const sampledAt = snapshot.generatedAt;
    const minuteAt = Math.floor(sampledAt / MINUTE_MS) * MINUTE_MS;
    let accepted = true;
    for (const floor of snapshot.floors) for (const table of floor.tables) {
      const record: OccupancyHistoryRecord = {
        edgeId: snapshot.edgeId, floorId: floor.id, tableId: table.id, minuteAt, sampledAt,
        capacity: table.capacity, occupied: table.occupied, free: table.free, coverage: table.status,
      };
      const key = recordKey(record);
      if (this.pending.has(key)) {
        this.pending.set(key, { record, attempts: 0 });
      } else {
        if (this.pending.size >= this.maxPendingRows) {
          const oldest = this.pending.keys().next().value as string | undefined;
          if (oldest !== undefined) this.pending.delete(oldest);
          this.droppedRows += 1;
          accepted = false;
        }
        this.pending.set(key, { record, attempts: 0 });
      }
    }
    void this.flush();
    return accepted;
  }

  /** Runs pending batches, primarily useful for orderly shutdown and deterministic tests. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.clearRetryTimer();
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  stats(): OccupancyHistorySinkStats {
    return { queuedRows: this.pending.size, droppedRows: this.droppedRows, failedBatches: this.failedBatches, lastError: this.lastError };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearRetryTimer();
    await this.flushing;
    this.droppedRows += this.pending.size;
    this.pending.clear();
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.pending.size > 0) {
      const entries = [...this.pending.entries()].slice(0, this.batchSize);
      const [keys, values] = [entries.map(([key]) => key), entries.map(([, value]) => value)] as const;
      try {
        await this.repository.writeBatch(values.map((entry) => entry.record));
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index]!;
          if (this.pending.get(key) === values[index]) this.pending.delete(key);
        }
        this.lastError = null;
      } catch (error) {
        this.failedBatches += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index]!;
          const current = this.pending.get(key);
          if (!current || current !== values[index]) continue;
          current.attempts += 1;
          if (current.attempts >= this.maxAttempts) {
            this.pending.delete(key);
            this.droppedRows += 1;
          }
        }
        if (!this.disposed && this.pending.size > 0) this.scheduleRetry();
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, this.retryDelayMs);
    this.retryTimer.unref();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function recordKey(record: OccupancyHistoryRecord): string {
  return `${record.edgeId}\0${record.floorId}\0${record.tableId}\0${record.minuteAt}`;
}

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
