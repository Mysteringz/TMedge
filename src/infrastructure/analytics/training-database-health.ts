import pg from 'pg';
import { readerUrl } from '../../algo/ml-data/database.js';

/** A bounded reader probe: registry persistence and training storage are independent. */
export class TrainingDatabaseHealth {
  private readonly pool: pg.Pool | null;
  private pending: Promise<boolean> | null = null;
  constructor(env: NodeJS.ProcessEnv) {
    const url = readerUrl(env);
    this.pool = url ? new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000,
      query_timeout: 2000, idleTimeoutMillis: 15_000,
      options: '-c default_transaction_read_only=on -c statement_timeout=2000' }) : null;
    this.pool?.on('error', () => undefined);
  }
  get configured(): boolean { return this.pool !== null; }
  available(): Promise<boolean> {
    if (!this.pool) return Promise.resolve(false);
    if (!this.pending) this.pending = this.pool.query('SELECT 1').then(() => true, () => false)
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  async close(): Promise<void> { await this.pool?.end(); }
}
