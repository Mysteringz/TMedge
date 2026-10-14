import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DataSource } from 'typeorm';

const SITE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ORIGIN_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface SiteIdentity {
  siteId: string;
  originId: string;
}

export interface SiteLeaseConfig extends SiteIdentity {
  ttlMs: number;
  renewMs: number;
}

export interface SiteFence extends SiteIdentity {
  holderId: string;
  generation: string;
}

export class SiteLeadershipError extends Error {}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SiteLeadershipError(`${key} must be an integer ${min}..${max}`);
  }
  return value;
}

/** Both values are required together; omitting both keeps legacy single-origin behaviour. */
export function loadSiteIdentity(env: NodeJS.ProcessEnv = process.env): SiteIdentity | null {
  const siteId = env.FAILOVER_SITE_ID?.trim() ?? '';
  const originId = env.FAILOVER_ORIGIN_ID?.trim() ?? '';
  if (!siteId && !originId) return null;
  if (!SITE_ID.test(siteId)) throw new SiteLeadershipError('FAILOVER_SITE_ID must be 1-64 lowercase letters, digits, dots, underscores or hyphens');
  if (!ORIGIN_ID.test(originId)) throw new SiteLeadershipError('FAILOVER_ORIGIN_ID must be 1-64 lowercase letters, digits, dots, underscores or hyphens');
  return { siteId, originId };
}

export function loadSiteLeaseConfig(env: NodeJS.ProcessEnv = process.env): SiteLeaseConfig | null {
  const identity = loadSiteIdentity(env);
  if (!identity) return null;
  const ttlMs = boundedInteger(env, 'FAILOVER_LEASE_TTL_MS', 15_000, 5_000, 120_000);
  const renewMs = boundedInteger(env, 'FAILOVER_LEASE_RENEW_MS', Math.floor(ttlMs / 3), 1_000, 60_000);
  if (renewMs * 2 >= ttlMs) throw new SiteLeadershipError('FAILOVER_LEASE_RENEW_MS must be less than half FAILOVER_LEASE_TTL_MS');
  return { ...identity, ttlMs, renewMs };
}

interface LeaseRow {
  generation: string | number;
  remaining_ms: string | number;
}

function leaseRow(value: unknown): LeaseRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<LeaseRow>;
  if (!['string', 'number'].includes(typeof row.generation) || !['string', 'number'].includes(typeof row.remaining_ms)) return null;
  return row as LeaseRow;
}

export interface ActiveSiteLease {
  readonly identity: SiteIdentity;
  start(onLost: () => void): Promise<boolean>;
  active(): boolean;
  fence?(): SiteFence | null;
  stop(): Promise<void>;
}

/**
 * One origin owns all stateful traffic for a site. PostgreSQL time decides
 * expiry, so disagreeing host clocks cannot create two leaders.
 */
