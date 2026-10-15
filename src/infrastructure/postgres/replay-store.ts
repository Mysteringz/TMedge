import type { DataSource } from 'typeorm';
import { ReplayConflictError, ReplayFenceError, type Cursor, type ReplayPersistence } from '../../edge/replay.js';
import type { SiteFence } from './site-leadership.js';

const UID = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const U32_MAX = 0xffffffff;
const u32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= U32_MAX;

interface CursorRow { uid: string; boot: string | number; sequence: string | number }

export { ReplayConflictError as ReplayRejectedError };

/** PostgreSQL write-ahead replay state shared by mutually fenced origins. */
export class PostgresReplayStore implements ReplayPersistence {
  readonly cursors = new Map<string, Cursor>();
  commandSeq = 0;

  private constructor(private readonly source: DataSource, private readonly fenceProvider?: () => SiteFence | null) {}

  static async open(source: DataSource, fenceProvider?: () => SiteFence | null): Promise<PostgresReplayStore> {
    const store = new PostgresReplayStore(source, fenceProvider);
    const rows = await source.query(
      'SELECT uid, boot::text, sequence::text FROM public.ingest_replay_cursors ORDER BY uid LIMIT 5001',
    ) as CursorRow[];
    if (rows.length > 5000) throw new Error('replay cursor node limit exceeded');
    for (const row of rows) {
      const boot = Number(row.boot), sequence = Number(row.sequence);
      if (!UID.test(row.uid) || !u32(boot) || !u32(sequence)) throw new Error('invalid PostgreSQL replay cursor');
      store.cursors.set(row.uid, { boot, seq: sequence });
    }
    const commandRows = await source.query(
      'SELECT sequence::text FROM public.ingest_command_cursor WHERE singleton = true',
    ) as Array<{ sequence: string | number }>;
    const sequence = commandRows[0] ? Number(commandRows[0].sequence) : 0;
    if (!u32(sequence)) throw new Error('invalid PostgreSQL command cursor');
    store.commandSeq = sequence;
    return store;
  }

  accept(): void {
    throw new Error('PostgreSQL replay persistence requires durable asynchronous ingest');
  }

  async acceptAsync(uid: string, cursor: Cursor, commandSeq?: number): Promise<void> {
    this.validate(uid, cursor);
    if (commandSeq !== undefined && !u32(commandSeq)) throw new Error('invalid command cursor');
    const guard = this.guard(5);
    const rows = await this.source.query(`
      WITH ${guard.sql}, cursor_write AS (
        INSERT INTO public.ingest_replay_cursors AS current (uid, boot, sequence, updated_at)
        SELECT $1, $2, $3, statement_timestamp() FROM lease_guard
        ON CONFLICT (uid) DO UPDATE SET
          boot = EXCLUDED.boot, sequence = EXCLUDED.sequence, updated_at = statement_timestamp()
        WHERE EXCLUDED.boot > current.boot
          OR (EXCLUDED.boot = current.boot AND EXCLUDED.sequence > current.sequence)
        RETURNING 1
      ), command_write AS (
        INSERT INTO public.ingest_command_cursor AS current (singleton, sequence, updated_at)
        SELECT true, $4::bigint, statement_timestamp()
        WHERE $4::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM cursor_write)
        ON CONFLICT (singleton) DO UPDATE SET
          sequence = greatest(current.sequence, EXCLUDED.sequence), updated_at = statement_timestamp()
        RETURNING sequence
      )
      SELECT EXISTS (SELECT 1 FROM lease_guard) AS fenced,
        EXISTS (SELECT 1 FROM cursor_write) AS accepted,
        coalesce((SELECT sequence FROM command_write),
          (SELECT sequence FROM public.ingest_command_cursor WHERE singleton = true), 0)::text AS command_sequence
    `, [uid, cursor.boot, cursor.seq, commandSeq ?? null, ...guard.parameters]) as Array<{ fenced: boolean; accepted: boolean; command_sequence: string | number }>;
    const row = rows[0];
    if (!row?.fenced) throw new ReplayFenceError('site leadership changed before replay state committed');
    if (!row?.accepted) throw new ReplayConflictError('replayed or duplicate sequence');
    const durableCommand = Number(row.command_sequence);
    if (!u32(durableCommand)) throw new Error('invalid PostgreSQL command cursor');
    this.cursors.set(uid, { ...cursor });
    this.commandSeq = Math.max(this.commandSeq, durableCommand);
  }

  command(): void {
    throw new Error('PostgreSQL command sequence allocation is asynchronous');
  }

  async allocateCommandSeq(floor: number): Promise<number> {
    if (!u32(floor)) throw new Error('invalid command cursor floor');
    const guard = this.guard(2);
    const rows = await this.source.query(`
      WITH ${guard.sql}, command_write AS (
        INSERT INTO public.ingest_command_cursor AS current (singleton, sequence, updated_at)
        SELECT true, $1, statement_timestamp() FROM lease_guard
        ON CONFLICT (singleton) DO UPDATE SET
          sequence = greatest(EXCLUDED.sequence, current.sequence + 1), updated_at = statement_timestamp()
        RETURNING sequence::text
      )
      SELECT EXISTS (SELECT 1 FROM lease_guard) AS fenced,
        (SELECT sequence FROM command_write) AS sequence
    `, [floor, ...guard.parameters]) as Array<{ fenced: boolean; sequence: string | number | null }>;
    if (!rows[0]?.fenced) throw new ReplayFenceError('site leadership changed before command allocation');
    const sequence = rows[0] ? Number(rows[0].sequence) : NaN;
    if (!u32(sequence)) throw new Error('command sequence exhausted');
    this.commandSeq = Math.max(this.commandSeq, sequence);
    return sequence;
  }

  reset(): boolean {
    throw new Error('PostgreSQL replay cursor reset is asynchronous');
  }

  async resetAsync(uid: string): Promise<boolean> {
    if (!UID.test(uid)) throw new Error('invalid node uid');
    const guard = this.guard(2);
    const rows = await this.source.query(`
      WITH ${guard.sql}, deleted AS (
        DELETE FROM public.ingest_replay_cursors
        WHERE uid = $1 AND EXISTS (SELECT 1 FROM lease_guard)
        RETURNING uid
      )
      SELECT EXISTS (SELECT 1 FROM lease_guard) AS fenced,
        EXISTS (SELECT 1 FROM deleted) AS reset
    `, [uid, ...guard.parameters]) as Array<{ fenced: boolean; reset: boolean }>;
    if (!rows[0]?.fenced) throw new ReplayFenceError('site leadership changed before cursor reset');
    this.cursors.delete(uid);
    return rows[0]?.reset === true;
  }

  private validate(uid: string, cursor: Cursor): void {
    if (!UID.test(uid) || !u32(cursor.boot) || !u32(cursor.seq)) throw new Error('invalid replay cursor');
  }

  private guard(firstParameter: number): { sql: string; parameters: string[] } {
    if (!this.fenceProvider) return { sql: 'lease_guard AS MATERIALIZED (SELECT 1)', parameters: [] };
    const fence = this.fenceProvider();
    if (!fence) throw new ReplayFenceError('site leadership is not active');
    return {
      sql: `lease_guard AS MATERIALIZED (
        SELECT 1 FROM public.site_leadership
        WHERE site_id = $${firstParameter} AND origin_id = $${firstParameter + 1}
          AND holder_id = $${firstParameter + 2}::uuid AND generation = $${firstParameter + 3}::bigint
          AND lease_until > statement_timestamp()
        FOR UPDATE
      )`,
      parameters: [fence.siteId, fence.originId, fence.holderId, fence.generation],
    };
  }
}
