/** What module 05 of the algo console is given to draw. Counts and measurements only. */
import type { AnalyticsRangeId, AnalyticsSource, SeriesFrame, StudentUsageReport } from '../../../shared/analytics.js';

export type Health = 'ok' | 'warn' | 'err' | 'off';
/** One site-local day of a service's record; `none` is a day nothing was observed, not a bad day. */
export type DayHealth = 'ok' | 'warn' | 'err' | 'none';

export interface HostStatus {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  cores: number;
  cpuModel: string | null;
  uptimeS: number;
  cpu: { busyPercent: number | null; stealPercent: number | null; iowaitPercent: number | null; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number; swapTotalBytes: number | null; swapUsedBytes: number | null };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
}

export interface DiskStatus {
  id: 'system' | 'data';
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  /** Net change per day over the retained week; null until there are six hours to measure it over. */
  growthBytesPerDay: number | null;
  /** At that rate. Null when it is not growing or not yet known. */
  daysUntilFull: number | null;
}

export interface StorageStatus {
  disks: DiskStatus[];
  /** The data directory by top-level entry; null while the first scan is still running. */
  breakdown: { scannedAt: number; truncated: boolean; entries: { name: string; bytes: number; files: number }[] } | null;
  recordedTodayBytes: number;
}

export interface EdgeProcessStatus {
  edgeId: string;
  version: string;
  release: string | null;
  node: string;
  startedAt: number;
  uptimeS: number;
  rssBytes: number;
  heapBytes: number;
  cpuPercent: number | null;
  eventLoopLagMs: number | null;
  persistence: 'file' | 'postgres';
}

export interface ServiceRow {
  id: string;
  name: string;
  detail: string;
  status: Health;
  statusText: string;
  /** Oldest first, one per site-local day, ending today. */
  days: { day: string; health: DayHealth }[];
  /** Over the days that have a record; null when none do. */
  uptimePercent: number | null;
}

export interface UnitRow {
  unit: string;
  description: string | null;
  activeState: string;
  subState: string;
  activeSince: number | null;
  restarts: number | null;
  memoryBytes: number | null;
}

export interface PipelineStatus {
  packetsPerSec: number;
  bytesPerSec: number;
  rejectedPerMin: number;
  rejectReasons: { reason: string; count: number }[];
  nodes: { registered: number; online: number; real: number; realOnline: number };
  /** `tried` is false until the first push to that target has finished either way. */
  publish: { target: string; ok: boolean; tried: boolean; lastOkAt: number | null }[];
  gateways: number;
  directSessions: number | null;
  recorder: { bytesToday: number; rawEnabled: boolean; healthy: boolean };
}

export interface FloorOccupancy {
  id: string;
  name: string;
  seats: number;
  /** Null when no seat on the floor is covered by a working sensor: unknown, never "empty". */
  occupied: number | null;
  free: number | null;
  unknownSeats: number;
}

export interface OccupancyAnalytics {
  floors: FloorOccupancy[];
  /** Share of *known* seats taken, per floor and overall. */
  occupancy: SeriesFrame;
  /** Mean share of known seats taken by weekday and hour, site time, over the retained month. */
  weekly: { rows: string[]; cols: string[]; values: (number | null)[][]; days: number };
}

export interface AnalyticsCharts {
  cpu: SeriesFrame;
  memory: SeriesFrame;
  disk: SeriesFrame;
  network: SeriesFrame;
  edgeMemory: SeriesFrame;
  edgeCpu: SeriesFrame;
  eventLoop: SeriesFrame;
  ingest: SeriesFrame;
  rejected: SeriesFrame;
  sensors: SeriesFrame;
}

export interface AnalyticsSnapshot {
  generatedAt: number;
  range: { id: AnalyticsRangeId; from: number; to: number };
  timezone: string;
  /** When this edge began keeping history. A chart that starts later than its range says so. */
  collectingSince: number | null;
  host: AnalyticsSource<HostStatus>;
  storage: AnalyticsSource<StorageStatus>;
  process: AnalyticsSource<EdgeProcessStatus>;
  services: AnalyticsSource<ServiceRow[]>;
  units: AnalyticsSource<UnitRow[]>;
  pipeline: AnalyticsSource<PipelineStatus>;
  occupancy: AnalyticsSource<OccupancyAnalytics>;
  usage: AnalyticsSource<StudentUsageReport>;
  charts: AnalyticsCharts;
}
