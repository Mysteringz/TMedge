import type { DataSource } from 'typeorm';
import type { HelloReplaySnapshot } from '../../edge/hello-replay.js';
import type { ReplaySnapshot } from '../../edge/replay.js';

const SITE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export class ReplayImportError extends Error {}

export interface ReplayImportResult {
  nodeCursors: number;
  commandSequence: number;
  liveGatewayNonces: number;
}

/**
 * Monotonically seeds shared replay state while no site leader is active.
 * Repeating the import is safe and can only raise durable high-water marks.
 */
export async function importLegacyReplayState(
  source: DataSource,
  siteId: string,
  replay: ReplaySnapshot,
  hellos: HelloReplaySnapshot,
): Promise<ReplayImportResult> {
  if (!SITE_ID.test(siteId)) throw new ReplayImportError('FAILOVER_SITE_ID is invalid');
  const cursorRows = [...replay.cursors].map(([uid, cursor]) => ({ uid, boot: cursor.boot, sequence: cursor.seq }));
  const helloRows = hellos.nonces.map(([key, expires]) => {
    const separator = key.indexOf('|');
    if (separator < 1) throw new ReplayImportError('gateway replay snapshot is invalid');
    return { gateway_id: key.slice(0, separator), nonce: key.slice(separator + 1), expires };
  });
  const runner = source.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('SERIALIZABLE');
  try {
    // Lease acquisition writes this table, so this lock closes the gap between
    // checking for an owner and committing all imported high-water marks.
    await runner.query('LOCK TABLE public.site_leadership IN SHARE ROW EXCLUSIVE MODE');
    const activeRows = await runner.query(`
      SELECT EXISTS (
        SELECT 1 FROM public.site_leadership
        WHERE site_id = $1 AND lease_until > statement_timestamp()
      ) AS active
    `, [siteId]) as Array<{ active: boolean }>;
    if (activeRows[0]?.active) throw new ReplayImportError('stop the active site owner before importing replay state');

    if (cursorRows.length) {
      await runner.query(`
        INSERT INTO public.ingest_replay_cursors AS current (uid, boot, sequence, updated_at)
        SELECT incoming.uid, incoming.boot, incoming.sequence, statement_timestamp()
        FROM jsonb_to_recordset($1::jsonb) AS incoming(uid text, boot bigint, sequence bigint)
        ON CONFLICT (uid) DO UPDATE SET
          boot = EXCLUDED.boot, sequence = EXCLUDED.sequence, updated_at = statement_timestamp()
        WHERE EXCLUDED.boot > current.boot
          OR (EXCLUDED.boot = current.boot AND EXCLUDED.sequence > current.sequence)
      `, [JSON.stringify(cursorRows)]);
    }
    await runner.query(`
      INSERT INTO public.ingest_command_cursor AS current (singleton, sequence, updated_at)
      VALUES (true, $1, statement_timestamp())
      ON CONFLICT (singleton) DO UPDATE SET
        sequence = greatest(current.sequence, EXCLUDED.sequence), updated_at = statement_timestamp()
    `, [replay.commandSeq]);

    await runner.query('DELETE FROM public.gateway_hello_replays WHERE expires_at < statement_timestamp()');
    if (helloRows.length) {
      await runner.query(`
        INSERT INTO public.gateway_hello_replays AS current (gateway_id, nonce, expires_at, accepted_at)
        SELECT incoming.gateway_id, incoming.nonce,
          to_timestamp(incoming.expires::double precision / 1000.0), statement_timestamp()
        FROM jsonb_to_recordset($1::jsonb) AS incoming(gateway_id text, nonce text, expires bigint)
        WHERE to_timestamp(incoming.expires::double precision / 1000.0) > statement_timestamp()
        ON CONFLICT (gateway_id, nonce) DO UPDATE SET
          expires_at = greatest(current.expires_at, EXCLUDED.expires_at)
      `, [JSON.stringify(helloRows)]);
    }
    const nonceCounts = await runner.query(`
      SELECT count(*)::int AS count FROM public.gateway_hello_replays
      WHERE expires_at >= statement_timestamp()
    `) as Array<{ count: number }>;
    const liveGatewayNonces = nonceCounts[0]?.count;
    if (typeof liveGatewayNonces !== 'number' || !Number.isInteger(liveGatewayNonces) || liveGatewayNonces < 0 || liveGatewayNonces > 4096) {
      throw new ReplayImportError('gateway replay capacity would be exceeded');
    }
    await runner.commitTransaction();
    return { nodeCursors: cursorRows.length, commandSequence: replay.commandSeq, liveGatewayNonces };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
    throw error;
  } finally {
    await runner.release();
  }
}
