import { randomUUID } from 'node:crypto';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { loadPostgresConfig } from '../infrastructure/postgres/config.js';
import { PostgresSiteLease, PostgresSiteTrafficGuard } from '../infrastructure/postgres/site-leadership.js';
import type { DataSource } from 'typeorm';

const siteId = `rehearsal-${Date.now().toString(36)}-${process.pid}`;
const config = loadPostgresConfig();
let primarySource: DataSource | null = null;
let standbySource: DataSource | null = null;

try {
  primarySource = await openPostgres(config.runtime);
  standbySource = await openPostgres(config.runtime);
  let primaryLost = false;
  const primary = new PostgresSiteLease(primarySource, {
    siteId, originId: 'rehearsal-primary', ttlMs: 5_000, renewMs: 1_000,
  }, randomUUID());
  const standby = new PostgresSiteLease(standbySource, {
    siteId, originId: 'rehearsal-standby', ttlMs: 5_000, renewMs: 1_000,
  }, randomUUID());

  if (!await primary.start(() => { primaryLost = true; })) throw new Error('primary did not acquire an unused rehearsal lease');
  if (await standby.start(() => undefined)) throw new Error('standby bypassed a live primary');
  const primaryGuard = new PostgresSiteTrafficGuard(standbySource, { siteId, originId: 'rehearsal-primary' });
  const standbyGuard = new PostgresSiteTrafficGuard(standbySource, { siteId, originId: 'rehearsal-standby' });
  if (!await primaryGuard.active() || await standbyGuard.active()) throw new Error('traffic guards disagreed with the primary lease');

  // Closing the primary pool without releasing its lease models an abrupt
  // origin/database-path failure rather than a graceful operator switchover.
  await closePostgres(primarySource);
  primarySource = null;
  await new Promise((resolve) => setTimeout(resolve, 5_300));
  if (!primaryLost) throw new Error('the primary local expiry watchdog did not fire');
  if (!await standby.start(() => undefined)) throw new Error('standby did not acquire after database expiry');
  const rows = await standbySource.query(
    'SELECT origin_id, generation::int AS generation FROM public.site_leadership WHERE site_id = $1', [siteId],
  ) as Array<{ origin_id: string; generation: number }>;
  if (rows[0]?.origin_id !== 'rehearsal-standby' || rows[0].generation !== 2) {
    throw new Error('takeover did not advance the fencing generation');
  }
  if (await primaryGuard.active() || !await standbyGuard.active()) throw new Error('traffic guards did not move with the lease');
  await standby.stop();
  process.stdout.write('PASS: live owner fenced standby; expiry stopped the old owner; standby took generation 2\n');
} catch {
  process.stderr.write('Failover lease rehearsal failed; connection details were suppressed.\n');
  process.exitCode = 1;
} finally {
  if (standbySource?.isInitialized) {
    await standbySource.query('DELETE FROM public.site_leadership WHERE site_id = $1', [siteId]).catch(() => undefined);
    await closePostgres(standbySource).catch(() => undefined);
  }
  if (primarySource?.isInitialized) await closePostgres(primarySource).catch(() => undefined);
}
