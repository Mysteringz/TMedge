import type { DataSource } from 'typeorm';
import type { HelloReplayPersistence } from '../../edge/hello-replay.js';
import { ReplayFenceError } from '../../edge/replay.js';
import type { SiteFence } from './site-leadership.js';

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const NONCE = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOW_MS = 60_000;

/** Gateway handshake replay admission, serialized with site leadership. */
export class PostgresHelloReplayStore implements HelloReplayPersistence {
  constructor(private readonly source: DataSource, private readonly fenceProvider?: () => SiteFence | null) {}

  async accept(id: string, nonce: string, expires: number, _now: number): Promise<boolean> {
    if (!ID.test(id) || !NONCE.test(nonce) || !Number.isSafeInteger(expires) || expires < 0) return false;
    const runner = this.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      let clockRows: Array<{ now_ms: string | number }>;
      if (this.fenceProvider) {
        const fence = this.fenceProvider();
        if (!fence) throw new ReplayFenceError('site leadership is not active');
        clockRows = await runner.query(`
          SELECT extract(epoch FROM statement_timestamp()) * 1000 AS now_ms
          FROM public.site_leadership
          WHERE site_id = $1 AND origin_id = $2 AND holder_id = $3::uuid
            AND generation = $4::bigint AND lease_until > statement_timestamp()
          FOR UPDATE
        `, [fence.siteId, fence.originId, fence.holderId, fence.generation]) as Array<{ now_ms: string | number }>;
        if (!clockRows[0]) throw new ReplayFenceError('site leadership changed before gateway admission');
      } else {
        clockRows = await runner.query(
          'SELECT extract(epoch FROM statement_timestamp()) * 1000 AS now_ms',
        ) as Array<{ now_ms: string | number }>;
      }
      const databaseNow = Number(clockRows[0]?.now_ms);
      const helloAt = expires - WINDOW_MS;
      if (!Number.isFinite(databaseNow) || Math.abs(databaseNow - helloAt) > WINDOW_MS || expires <= databaseNow) {
        await runner.rollbackTransaction();
        return false;
      }
      await runner.query('DELETE FROM public.gateway_hello_replays WHERE expires_at < statement_timestamp()');
      const counts = await runner.query(
        'SELECT count(*)::int AS count FROM public.gateway_hello_replays WHERE expires_at >= statement_timestamp()',
      ) as Array<{ count: number }>;
      if ((counts[0]?.count ?? 4096) >= 4096) {
        await runner.rollbackTransaction();
        return false;
      }
      const rows = await runner.query(`
        INSERT INTO public.gateway_hello_replays (gateway_id, nonce, expires_at, accepted_at)
        VALUES ($1, $2, to_timestamp($3::double precision / 1000.0), statement_timestamp())
        ON CONFLICT (gateway_id, nonce) DO NOTHING
        RETURNING gateway_id
      `, [id, nonce, expires]) as Array<{ gateway_id: string }>;
      await runner.commitTransaction();
      return rows.length === 1;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
  }
}
