/**
 * The web tier's own account of how HKUMySeat is being used.
 *
 * It lives in the web process because that is where students are: their
 * requests, their sign-ins, their open live views. It keeps counts, never
 * rows about a person -- the one thing that is per-student is a keyed hash
 * used to tell "different students today" from "the same student twice"
 * (distinct-days.ts). The edge reads the result with its push token and the
 * algo console draws it (module 05).
 *
 * It works the same whether accounts are in users.json or PostgreSQL. The
 * durable per-event activity log, where one is configured, is separate and
 * untouched.
 *
 * It is called from inside sign-in and search handlers, so its three entry
 * points (`request`, `event`, `sample`) swallow their own failures: a fault
 * in the counting must never become a failed request for a student.
 */
import { createHmac } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  dayKey, RANGE_SPECS,
  type AnalyticsRangeId, type CounterFrame, type RouteGroupUsage, type StudentUsageReport, type UsageTotals,
} from '../../../shared/analytics.js';
import type { StudentActivityDetails } from '../../../shared/student-activity.js';
import { BucketLog } from '../../../infrastructure/analytics/bucket-log.js';
import { CounterLog } from './counter-log.js';
import { DistinctDays } from './distinct-days.js';
import { MetricHistory } from './metric-history.js';

/** What an auth or usage handler tells the meter. Mirrors the activity log's vocabulary. */
export interface UsageEventSink {
  event(action: string, outcome: string, details?: StudentActivityDetails): void;
}

export interface UsageMeterOptions {
  /** Where history is kept; null keeps it in memory only (tests, a tier with no data directory). */
  dir: string | null;
  timeZone: string;
  /** Any secret of this web tier: the hashing key is derived from it and never stored. */
  secret: Buffer;
  /** Who is connected to the live view right now. Emails are hashed here and go no further. */
  live(): { sockets: number; emails: Iterable<string> };
  now?: () => number;
  sampleMs?: number;
}

export interface UsageReportContext {
  accountsTotal: number | null;
  /** When each account was created, if the store can say; no identities. */
  accountCreatedTimes: number[] | null;
  accountStorage: 'file' | 'postgres';
  floorName(floorId: string): string | null;
  tableName(floorId: string, tableId: string): string | null;
  edges: { edgeId: string; ageMs: number }[];
}

const ACTIONS = ['signup', 'login', 'logout', 'seat-search', 'space-view', 'table-select', 'directions-view'];
const OUTCOMES = ['succeeded', 'failed', 'rate-limited'];
const GROUPS = ['pages', 'sign-in', 'occupancy', 'search', 'activity', 'assets', 'other'] as const;
type RouteGroup = typeof GROUPS[number] | 'edge' | 'health';

/**
 * A request's path reduced to one of a handful of names. Raw paths are never
 * counted: they would grow without bound and can carry what a student typed.
 */
export function routeGroup(method: string, path: string): RouteGroup {
  if (path.startsWith('/api/edge/')) return 'edge';
  if (path === '/healthz' || path === '/readyz') return 'health';
  if (path === '/api/occupancy') return 'occupancy';
  if (path === '/api/search') return 'search';
  if (path === '/api/activity') return 'activity';
  if (path.startsWith('/api/auth/') || path.startsWith('/auth/') || path === '/logout'
    || (method !== 'GET' && method !== 'HEAD' && (path === '/login' || path === '/signup'))) return 'sign-in';
  if (path.startsWith('/app/') || path.startsWith('/assets/') || path.startsWith('/vendor/') || /\.[a-z0-9]{2,5}$/i.test(path)) return 'assets';
  if (path === '/' || path.startsWith('/login') || path.startsWith('/signup') || path.startsWith('/dashboard')
    || path.startsWith('/search') || path.startsWith('/spaces')) return 'pages';
  return 'other';
}

