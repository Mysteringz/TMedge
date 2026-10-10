/**
 * Samples the edge and its host every ten seconds and keeps the history.
 *
 * It runs whether or not anyone has the Analytics page open: a chart of the
 * last week is only possible if somebody was writing it down last week.
 * Everything it reads is already in memory or in /proc; the two things that
 * touch a disk or another process (volume sizes, the database check) run
 * once a minute and never hold up a sample.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BucketLog } from '../../../infrastructure/analytics/bucket-log.js';
import { diskUsage, HostProbe, type DiskUsage, type HostSample } from '../../../infrastructure/analytics/host-probe.js';
import type { FloorOccupancy, PipelineStatus } from '../domain/analytics-snapshot.js';
import { MetricHistory } from './metric-history.js';

/** The edge as the collector sees it. Narrow on purpose: a test can supply one in a few lines. */
export interface EdgeAnalyticsSource {
  pipeline(now: number): PipelineStatus;
  /** Floors students can see, as last computed. */
  floors(now: number): FloorOccupancy[];
  /** Null when this edge has no database to ask. */
  databaseAvailable: (() => Promise<boolean>) | null;
}

export interface CollectorOptions {
  dataDir: string;
  /** Null keeps history in memory only. */
  historyDir: string | null;
  sampleMs?: number;
  now?: () => number;
  host?: HostProbe;
  disks?: (dataDir: string) => Promise<DiskUsage[]>;
}

export interface CollectorReading {
  at: number;
  host: HostSample;
  disks: DiskUsage[];
  pipeline: PipelineStatus;
  floors: FloorOccupancy[];
  process: { rssBytes: number; heapBytes: number; cpuPercent: number | null; eventLoopLagMs: number };
  /** Null when there is no database, or it has not been asked yet. */
  databaseUp: boolean | null;
  /** False during the first seconds after a start, when pipeline figures are not yet meaningful. */
  warm: boolean;
}

const SLOW_EVERY_MS = 60_000;
/**
 * Just after a start nothing has had time to happen: no sensor has reported
 * in the last ten seconds because the process did not exist ten seconds ago.
 * Recording that as "no sensors" would mark every deploy as an outage, so the
 * pipeline's figures are left unrecorded until they can mean something.
 */
export const WARM_UP_MS = 15_000;

export class EdgeAnalyticsCollector {
  readonly history: MetricHistory;
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly host: HostProbe;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private stopped: Promise<void> | null = null;
  private latest: CollectorReading | null = null;
  private disks: DiskUsage[] = [];
  private databaseUp: boolean | null = null;
  private lastSlowAt = -Infinity;
  private cpu: { at: number; usage: NodeJS.CpuUsage } | null = null;
  /** Samples that failed and were skipped. */
  faults = 0;

