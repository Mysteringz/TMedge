import pg from 'pg';
import { readFileSync, statSync } from 'node:fs';

export interface DataTable {
  name: string;
  kind: 'table' | 'view';
  estimatedRows: number | null;
  bytes: number | null;
  columns: { name: string; type: string; nullable: boolean; primaryKey: boolean; references: string | null }[];
}
export interface QueryResult { columns: string[]; rows: unknown[][]; truncated: boolean; elapsedMs: number }
export interface TrainingDatabase {
  schema(): Promise<DataTable[]>;
  query(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}
export class DataError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** This connection must never accidentally inherit the ingestion or migration role. */
export function readerUrl(env: NodeJS.ProcessEnv): string | null {
  if (env.ML_DATABASE_URL && env.ML_DATABASE_URL_FILE) throw new Error('Set only one ML database credential source');
  let value = env.ML_DATABASE_URL;
  if (env.ML_DATABASE_URL_FILE) {
    const mode = statSync(env.ML_DATABASE_URL_FILE).mode;
    if (mode & 0o077) throw new Error('ML_DATABASE_URL_FILE must be private (0600)');
    value = readFileSync(env.ML_DATABASE_URL_FILE, 'utf8').trim();
  }
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid ML database connection'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.username !== 'crowdaware_reader'
    || !url.hostname || url.pathname !== '/crowdaware_training' || url.search || url.hash) {
    throw new Error('ML database requires the crowdaware_reader role in crowdaware_training, without URL options');
  }
  return value;
}

export class PostgresTrainingDatabase implements TrainingDatabase {
  private readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000, query_timeout: 12_000, options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000' });
    // A broken idle tunnel is availability, not an uncaught event that kills ingest.
    this.pool.on('error', () => undefined);
  }
  async schema(): Promise<DataTable[]> {
    const tables = await this.pool.query<{ name: string; kind: string; rows: string; bytes: string }>(`
      SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint::text AS rows,
        CASE WHEN c.relkind IN ('r','p') THEN pg_total_relation_size(c.oid)::text END AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='training' AND c.relkind IN ('r','p','v') AND has_table_privilege(c.oid, 'SELECT') ORDER BY c.relname`);
    const columns = await this.pool.query<{ table: string; name: string; type: string; nullable: boolean; pk: boolean; ref: string | null }>(`
      SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
        EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p' AND a.attnum=ANY(k.conkey)) AS pk,
        (SELECT k.confrelid::regclass::text || '.' || fa.attname FROM pg_constraint k
          JOIN pg_attribute fa ON fa.attrelid=k.confrelid AND fa.attnum=k.confkey[array_position(k.conkey,a.attnum)]
          WHERE k.conrelid=c.oid AND k.contype='f' AND a.attnum=ANY(k.conkey) LIMIT 1) AS ref
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='training' AND a.attnum>0 AND NOT a.attisdropped AND has_table_privilege(c.oid, 'SELECT') ORDER BY c.relname,a.attnum`);
    return tables.rows.map(t => ({ name: `training.${t.name}`, kind: t.kind === 'v' ? 'view' : 'table',
      estimatedRows: Number(t.rows) < 0 ? null : Number(t.rows), bytes: t.bytes === null ? null : Number(t.bytes),
      columns: columns.rows.filter(c => c.table === t.name).map(c => ({ name: c.name, type: c.type, nullable: c.nullable, primaryKey: c.pk, references: c.ref })) }));
  }
  async query(sql: string): Promise<QueryResult> {
    if (!sql.trim() || Buffer.byteLength(sql) > 6000) throw new DataError('Enter a query of at most 6,000 bytes.');
    const client = await this.pool.connect();
    const start = Date.now();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      // Extended protocol admits one statement only. A cursor admits SELECT/WITH,
      // never COMMIT/SET/COPY; PostgreSQL read-only mode rejects writable CTEs too.
      const statement = sql.trim().replace(/;\s*$/, '');
      const extended = (text: string) => ({ text, queryMode: 'extended' } as pg.QueryConfig & { queryMode: 'extended' });
      await client.query(extended(`DECLARE ml_shape NO SCROLL CURSOR FOR ${statement}`));
      const shape = await client.query('FETCH FORWARD 0 FROM ml_shape');
      await client.query('CLOSE ml_shape');
      if (shape.fields.length < 1 || shape.fields.length > 100) throw new DataError('Select between 1 and 100 columns.');
      const columns = shape.fields.map(f => f.name);
      const aliases = shape.fields.map((_, i) => `c${i}`);
      // Bound each value inside PostgreSQL before its bytes reach the Node
      // process. Even SELECT * on a large binary frame or repeat() is a preview.
      const preview = shape.fields.map((field, i) => field.dataTypeID === 17
        ? `CASE WHEN c${i} IS NULL THEN NULL ELSE '[binary: ' || octet_length(c${i}) || ' bytes]' END`
        : `CASE WHEN c${i} IS NULL THEN NULL WHEN length(c${i}::text)>4096 THEN left(c${i}::text,4096)||'… [truncated]' ELSE c${i}::text END`);
      await client.query(extended(`DECLARE ml_console NO SCROLL CURSOR FOR SELECT ${preview.join(',')} FROM (${statement}) AS ml_preview(${aliases.join(',')})`));
      const rows: unknown[][] = [];
      let truncated = false, bytes = 0;
      for (let i = 0; i <= 200; i++) {
        const result = await client.query<unknown[]>({ text: 'FETCH FORWARD 1 FROM ml_console', rowMode: 'array' });
        if (!result.rows.length) break;
        const row = result.rows[0];
        if (!row) break;
        const safe = row;
        bytes += Buffer.byteLength(JSON.stringify(safe));
        if (i === 200 || bytes > 1024 * 1024) { truncated = true; break; }
        rows.push(safe);
        if (Date.now() - start > 10_000) { truncated = true; break; }
      }
      return { columns, rows, truncated, elapsedMs: Date.now() - start };
    } catch (error) {
      if (error instanceof DataError) throw error;
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (['25006','42501','42601','42P01','42703','34000','0A000'].includes(code)) throw new DataError('Query refused. Use one SELECT or WITH query and check table and column names.');
      if (code === '57014') throw new DataError('Query exceeded the 10-second limit. Narrow the query and try again.', 408);
      broken = !code || code.startsWith('08') || code.startsWith('57');
      throw new DataError('The training database is unavailable. Try again later.', 503);
    } finally {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      client.release(broken);
    }
  }
  close(): Promise<void> { return this.pool.end(); }
}