export class UsageMeter implements UsageEventSink {
  private readonly log: BucketLog;
  private readonly gauges: MetricHistory;
  private readonly counters: CounterLog;
  private readonly days: DistinctDays;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly now: () => number;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | null = null;
  private closed: Promise<void> | null = null;
  // What has happened since the last sample.
  private windowStart: number;
  private windowRequests = 0;
  private windowErrors = 0;
  private windowLatency: number[] = [];
  private lastPresenceMinute = -1;
  /** Counting faults swallowed so far; never surfaced to a student. */
  faults = 0;

  constructor(private readonly options: UsageMeterOptions) {
    this.now = options.now ?? Date.now;
    const now = this.now();
    this.startedAt = now;
    this.windowStart = now;
    this.log = new BucketLog(options.dir);
    this.gauges = new MetricHistory('web', this.log, now);
    this.counters = new CounterLog('web', this.log, now);
    // Derived, so the file of hashes is useless without a secret that is not in it.
    const key = createHmac('sha256', options.secret).update('tmedge usage analytics v1').digest();
    this.days = new DistinctDays('web', this.log, options.timeZone, key, now);
    this.loop.enable();
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.sample(), this.options.sampleMs ?? 10_000);
    this.timer.unref();
  }

  /** One finished HTTP response. `email` is set only when the request was an authenticated student's. */
  request(method: string, path: string, status: number, durationMs: number, email?: string): void {
    try { this.countRequest(method, path, status, durationMs, email); } catch { this.faults += 1; }
  }

  private countRequest(method: string, path: string, status: number, durationMs: number, email?: string): void {
    const now = this.now();
    if (email) this.days.mark(now, email);
    const group = routeGroup(method, path);
    // The edge's pushes and health probes are machines talking, not students.
    if (group === 'edge' || group === 'health') return;
    const cls = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
    this.counters.add(now, `req.${group}.${cls}`);
    this.counters.add(now, 'req.all');
    if (cls === '4xx' || cls === '5xx') { this.counters.add(now, `req.${cls}`); this.windowErrors += 1; }
    this.windowRequests += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0 && this.windowLatency.length < 5000) this.windowLatency.push(durationMs);
  }

  event(action: string, outcome: string, details?: StudentActivityDetails): void {
    try { this.countEvent(action, outcome, details); } catch { this.faults += 1; }
  }

  private countEvent(action: string, outcome: string, details?: StudentActivityDetails): void {
    if (!ACTIONS.includes(action) || !OUTCOMES.includes(outcome)) return;
    const now = this.now();
    this.counters.add(now, `act.${action}.${outcome}`);
    if (outcome !== 'succeeded' || !details) return;
    if (action === 'seat-search') {
      if (typeof details.seats === 'number') this.counters.add(now, `party.${details.seats >= 6 ? '6+' : details.seats}`);
      if (details.resultCount === 0) this.counters.add(now, 'search.none');
      if (details.liveData === false) this.counters.add(now, 'search.stale');
    } else if (action === 'space-view' && details.floorId) {
      this.counters.add(now, `floor.${details.floorId}`);
    } else if (action === 'table-select' && details.floorId && details.tableId) {
      this.counters.add(now, `table.${details.floorId}/${details.tableId}`);
    }
  }

  /** Called on a timer; public so a test can drive time itself. */
  sample(): void {
    try { this.takeSample(); } catch { this.faults += 1; }
  }

  private takeSample(): void {
    const now = this.now();
    const live = this.options.live();
    const emails = new Set(live.emails);
    // Someone who leaves the live view open overnight makes no new request,
    // but is still using the site that day.
    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastPresenceMinute) {
      this.lastPresenceMinute = minute;
      for (const email of emails) this.days.mark(now, email);
    }
    const seconds = Math.max(1, (now - this.windowStart) / 1000);
    const latency = this.windowLatency.sort((a, b) => a - b);
    const memory = process.memoryUsage();
    const lag = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    this.gauges.record(now, {
      'online.sockets': live.sockets,
      'online.students': emails.size,
      // Zero is a real reading here: the tier is up and nobody asked for anything.
      'req.rate': this.windowRequests / seconds * 60,
      'err.rate': this.windowErrors / seconds * 60,
      'lat.p50': percentile(latency, 0.5),
      'lat.p95': percentile(latency, 0.95),
      'proc.rss': memory.rss,
      'proc.heap': memory.heapUsed,
      'proc.lag': lag,
    });
    this.windowStart = now;
    this.windowRequests = 0;
    this.windowErrors = 0;
    this.windowLatency = [];
    this.counters.tick(now);
    this.days.tick(now);
  }

  report(rangeId: AnalyticsRangeId, context: UsageReportContext): StudentUsageReport {
    const now = this.now();
    const spec = RANGE_SPECS[rangeId];
    const from = now - spec.spanMs;
    // Ranges are half-open; this one runs up to and including this instant.
    const end = now + 1;
    const live = this.options.live();
    const frame = (keys: { key: string; label: string }[]): CounterFrame => spec.counterStepMs > 0
      ? this.counters.frame(spec.counterTier, from, end, spec.counterStepMs, keys)
      : this.counters.daily(from, end, this.options.timeZone, keys);
    const earliest = [this.counters.earliest, this.gauges.earliest].filter((v): v is number => v !== null);
    const collectingSince = earliest.length > 0 ? Math.min(...earliest) : null;
    const previousRetained = this.counters.earliest !== null && this.counters.earliest <= from - spec.spanMs
      && (spec.counterTier !== 'fine' || spec.spanMs * 2 <= 48 * 3_600_000);
    const memory = process.memoryUsage();
    return {
      version: 1,
      generatedAt: now,
      timezone: this.options.timeZone,
      collectingSince,
      range: { id: rangeId, from, to: now },
      live: { sockets: live.sockets, students: new Set(live.emails).size },
      accounts: {
        total: context.accountsTotal,
        createdPerDay: context.accountCreatedTimes ? this.createdPerDay(context.accountCreatedTimes, now, Math.min(30, Math.max(7, Math.ceil(spec.spanMs / 86_400_000)))) : null,
      },
      active: {
        today: this.days.count(dayKey(now, this.options.timeZone)),
        yesterday: this.days.count(dayKey(now - 86_400_000, this.options.timeZone)),
        last7Days: this.days.across(7, now),
        last30Days: this.days.across(30, now),
        perDay: this.days.perDay(Math.min(30, Math.max(7, Math.ceil(spec.spanMs / 86_400_000))), now),
      },
      totals: this.totals(spec.counterTier, from, end),
      previousTotals: previousRetained ? this.totals(spec.counterTier, from - spec.spanMs, floor(from, spec.counterTier)) : null,
      activity: frame([
        { key: 'act.seat-search.succeeded', label: 'Seat searches' },
        { key: 'act.space-view.succeeded', label: 'Space views' },
        { key: 'act.table-select.succeeded', label: 'Table selections' },
        { key: 'act.directions-view.succeeded', label: 'Directions views' },
      ]),
      signIns: frame([
        { key: 'act.login.succeeded', label: 'Signed in' },
        { key: 'act.login.failed', label: 'Failed' },
        { key: 'act.login.rate-limited', label: 'Rate limited' },
      ]),
      partySizes: this.partySizes(spec.counterTier, from, end),
      topFloors: top(this.counters.sumByPrefix(spec.counterTier, from, end, 'floor.'), 8)
        .map(([floorId, views]) => ({ floorId, name: context.floorName(floorId) ?? floorId, views })),
      topTables: top(this.counters.sumByPrefix(spec.counterTier, from, end, 'table.'), 8).map(([key, selects]) => {
        const [floorId = '', tableId = ''] = key.split('/');
        return { floorId, tableId, name: context.tableName(floorId, tableId) ?? tableId, selects };
      }),
      routeGroups: this.routeGroups(spec.counterTier, from, end),
      online: this.gauges.frame(spec.gaugeTier, from, end, spec.gaugeStepMs, [
        { key: 'online.students', label: 'Students online' },
        { key: 'online.sockets', label: 'Open live views' },
      ]),
      requests: this.gauges.frame(spec.gaugeTier, from, end, spec.gaugeStepMs, [
        { key: 'req.rate', label: 'Requests' },
        { key: 'err.rate', label: 'Errors' },
      ]),
      latency: this.gauges.frame(spec.gaugeTier, from, end, spec.gaugeStepMs, [
        { key: 'lat.p50', label: 'Median' },
        { key: 'lat.p95', label: '95th percentile' },
      ]),
      process: {
        startedAt: this.startedAt,
        uptimeS: Math.round((now - this.startedAt) / 1000),
        rssBytes: memory.rss,
        heapBytes: memory.heapUsed,
        eventLoopLagMs: this.gauges.latest('proc.lag', now) ?? 0,
        node: process.version,
        accountStorage: context.accountStorage,
        edges: context.edges,
      },
    };
  }

  private totals(tier: 'fine' | 'hour', from: number, to: number): UsageTotals {
    const sum = (key: string) => this.counters.sum(tier, floor(from, tier), to, key);
    return {
      searches: sum('act.seat-search.succeeded'),
      noResultSearches: sum('search.none'),
      staleDataSearches: sum('search.stale'),
      spaceViews: sum('act.space-view.succeeded'),
      tableSelects: sum('act.table-select.succeeded'),
      directionsViews: sum('act.directions-view.succeeded'),
      signIns: sum('act.login.succeeded'),
      failedSignIns: sum('act.login.failed'),
      rateLimitedSignIns: sum('act.login.rate-limited'),
      signUps: sum('act.signup.succeeded'),
      signOuts: sum('act.logout.succeeded'),
      requests: sum('req.all'),
      clientErrors: sum('req.4xx'),
      serverErrors: sum('req.5xx'),
    };
  }

  private partySizes(tier: 'fine' | 'hour', from: number, to: number): { seats: string; searches: number }[] {
    const counts = this.counters.sumByPrefix(tier, floor(from, tier), to, 'party.');
    return ['1', '2', '3', '4', '5', '6+'].map((seats) => ({ seats, searches: counts.get(seats) ?? 0 }));
  }

  private routeGroups(tier: 'fine' | 'hour', from: number, to: number): RouteGroupUsage[] {
    const rows = new Map<string, RouteGroupUsage>(GROUPS.map((group) => [group, { group, requests: 0, clientErrors: 0, serverErrors: 0 }]));
    for (const [key, value] of this.counters.sumByPrefix(tier, floor(from, tier), to, 'req.')) {
      const at = key.lastIndexOf('.');
      const row = at > 0 ? rows.get(key.slice(0, at)) : undefined;
      if (!row) continue;
      row.requests += value;
      if (key.endsWith('.4xx')) row.clientErrors += value;
      if (key.endsWith('.5xx')) row.serverErrors += value;
    }
    return [...rows.values()].filter((row) => row.requests > 0).sort((a, b) => b.requests - a.requests);
  }

  private createdPerDay(times: number[], now: number, days: number): { day: string; created: number; total: number }[] {
    const zone = this.options.timeZone;
    const byDay = new Map<string, number>();
    for (const at of times) byDay.set(dayKey(at, zone), (byDay.get(dayKey(at, zone)) ?? 0) + 1);
    const out: { day: string; created: number; total: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayKey(now - i * 86_400_000, zone);
      // Day keys sort as dates, so "created on or before" is a string compare.
      let total = 0;
      for (const [key, count] of byDay) if (key <= day) total += count;
      out.push({ day, created: byDay.get(day) ?? 0, total });
    }
    return out;
  }

  /** Stop sampling and write out what is in progress. Safe to call twice. */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
    const now = this.now();
    this.closed = Promise.all([this.gauges.close(), this.counters.close(now), this.days.close(now)]).then(() => undefined);
    return this.closed;
  }
}

/** Buckets are whole steps, so a range that starts mid-bucket takes that bucket too. */
function floor(at: number, tier: 'fine' | 'hour'): number {
  const step = tier === 'fine' ? 300_000 : 3_600_000;
  return Math.floor(at / step) * step;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

function top(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}