  constructor(private readonly source: EdgeAnalyticsSource, private readonly options: CollectorOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.host = options.host ?? new HostProbe();
    this.history = new MetricHistory('edge', new BucketLog(options.historyDir), this.startedAt);
    this.loop.enable();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    // Straight away: processor and network figures are differences, so the
    // first reading only sets the baseline the second is measured from.
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.options.sampleMs ?? 10_000);
    this.timer.unref();
  }

  /** The most recent reading, or null before the first. */
  get reading(): CollectorReading | null { return this.latest; }

  async sample(): Promise<void> {
    if (this.sampling || this.stopped) return;
    this.sampling = true;
    try {
      const now = this.now();
      if (now - this.lastSlowAt >= SLOW_EVERY_MS) {
        this.lastSlowAt = now;
        this.disks = await (this.options.disks ?? diskUsage)(this.options.dataDir).catch(() => []);
        // Not awaited: a database that hangs must not stop the host being sampled.
        if (this.source.databaseAvailable) void this.checkDatabase(this.source.databaseAvailable);
      }
      const host = this.host.sample(now);
      const usage = process.cpuUsage();
      const cpuPercent = this.cpu && now > this.cpu.at
        ? ((usage.user - this.cpu.usage.user) + (usage.system - this.cpu.usage.system)) / ((now - this.cpu.at) * 1000) * 100 : null;
      this.cpu = { at: now, usage };
      const memory = process.memoryUsage();
      const lag = this.loop.percentile(99) / 1e6;
      this.loop.reset();
      const pipeline = this.source.pipeline(now);
      const floors = this.source.floors(now);
      this.latest = {
        at: now, host, disks: this.disks, pipeline, floors, databaseUp: this.databaseUp, warm: now - this.startedAt >= WARM_UP_MS,
        process: { rssBytes: memory.rss, heapBytes: memory.heapUsed, cpuPercent, eventLoopLagMs: lag },
      };
      this.history.record(now, this.metrics(this.latest));
    } catch {
      // Sampling runs on a timer inside the edge. A fault here is a missed
      // point on a chart; left unhandled it would be a stopped edge.
      this.faults += 1;
    } finally {
      this.sampling = false;
    }
  }

  private async checkDatabase(ask: () => Promise<boolean>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      this.databaseUp = await Promise.race([
        ask(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
      ]);
    } catch { this.databaseUp = false; } finally { if (timer) clearTimeout(timer); }
  }

  private metrics(r: CollectorReading): Record<string, number | null> {
    const { host, pipeline } = r;
    const swap = host.memory.swapTotalBytes && host.memory.swapFreeBytes !== null
      ? (host.memory.swapTotalBytes - host.memory.swapFreeBytes) / host.memory.swapTotalBytes * 100 : null;
    const out: Record<string, number | null> = {
      'cpu.busy': host.cpuBusyPercent, 'cpu.steal': host.cpuStealPercent, 'cpu.iowait': host.cpuIowaitPercent,
      'load.1': host.load1,
      'mem.used': host.memory.totalBytes > 0 ? (host.memory.totalBytes - host.memory.availableBytes) / host.memory.totalBytes * 100 : null,
      'swap.used': swap,
      'net.rx': host.netRxBytesPerSec, 'net.tx': host.netTxBytesPerSec,
      'edge.rss': r.process.rssBytes, 'edge.heap': r.process.heapBytes, 'edge.cpu': r.process.cpuPercent, 'edge.lag': r.process.eventLoopLagMs,
      'rec.ok': Number(pipeline.recorder.healthy),
      'db.up': r.databaseUp === null ? null : Number(r.databaseUp),
    };
    if (r.warm) {
      Object.assign(out, {
        'ingest.packets': pipeline.packetsPerSec, 'ingest.bytes': pipeline.bytesPerSec, 'ingest.rejected': pipeline.rejectedPerMin,
        'nodes.online': pipeline.nodes.online, 'nodes.registered': pipeline.nodes.registered,
        // No target, or none tried yet: nothing to say about the web tier. A failing one is a zero.
        'web.push': pipeline.publish.length > 0 && pipeline.publish.every((target) => target.tried)
          ? Number(pipeline.publish.every((target) => target.ok)) : null,
      });
    }
    for (const disk of r.disks) {
      out[`disk.${disk.id}.pct`] = disk.usedPercent;
      out[`disk.${disk.id}.bytes`] = disk.usedBytes;
    }
    let occupied = 0, known = 0;
    for (const floor of r.floors) {
      const floorKnown = floor.seats - floor.unknownSeats;
      // A floor nobody can see has no occupancy to record. Writing 0 here is
      // how a dead sensor would become "empty" on a chart.
      out[`occ.${floor.id}.pct`] = floorKnown > 0 && floor.occupied !== null ? floor.occupied / floorKnown * 100 : null;
      if (floorKnown > 0 && floor.occupied !== null) { occupied += floor.occupied; known += floorKnown; }
    }
    out['occ.all.pct'] = known > 0 ? occupied / known * 100 : null;
    out['occ.all.occupied'] = known > 0 ? occupied : null;
    out['occ.all.known'] = known > 0 ? known : null;
    return out;
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
    this.stopped = this.history.close();
    return this.stopped;
  }
}
