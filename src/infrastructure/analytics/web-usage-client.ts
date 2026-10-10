/**
 * Asks the web tier for its usage report, as the edge.
 *
 * The same direction and the same credential as a snapshot push: the edge
 * calls out, the web tier never calls in. What comes back is rebuilt field
 * by field before it goes anywhere near a browser -- another process wrote
 * it, so its shape is checked rather than trusted.
 */
import {
  isAnalyticsRange,
  type AnalyticsRangeId, type CounterFrame, type SeriesFrame, type StudentUsageReport, type UsageTotals,
} from '../../shared/analytics.js';

const MAX_POINTS = 800;

export class WebUsageClient {
  private readonly cache = new Map<AnalyticsRangeId, { at: number; value: StudentUsageReport }>();
  private readonly inFlight = new Map<AnalyticsRangeId, Promise<StudentUsageReport>>();

  constructor(
    private readonly targets: readonly string[], private readonly token: string, private readonly edgeId: string,
    private readonly options: { timeoutMs?: number; maxAgeMs?: number; now?: () => number } = {},
  ) {}

  /** False when this edge publishes to no web tier: the source is then disabled, not broken. */
  get configured(): boolean { return this.targets.length > 0 && this.token.length >= 16; }

  /** The first configured web tier's report. Rejects when it cannot be reached or does not make sense. */
  read(range: AnalyticsRangeId): Promise<StudentUsageReport> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(range);
    // Several people on the page at once should cost the web tier one report, not one each.
    if (cached && now - cached.at < (this.options.maxAgeMs ?? 5000)) return Promise.resolve(cached.value);
    let pending = this.inFlight.get(range);
    if (!pending) {
      pending = this.fetch(range).then((value) => {
        this.cache.set(range, { at: (this.options.now ?? Date.now)(), value });
        return value;
      }).finally(() => this.inFlight.delete(range));
      this.inFlight.set(range, pending);
    }
    return pending;
  }

  private async fetch(range: AnalyticsRangeId): Promise<StudentUsageReport> {
    const target = this.targets[0];
    if (!target || !this.configured) throw new Error('no web tier configured');
    const url = new URL('/api/edge/usage', target);
    url.searchParams.set('range', range);
    url.searchParams.set('edgeId', this.edgeId);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 2500), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const report = sanitizeUsageReport(await response.json());
    if (!report) throw new Error('not a usage report');
    return report;
  }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v: unknown, max = MAX_POINTS): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const stamp = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8_640_000_000_000_000 ? v : null);

function seriesFrame(raw: unknown): SeriesFrame {
  const v = object(raw);
  const times = list(v.times).map(stamp).filter((t): t is number => t !== null);
  return {
    times, stepMs: count(v.stepMs),
    series: list(v.series, 8).map((entry) => {
      const s = object(entry);
      const values = list(s.values).map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null));
      // Short of a value for every time is a gap, not a reason to shift the rest.
      while (values.length < times.length) values.push(null);
      return { key: text(s.key), label: text(s.label), values: values.slice(0, times.length) };
    }),
  };
}

function counterFrame(raw: unknown): CounterFrame {
  const v = object(raw);
  const times = list(v.times).map(stamp).filter((t): t is number => t !== null);
  return {
    times, stepMs: count(v.stepMs), daily: v.daily === true,
    series: list(v.series, 8).map((entry) => {
      const s = object(entry);
      const values = list(s.values).map(count);
      while (values.length < times.length) values.push(0);
      return { key: text(s.key), label: text(s.label), values: values.slice(0, times.length) };
    }),
  };
}

function totals(raw: unknown): UsageTotals {
  const v = object(raw);
  return {
    searches: count(v.searches), noResultSearches: count(v.noResultSearches), staleDataSearches: count(v.staleDataSearches),
    spaceViews: count(v.spaceViews), tableSelects: count(v.tableSelects), directionsViews: count(v.directionsViews),
    signIns: count(v.signIns), failedSignIns: count(v.failedSignIns), rateLimitedSignIns: count(v.rateLimitedSignIns),
    signUps: count(v.signUps), signOuts: count(v.signOuts), requests: count(v.requests),
    clientErrors: count(v.clientErrors), serverErrors: count(v.serverErrors),
  };
}

/** Null when it is not a version-1 report at all; otherwise the report with every field of the expected type. */
export function sanitizeUsageReport(raw: unknown): StudentUsageReport | null {
  const v = object(raw);
  const range = object(v.range);
  const generatedAt = stamp(v.generatedAt), from = stamp(range.from), to = stamp(range.to);
  if (v.version !== 1 || generatedAt === null || from === null || to === null || !isAnalyticsRange(range.id)) return null;
  const live = object(v.live), accounts = object(v.accounts), active = object(v.active), proc = object(v.process);
  const day = (value: unknown): string => (/^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : '');
  return {
    version: 1, generatedAt, timezone: text(v.timezone, 64), collectingSince: stamp(v.collectingSince),
    range: { id: range.id, from, to },
    live: { sockets: count(live.sockets), students: count(live.students) },
    accounts: {
      total: typeof accounts.total === 'number' ? count(accounts.total) : null,
      createdPerDay: Array.isArray(accounts.createdPerDay)
        ? list(accounts.createdPerDay, 62).map(object).map((row) => ({ day: day(row.day), created: count(row.created), total: count(row.total) })).filter((row) => row.day)
        : null,
    },
    active: {
      today: count(active.today), yesterday: count(active.yesterday), last7Days: count(active.last7Days), last30Days: count(active.last30Days),
      perDay: list(active.perDay, 62).map(object).map((row) => ({ day: day(row.day), students: count(row.students) })).filter((row) => row.day),
    },
    totals: totals(v.totals),
    previousTotals: v.previousTotals ? totals(v.previousTotals) : null,
    activity: counterFrame(v.activity),
    signIns: counterFrame(v.signIns),
    partySizes: list(v.partySizes, 8).map(object).map((row) => ({ seats: text(row.seats, 4), searches: count(row.searches) })),
    topFloors: list(v.topFloors, 12).map(object).map((row) => ({ floorId: text(row.floorId), name: text(row.name), views: count(row.views) })),
    topTables: list(v.topTables, 12).map(object).map((row) => ({ floorId: text(row.floorId), tableId: text(row.tableId), name: text(row.name), selects: count(row.selects) })),
    routeGroups: list(v.routeGroups, 16).map(object).map((row) => ({ group: text(row.group, 32), requests: count(row.requests), clientErrors: count(row.clientErrors), serverErrors: count(row.serverErrors) })),
    online: seriesFrame(v.online),
    requests: seriesFrame(v.requests),
    latency: seriesFrame(v.latency),
    process: {
      startedAt: count(proc.startedAt), uptimeS: count(proc.uptimeS), rssBytes: count(proc.rssBytes), heapBytes: count(proc.heapBytes),
      eventLoopLagMs: count(proc.eventLoopLagMs), node: text(proc.node, 32),
      accountStorage: proc.accountStorage === 'postgres' ? 'postgres' : 'file',
      edges: list(proc.edges, 32).map(object).map((edge) => ({ edgeId: text(edge.edgeId), ageMs: count(edge.ageMs) })),
    },
  };
}
