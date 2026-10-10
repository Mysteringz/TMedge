/**
 * Shapes and time rules shared by the analytics module's three parties: the
 * web tier (which meters student usage), the edge (which samples the host and
 * the pipeline, and asks the web tier for its numbers) and the algo console
 * (which draws them, module 05).
 *
 * Everything here is an aggregate. No field can hold an email, an account ID
 * or anything a person could be recognised from; see docs/ANALYTICS.md.
 */

export const ANALYTICS_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type AnalyticsRangeId = typeof ANALYTICS_RANGES[number];

export type GaugeTierId = 'raw' | 'minute' | 'quarter';
export type CounterTierId = 'fine' | 'hour';

export interface RangeSpec {
  id: AnalyticsRangeId;
  spanMs: number;
  /** Which stored resolution a gauge chart reads, and the step it is drawn at. */
  gaugeTier: GaugeTierId;
  gaugeStepMs: number;
  /** Event counts: the stored resolution, and the step they are summed to (0 = one site-local day). */
  counterTier: CounterTierId;
  counterStepMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** About 300 points per chart at every range: enough to see shape, few enough to hover. */
export const RANGE_SPECS: Record<AnalyticsRangeId, RangeSpec> = {
  '1h': { id: '1h', spanMs: HOUR, gaugeTier: 'raw', gaugeStepMs: 10_000, counterTier: 'fine', counterStepMs: 5 * MIN },
  '24h': { id: '24h', spanMs: DAY, gaugeTier: 'minute', gaugeStepMs: 5 * MIN, counterTier: 'hour', counterStepMs: HOUR },
  '7d': { id: '7d', spanMs: 7 * DAY, gaugeTier: 'quarter', gaugeStepMs: 30 * MIN, counterTier: 'hour', counterStepMs: 0 },
  '30d': { id: '30d', spanMs: 30 * DAY, gaugeTier: 'quarter', gaugeStepMs: 2 * HOUR, counterTier: 'hour', counterStepMs: 0 },
};

export function isAnalyticsRange(value: unknown): value is AnalyticsRangeId {
  return ANALYTICS_RANGES.some((id) => id === value);
}

/**
 * One source of a dashboard, with how it was observed. `unavailable` and
 * `disabled` carry no data on purpose: a tile must be able to say "not known"
 * rather than print a zero that reads as "nothing is happening".
 */
export interface AnalyticsSource<T> {
  state: 'available' | 'unavailable' | 'disabled';
  observedAt: number | null;
  data: T | null;
}

/** A time series on a fixed step. `null` is a gap: nothing was measured, which is not zero. */
export interface AnalyticsSeries {
  key: string;
  label: string;
  values: (number | null)[];
}

export interface SeriesFrame {
  /** Start of each step, ms since epoch. */
  times: number[];
  stepMs: number;
  series: AnalyticsSeries[];
}

/** Event counts on a fixed step (or one site-local day when `daily`). Zero is real here: nothing happened. */
export interface CounterFrame {
  times: number[];
  stepMs: number;
  daily: boolean;
  series: { key: string; label: string; values: number[] }[];
}

export interface UsageTotals {
  searches: number;
  noResultSearches: number;
  staleDataSearches: number;
  spaceViews: number;
  tableSelects: number;
  directionsViews: number;
  signIns: number;
  failedSignIns: number;
  rateLimitedSignIns: number;
  signUps: number;
  signOuts: number;
  requests: number;
  clientErrors: number;
  serverErrors: number;
}

export interface RouteGroupUsage {
  group: string;
  requests: number;
  clientErrors: number;
  serverErrors: number;
}

/** What the web tier reports about itself and the students using it. Aggregates only. */
export interface StudentUsageReport {
  version: 1;
  generatedAt: number;
  timezone: string;
  /** When this web tier began metering; charts before this are honestly empty. */
  collectingSince: number | null;
  range: { id: AnalyticsRangeId; from: number; to: number };
  live: { sockets: number; students: number };
  accounts: {
    total: number | null;
    /** Accounts created per site-local day, oldest first; null when the account store cannot list them. */
    createdPerDay: { day: string; created: number; total: number }[] | null;
  };
  active: {
    today: number;
    yesterday: number;
    last7Days: number;
    last30Days: number;
    perDay: { day: string; students: number }[];
  };
  totals: UsageTotals;
  /** The same totals for the equal-length period just before `range`; null when it is not retained. */
  previousTotals: UsageTotals | null;
  activity: CounterFrame;
  signIns: CounterFrame;
  partySizes: { seats: string; searches: number }[];
  topFloors: { floorId: string; name: string; views: number }[];
  topTables: { floorId: string; tableId: string; name: string; selects: number }[];
  routeGroups: RouteGroupUsage[];
  online: SeriesFrame;
  requests: SeriesFrame;
  latency: SeriesFrame;
  process: {
    startedAt: number;
    uptimeS: number;
    rssBytes: number;
    heapBytes: number;
    eventLoopLagMs: number;
    node: string;
    accountStorage: 'file' | 'postgres';
    /** Freshness of each edge's last snapshot push, as the web tier sees it. */
    edges: { edgeId: string; ageMs: number }[];
  };
}

/** `YYYY-MM-DD` in the site's own time zone: a student's "today" is the campus's, not the server's. */
export function dayKey(at: number, timeZone: string): string {
  return dayFormat(timeZone).format(at);
}

/** Monday = 0 … Sunday = 6, and the hour 0–23, in the site's time zone. */
export function weekHour(at: number, timeZone: string): { weekday: number; hour: number } {
  const parts = weekFormat(timeZone).formatToParts(at);
  const day = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  // hourCycle h23 still prints "24" for midnight in some ICU builds.
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  return { weekday: Math.max(0, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day)), hour };
}

export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value }); return true; } catch { return false; }
}

// Constructing an Intl formatter costs far more than using one, and these run per bucket.
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const weekFormats = new Map<string, Intl.DateTimeFormat>();
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormats.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); dayFormats.set(timeZone, f); }
  return f;
}
function weekFormat(timeZone: string): Intl.DateTimeFormat {
  let f = weekFormats.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }); weekFormats.set(timeZone, f); }
  return f;
}

export const DEFAULT_ANALYTICS_TIMEZONE = 'Asia/Hong_Kong';
