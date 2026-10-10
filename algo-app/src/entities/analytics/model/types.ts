/**
 * What `GET /api/analytics` returns. Mirrors src/shared/analytics.ts and
 * src/modules/analytics/domain/analytics-snapshot.ts on the server; this app
 * is built on its own and cannot import them.
 */
export const RANGES = ['1h', '24h', '7d', '30d'] as const;
export type RangeId = typeof RANGES[number];

/** `unavailable` and `disabled` carry no data: a panel says "not known", it never shows a zero. */
export interface Source<T> { state: 'available' | 'unavailable' | 'disabled'; observedAt: number | null; data: T | null }

/** `null` in `values` is a gap: nothing was measured then. */
export interface SeriesFrame { times: number[]; stepMs: number; series: { key: string; label: string; values: (number | null)[] }[] }
/** Event counts; zero is real. `daily` steps are days in the site's time zone. */
export interface CounterFrame { times: number[]; stepMs: number; daily: boolean; series: { key: string; label: string; values: number[] }[] }

export interface UsageTotals {
  searches: number; noResultSearches: number; staleDataSearches: number; spaceViews: number; tableSelects: number; directionsViews: number;
  signIns: number; failedSignIns: number; rateLimitedSignIns: number; signUps: number; signOuts: number;
  requests: number; clientErrors: number; serverErrors: number;
}

export interface StudentUsage {
  version: 1; generatedAt: number; timezone: string; collectingSince: number | null;
  range: { id: RangeId; from: number; to: number };
  live: { sockets: number; students: number };
  accounts: { total: number | null; createdPerDay: { day: string; created: number; total: number }[] | null };
  active: { today: number; yesterday: number; last7Days: number; last30Days: number; perDay: { day: string; students: number }[] };
  totals: UsageTotals;
  previousTotals: UsageTotals | null;
  activity: CounterFrame;
  signIns: CounterFrame;
  partySizes: { seats: string; searches: number }[];
  topFloors: { floorId: string; name: string; views: number }[];
  topTables: { floorId: string; tableId: string; name: string; selects: number }[];
  routeGroups: { group: string; requests: number; clientErrors: number; serverErrors: number }[];
  online: SeriesFrame;
  requests: SeriesFrame;
  latency: SeriesFrame;
  process: { startedAt: number; uptimeS: number; rssBytes: number; heapBytes: number; eventLoopLagMs: number; node: string; accountStorage: 'file' | 'postgres'; edges: { edgeId: string; ageMs: number }[] };
}

export type Health = 'ok' | 'warn' | 'err' | 'off';
export type DayHealth = 'ok' | 'warn' | 'err' | 'none';

export interface HostStatus {
  hostname: string; platform: string; kernel: string; arch: string; cores: number; cpuModel: string | null; uptimeS: number;
  cpu: { busyPercent: number | null; stealPercent: number | null; iowaitPercent: number | null; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number; swapTotalBytes: number | null; swapUsedBytes: number | null };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
}
export interface DiskStatus {
  id: 'system' | 'data'; label: string; totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number;
  growthBytesPerDay: number | null; daysUntilFull: number | null;
}
export interface StorageStatus {
  disks: DiskStatus[];
  breakdown: { scannedAt: number; truncated: boolean; entries: { name: string; bytes: number; files: number }[] } | null;
  recordedTodayBytes: number;
}
export interface EdgeProcess {
  edgeId: string; version: string; release: string | null; node: string; startedAt: number; uptimeS: number;
  rssBytes: number; heapBytes: number; cpuPercent: number | null; eventLoopLagMs: number | null; persistence: 'file' | 'postgres';
}
export interface ServiceRow {
  id: string; name: string; detail: string; status: Health; statusText: string;
  days: { day: string; health: DayHealth }[]; uptimePercent: number | null;
}
export interface UnitRow {
  unit: string; description: string | null; activeState: string; subState: string;
  activeSince: number | null; restarts: number | null; memoryBytes: number | null;
}
export interface PipelineStatus {
  packetsPerSec: number; bytesPerSec: number; rejectedPerMin: number;
  rejectReasons: { reason: string; count: number }[];
  nodes: { registered: number; online: number; real: number; realOnline: number };
  publish: { target: string; ok: boolean; tried: boolean; lastOkAt: number | null }[];
  gateways: number; directSessions: number | null;
  recorder: { bytesToday: number; rawEnabled: boolean; healthy: boolean };
}
export interface FloorOccupancy { id: string; name: string; seats: number; occupied: number | null; free: number | null; unknownSeats: number }
export interface OccupancyAnalytics {
  floors: FloorOccupancy[];
  occupancy: SeriesFrame;
  weekly: { rows: string[]; cols: string[]; values: (number | null)[][]; days: number };
}
export interface AnalyticsCharts {
  cpu: SeriesFrame; memory: SeriesFrame; disk: SeriesFrame; network: SeriesFrame; edgeMemory: SeriesFrame;
  edgeCpu: SeriesFrame; eventLoop: SeriesFrame; ingest: SeriesFrame; rejected: SeriesFrame; sensors: SeriesFrame;
}

export interface AnalyticsSnapshot {
  generatedAt: number;
  range: { id: RangeId; from: number; to: number };
  timezone: string;
  collectingSince: number | null;
  host: Source<HostStatus>;
  storage: Source<StorageStatus>;
  process: Source<EdgeProcess>;
  services: Source<ServiceRow[]>;
  units: Source<UnitRow[]>;
  pipeline: Source<PipelineStatus>;
  occupancy: Source<OccupancyAnalytics>;
  usage: Source<StudentUsage>;
  charts: AnalyticsCharts;
}