export class PostgresSiteLease implements ActiveSiteLease {
  readonly identity: SiteIdentity;
  private readonly holderId: string;
  private generation: string | null = null;
  private safeUntil = -Infinity;
  private renewTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private onLost: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly source: DataSource, private readonly config: SiteLeaseConfig, holderId = randomUUID()) {
    this.identity = { siteId: config.siteId, originId: config.originId };
    this.holderId = holderId;
  }

  async start(onLost: () => void): Promise<boolean> {
    if (this.stopped || this.generation !== null) throw new SiteLeadershipError('site lease has already been started');
    this.onLost = onLost;
    const rows = await this.source.query(`
      INSERT INTO public.site_leadership AS current
        (site_id, origin_id, holder_id, generation, lease_until, acquired_at, renewed_at)
      VALUES ($1, $2, $3, 1, statement_timestamp() + ($4 * interval '1 millisecond'), statement_timestamp(), statement_timestamp())
      ON CONFLICT (site_id) DO UPDATE SET
        origin_id = EXCLUDED.origin_id,
        holder_id = EXCLUDED.holder_id,
        generation = CASE
          WHEN current.holder_id = EXCLUDED.holder_id AND current.lease_until > statement_timestamp() THEN current.generation
          ELSE current.generation + 1
        END,
        lease_until = statement_timestamp() + ($4 * interval '1 millisecond'),
        acquired_at = CASE
          WHEN current.holder_id = EXCLUDED.holder_id AND current.lease_until > statement_timestamp() THEN current.acquired_at
          ELSE statement_timestamp()
        END,
        renewed_at = statement_timestamp()
      WHERE current.lease_until <= statement_timestamp() OR current.holder_id = EXCLUDED.holder_id
      RETURNING generation::text, greatest(0, extract(epoch FROM (lease_until - clock_timestamp())) * 1000)::float8 AS remaining_ms
    `, [this.config.siteId, this.config.originId, this.holderId, this.config.ttlMs]) as unknown;
    const row = Array.isArray(rows) ? leaseRow(rows[0]) : null;
    if (!row) return false;
    this.accept(row);
    this.scheduleRenewal();
    return true;
  }

  active(): boolean {
    return !this.stopped && this.generation !== null && performance.now() < this.safeUntil;
  }

  fence(): SiteFence | null {
    if (!this.active() || this.generation === null) return null;
    return { ...this.identity, holderId: this.holderId, generation: this.generation };
  }

  private accept(row: LeaseRow): void {
    const remainingMs = Number(row.remaining_ms);
    const generation = String(row.generation);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || !/^\d+$/.test(generation)) {
      throw new SiteLeadershipError('database returned an invalid site lease');
    }
    this.generation = generation;
    // Stop locally before PostgreSQL can permit a successor. The margin also
    // covers timer scheduling jitter and the round trip that returned this row.
    const margin = Math.max(250, Math.min(1_000, Math.floor(this.config.ttlMs / 10)));
    this.safeUntil = performance.now() + Math.max(1, remainingMs - margin);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.lose(), Math.max(1, this.safeUntil - performance.now()));
    this.expiryTimer.unref();
  }

  private scheduleRenewal(delay = this.config.renewMs): void {
    if (this.stopped || this.generation === null) return;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => { void this.renew(); }, delay);
    this.renewTimer.unref();
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.generation === null) return;
    try {
      const rows = await this.source.query(`
        UPDATE public.site_leadership
        SET lease_until = statement_timestamp() + ($5 * interval '1 millisecond'), renewed_at = statement_timestamp()
        WHERE site_id = $1 AND origin_id = $2 AND holder_id = $3
          AND generation = $4::bigint AND lease_until > statement_timestamp()
        RETURNING generation::text, greatest(0, extract(epoch FROM (lease_until - clock_timestamp())) * 1000)::float8 AS remaining_ms
      `, [this.config.siteId, this.config.originId, this.holderId, this.generation, this.config.ttlMs]) as unknown;
      const row = Array.isArray(rows) ? leaseRow(rows[0]) : null;
      if (!row) return this.lose();
      this.accept(row);
      this.scheduleRenewal();
    } catch {
      // A short database interruption may recover inside the already-issued
      // lease. Never extend the local deadline without a successful renewal.
      const remaining = this.safeUntil - performance.now();
      if (remaining <= 0) return this.lose();
      this.scheduleRenewal(Math.max(100, Math.min(500, Math.floor(remaining / 2))));
    }
  }

  private lose(): void {
    if (this.stopped || this.generation === null) return;
    this.generation = null;
    this.safeUntil = -Infinity;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.renewTimer = null;
    this.expiryTimer = null;
    const notify = this.onLost;
    this.onLost = null;
    notify?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const generation = this.generation;
    this.generation = null;
    this.safeUntil = -Infinity;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.renewTimer = null;
    this.expiryTimer = null;
    if (generation === null || !this.source.isInitialized) return;
    await this.source.query(`
      UPDATE public.site_leadership
      SET lease_until = statement_timestamp(), renewed_at = statement_timestamp()
      WHERE site_id = $1 AND origin_id = $2 AND holder_id = $3 AND generation = $4::bigint
    `, [this.config.siteId, this.config.originId, this.holderId, generation]).catch(() => undefined);
  }
}

/** Current database ownership check used by the student tier and health endpoints. */
export interface SiteTrafficGuard {
  active(): Promise<boolean>;
}

export class PostgresSiteTrafficGuard implements SiteTrafficGuard {
  constructor(private readonly source: DataSource, readonly identity: SiteIdentity) {}

  async active(): Promise<boolean> {
    if (!this.source.isInitialized) return false;
    try {
      const rows = await this.source.query(`
        SELECT EXISTS (
          SELECT 1 FROM public.site_leadership
          WHERE site_id = $1 AND origin_id = $2 AND lease_until > clock_timestamp()
        ) AS active
      `, [this.identity.siteId, this.identity.originId]) as unknown;
      if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return false;
      return (rows[0] as { active?: unknown }).active === true;
    } catch {
      return false;
    }
  }
}
