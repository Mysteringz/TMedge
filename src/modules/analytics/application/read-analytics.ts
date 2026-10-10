/**
 * Puts one Analytics page together: what the collector has kept, plus the
 * three things asked for on demand (the web tier's usage report, systemd,
 * the data-directory scan).
 *
 * Each source stands alone. A web tier that is down makes the usage panels
 * say "unavailable"; it does not blank the processor chart, and it does not
 * turn into a row of zeros that would read as "no students today".
 */
import {
  dayKey, RANGE_SPECS, weekHour,
  type AnalyticsRangeId, type AnalyticsSource, type SeriesFrame, type StudentUsageReport,
} from '../../../shared/analytics.js';
import type { DirectoryUsage } from '../../../infrastructure/analytics/directory-usage.js';
import { hostFacts } from '../../../infrastructure/analytics/host-probe.js';
import type { UnitStatus } from '../../../infrastructure/analytics/systemd-probe.js';
import type {
  AnalyticsCharts, AnalyticsSnapshot, DayHealth, DiskStatus, EdgeProcessStatus, HostStatus,
  OccupancyAnalytics, ServiceRow, StorageStatus,
} from '../domain/analytics-snapshot.js';
import type { CollectorReading, EdgeAnalyticsCollector } from './edge-analytics-collector.js';

export interface ReadAnalyticsDependencies {
  collector: EdgeAnalyticsCollector;
  /** Null when this edge publishes to no web tier. */
  usage: { configured: boolean; read(range: AnalyticsRangeId): Promise<StudentUsageReport> } | null;
  /** Resolves null where there is no systemd to ask. */
  units: { supported: boolean; read(now: number): Promise<UnitStatus[] | null> };
  directoryUsage: { read(now: number): DirectoryUsage | null };
  identity: { edgeId: string; version: string; release: string | null; persistence: 'file' | 'postgres'; hasDatabase: boolean };
  timeZone: string;
  now?: () => number;
  /** How long one assembled page is handed to everyone who asks; 0 turns that off (tests). */
  shareMs?: number;
}

const DAY = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const SERVICE_DAYS = 30;

export class ReadAnalytics {
  private readonly now: () => number;
  private readonly shared = new Map<AnalyticsRangeId, { at: number; value: Promise<AnalyticsSnapshot> }>();
  // A month of history is some three thousand fifteen-minute slots, and every
  // page asks which day and hour each one is in. Asking Intl once per slot
  // instead of once per slot per request keeps a page well under a millisecond
  // of that on the same loop that answers the sensors.
  private readonly dayOfSlot = new Map<number, string>();
  private readonly hourOfSlot = new Map<number, { weekday: number; hour: number }>();

  constructor(private readonly deps: ReadAnalyticsDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private day(at: number): string {
    const slot = Math.floor(at / 900_000);
    let day = this.dayOfSlot.get(slot);
    if (day === undefined) {
      if (this.dayOfSlot.size > 8000) this.dayOfSlot.clear();
      day = dayKey(at, this.deps.timeZone);
      this.dayOfSlot.set(slot, day);
    }
    return day;
  }

  private weekHour(at: number): { weekday: number; hour: number } {
    const slot = Math.floor(at / 900_000);
    let value = this.hourOfSlot.get(slot);
    if (!value) {
      if (this.hourOfSlot.size > 8000) this.hourOfSlot.clear();
      value = weekHour(at, this.deps.timeZone);
      this.hourOfSlot.set(slot, value);
    }
    return value;
  }

  /** Several tabs on the same range within a couple of seconds are given the same page. */
  execute(rangeId: AnalyticsRangeId): Promise<AnalyticsSnapshot> {
    const share = this.deps.shareMs ?? 2000;
    const at = this.now();
    const held = this.shared.get(rangeId);
    if (share > 0 && held && at - held.at >= 0 && at - held.at < share) return held.value;
    const value = this.assemble(rangeId);
    if (share > 0) {
      this.shared.set(rangeId, { at, value });
      value.catch(() => { if (this.shared.get(rangeId)?.value === value) this.shared.delete(rangeId); });
    }
    return value;
  }

  private async assemble(rangeId: AnalyticsRangeId): Promise<AnalyticsSnapshot> {
    const now = this.now();
    const spec = RANGE_SPECS[rangeId];
    const from = now - spec.spanMs;
    const { collector } = this.deps;
    const reading = collector.reading;
    const [usage, units] = await Promise.all([
      this.deps.usage?.configured ? observe(() => this.deps.usage!.read(rangeId), now) : Promise.resolve(disabled<StudentUsageReport>()),
      this.deps.units.supported ? observe(() => this.deps.units.read(now), now) : Promise.resolve(disabled<UnitStatus[]>()),
    ]);
    return {
      generatedAt: this.now(),
      range: { id: rangeId, from, to: now },
      timezone: this.deps.timeZone,
      collectingSince: collector.history.earliest,
      host: fromReading(reading, (r) => this.host(r)),
      storage: fromReading(reading, (r) => this.storage(r, now)),
      process: fromReading(reading, (r) => this.process(r, now)),
      services: fromReading(reading, (r) => this.services(r, usage.state, now)),
      units,
      pipeline: fromReading(reading, (r) => r.pipeline),
      occupancy: fromReading(reading, (r) => this.occupancy(r, from, now, rangeId)),
      usage,
      charts: this.charts(rangeId, from, now, reading),
    };
  }

  private host(r: CollectorReading): HostStatus {
    const { memory } = r.host;
    const used = memory.totalBytes - memory.availableBytes;
    return {
      ...hostFacts(),
      cpu: {
        busyPercent: r.host.cpuBusyPercent, stealPercent: r.host.cpuStealPercent, iowaitPercent: r.host.cpuIowaitPercent,
        load1: r.host.load1, load5: r.host.load5, load15: r.host.load15,
      },
      memory: {
        totalBytes: memory.totalBytes, usedBytes: used, availableBytes: memory.availableBytes,
        usedPercent: memory.totalBytes > 0 ? used / memory.totalBytes * 100 : 0,
        swapTotalBytes: memory.swapTotalBytes,
        swapUsedBytes: memory.swapTotalBytes !== null && memory.swapFreeBytes !== null ? memory.swapTotalBytes - memory.swapFreeBytes : null,
      },
      network: { rxBytesPerSec: r.host.netRxBytesPerSec, txBytesPerSec: r.host.netTxBytesPerSec },
    };
  }

  private storage(r: CollectorReading, now: number): StorageStatus {
    const disks: DiskStatus[] = r.disks.map((disk) => {
      // Net of pruning, over up to a week: the rate that decides when it fills.
      const points = this.deps.collector.history.quarters(`disk.${disk.id}.bytes`, now - 7 * DAY, now);
      const first = points[0], last = points[points.length - 1];
      const growth = first && last && last.at - first.at >= 6 * 3_600_000 ? (last.avg - first.avg) / (last.at - first.at) * DAY : null;
      return {
        id: disk.id, label: disk.label, totalBytes: disk.totalBytes, usedBytes: disk.usedBytes, freeBytes: disk.freeBytes, usedPercent: disk.usedPercent,
        growthBytesPerDay: growth,
        daysUntilFull: growth !== null && growth > 0 ? Math.min(3650, disk.freeBytes / growth) : null,
      };
    });
    const scan = this.deps.directoryUsage.read(now);
    return {
      disks,
      breakdown: scan ? { scannedAt: scan.scannedAt, truncated: scan.truncated, entries: scan.entries.slice(0, 12) } : null,
      recordedTodayBytes: r.pipeline.recorder.bytesToday,
    };
  }

  private process(r: CollectorReading, now: number): EdgeProcessStatus {
    const { identity, collector } = this.deps;
    return {
      edgeId: identity.edgeId, version: identity.version, release: identity.release, node: process.version,
      startedAt: collector.startedAt, uptimeS: Math.round((now - collector.startedAt) / 1000),
      rssBytes: r.process.rssBytes, heapBytes: r.process.heapBytes, cpuPercent: r.process.cpuPercent,
      eventLoopLagMs: r.process.eventLoopLagMs, persistence: identity.persistence,
    };
  }

  private services(r: CollectorReading, usageState: AnalyticsSource<unknown>['state'], now: number): ServiceRow[] {
    const { history } = this.deps.collector;
    const zone = this.deps.timeZone;
    const earliest = history.earliest;
    const days = Array.from({ length: SERVICE_DAYS }, (_, i) => dayKey(now - (SERVICE_DAYS - 1 - i) * DAY, zone));

    /** How many fifteen-minute slots of each day fall inside the time this edge has kept history for. */
    const expected = new Map<string, number>();
    if (earliest !== null) {
      for (let t = Math.floor(earliest / 900_000) * 900_000; t <= now; t += 900_000) expected.set(this.day(t), (expected.get(this.day(t)) ?? 0) + 1);
    }
    const grade = (share: number, ok: number, warn: number): DayHealth => (share >= ok ? 'ok' : share >= warn ? 'warn' : 'err');
    const record = (metric: string, value: 'presence' | 'mean', ok: number, warn: number, scale = 1): { days: ServiceRow['days']; uptimePercent: number | null } => {
      const byDay = new Map<string, { sum: number; n: number }>();
      for (const point of history.quarters(metric, now - SERVICE_DAYS * DAY, now + 1)) {
        const entry = byDay.get(this.day(point.at)) ?? { sum: 0, n: 0 };
        entry.sum += point.avg / scale; entry.n += 1;
        byDay.set(this.day(point.at), entry);
      }
      let total = 0, weight = 0;
      const out = days.map((day) => {
        const entry = byDay.get(day), slots = expected.get(day) ?? 0;
        // Presence is measured against the slots that could have had a sample;
        // a mean is only over the slots that did.
        if (value === 'presence') {
          if (slots === 0) return { day, health: 'none' as DayHealth };
          const share = Math.min(1, (entry?.n ?? 0) / slots);
          total += share * slots; weight += slots;
          return { day, health: grade(share, ok, warn) };
        }
        if (!entry) return { day, health: 'none' as DayHealth };
        const share = Math.min(1, entry.sum / entry.n);
        total += share * entry.n; weight += entry.n;
        return { day, health: grade(share, ok, warn) };
      });
      return { days: out, uptimePercent: weight > 0 ? total / weight * 100 : null };
    };

    const { nodes, publish, recorder } = r.pipeline;
    const rows: ServiceRow[] = [];
    rows.push({
      id: 'edge', name: 'Edge service', detail: 'Ingest, occupancy and this console',
      status: 'ok', statusText: 'Operational', ...record('edge.rss', 'presence', 0.99, 0.9),
    });
    const pushOk = publish.length > 0 && publish.every((target) => target.ok);
    // Nothing has been pushed yet: too early to call it either way.
    const pushPending = publish.length > 0 && !pushOk && publish.some((target) => !target.tried);
    rows.push({
      id: 'web', name: 'Student web tier', detail: publish.length > 0 ? publish.map((target) => target.target).join(', ') : 'No web tier configured',
      status: publish.length === 0 || pushPending ? 'off' : pushOk && usageState !== 'unavailable' ? 'ok' : pushOk || usageState === 'available' ? 'warn' : 'err',
      statusText: publish.length === 0 ? 'Not configured' : pushPending ? 'Starting up' : pushOk && usageState !== 'unavailable' ? 'Operational'
        : pushOk ? 'Degraded: usage report unavailable' : usageState === 'available' ? 'Degraded: snapshot push failing' : 'Outage: not reachable',
      ...record('web.push', 'mean', 0.99, 0.9),
    });
    const share = nodes.registered > 0 ? nodes.online / nodes.registered : 0;
    rows.push({
      id: 'sensors', name: 'Sensor ingest', detail: `${nodes.online} of ${nodes.registered} sensors reporting`,
      status: nodes.registered === 0 || !r.warm ? 'off' : share >= 1 ? 'ok' : share > 0 ? 'warn' : 'err',
      statusText: nodes.registered === 0 ? 'No sensors registered' : !r.warm ? 'Starting up' : share >= 1 ? 'Operational' : share > 0 ? 'Degraded' : 'Outage',
      // A day counts as good when nine sensors in ten reported through it.
      ...this.ratioRecord(days, now, 0.9, 0.5),
    });
    rows.push({
      id: 'recorder', name: 'Recorder', detail: recorder.rawEnabled ? 'Detections, occupancy and raw frames' : 'Detections and occupancy',
      status: recorder.healthy ? 'ok' : 'err', statusText: recorder.healthy ? 'Operational' : 'Outage: write errors',
      ...record('rec.ok', 'mean', 0.99, 0.9),
    });
    rows.push(this.deps.identity.hasDatabase
      ? {
        id: 'database', name: 'Database', detail: 'PostgreSQL',
        status: r.databaseUp === null ? 'off' : r.databaseUp ? 'ok' : 'err',
        statusText: r.databaseUp === null ? 'Not checked yet' : r.databaseUp ? 'Operational' : 'Outage: not answering',
        ...record('db.up', 'mean', 0.99, 0.9),
      }
      : { id: 'database', name: 'Database', detail: 'This edge keeps its records in files', status: 'off', statusText: 'Not configured', days: days.map((day) => ({ day, health: 'none' as DayHealth })), uptimePercent: null });
    return rows;
  }

  /** Sensors reporting as a share of sensors registered, per day. */
  private ratioRecord(days: string[], now: number, ok: number, warn: number): { days: ServiceRow['days']; uptimePercent: number | null } {
    const { history } = this.deps.collector;
    const registered = new Map(history.quarters('nodes.registered', now - SERVICE_DAYS * DAY, now + 1).map((point) => [point.at, point.avg]));
    const byDay = new Map<string, { sum: number; n: number }>();
    for (const point of history.quarters('nodes.online', now - SERVICE_DAYS * DAY, now + 1)) {
      const total = registered.get(point.at);
      if (!total || total <= 0) continue;
      const entry = byDay.get(this.day(point.at)) ?? { sum: 0, n: 0 };
      entry.sum += Math.min(1, point.avg / total); entry.n += 1;
      byDay.set(this.day(point.at), entry);
    }
    let sum = 0, n = 0;
    const out = days.map((day) => {
      const entry = byDay.get(day);
      if (!entry) return { day, health: 'none' as DayHealth };
      const share = entry.sum / entry.n;
      sum += entry.sum; n += entry.n;
      return { day, health: (share >= ok ? 'ok' : share >= warn ? 'warn' : 'err') as DayHealth };
    });
    return { days: out, uptimePercent: n > 0 ? sum / n * 100 : null };
  }

  private occupancy(r: CollectorReading, from: number, now: number, rangeId: AnalyticsRangeId): OccupancyAnalytics {
    const spec = RANGE_SPECS[rangeId];
    const { history } = this.deps.collector;
    const cells = WEEKDAYS.map(() => HOURS.map(() => ({ sum: 0, n: 0 })));
    const seenDays = new Set<string>();
    for (const point of history.quarters('occ.all.pct', now - 30 * DAY, now + 1)) {
      const { weekday, hour } = this.weekHour(point.at);
      const cell = cells[weekday]?.[hour];
      if (!cell) continue;
      cell.sum += point.avg; cell.n += 1;
      seenDays.add(this.day(point.at));
    }
    // A chart holds four lines at most. Two or three floors each get one,
    // beside the total; one floor is the total; more than three is the total alone.
    const perFloor = r.floors.length >= 2 && r.floors.length <= 3;
    return {
      floors: r.floors,
      occupancy: history.frame(spec.gaugeTier, from, now + 1, spec.gaugeStepMs, [
        ...(perFloor ? r.floors.map((floor) => ({ key: `occ.${floor.id}.pct`, label: floor.name })) : []),
        { key: 'occ.all.pct', label: perFloor ? 'All floors' : 'Seats taken' },
      ]),
      weekly: {
        rows: WEEKDAYS, cols: HOURS, days: seenDays.size,
        values: cells.map((row) => row.map((cell) => (cell.n > 0 ? Math.round(cell.sum / cell.n * 10) / 10 : null))),
      },
    };
  }

  private charts(rangeId: AnalyticsRangeId, from: number, now: number, reading: CollectorReading | null): AnalyticsCharts {
    const spec = RANGE_SPECS[rangeId];
    const { history } = this.deps.collector;
    const frame = (metrics: { key: string; label: string }[]): SeriesFrame => {
      const out = history.frame(spec.gaugeTier, from, now + 1, spec.gaugeStepMs, metrics);
      // A series this host cannot measure (steal time off Linux, a swap that
      // does not exist) is left out rather than drawn as an empty legend entry.
      const measured = out.series.filter((series) => series.values.some((value) => value !== null));
      return { ...out, series: measured.length > 0 ? measured : out.series.slice(0, 1) };
    };
    return {
      cpu: frame([{ key: 'cpu.busy', label: 'Busy' }, { key: 'cpu.steal', label: 'Stolen by host' }, { key: 'cpu.iowait', label: 'Waiting on disk' }]),
      memory: frame([{ key: 'mem.used', label: 'Memory' }, { key: 'swap.used', label: 'Swap' }]),
      disk: frame((reading?.disks ?? []).map((disk) => ({ key: `disk.${disk.id}.pct`, label: disk.label }))),
      network: frame([{ key: 'net.rx', label: 'Received' }, { key: 'net.tx', label: 'Sent' }]),
      edgeMemory: frame([{ key: 'edge.rss', label: 'Resident' }, { key: 'edge.heap', label: 'Heap in use' }]),
      edgeCpu: frame([{ key: 'edge.cpu', label: 'Edge process' }]),
      eventLoop: frame([{ key: 'edge.lag', label: 'Event-loop delay' }]),
      ingest: frame([{ key: 'ingest.packets', label: 'Packets' }]),
      rejected: frame([{ key: 'ingest.rejected', label: 'Rejected' }]),
      sensors: frame([{ key: 'nodes.online', label: 'Reporting' }, { key: 'nodes.registered', label: 'Registered' }]),
    };
  }
}

function disabled<T>(): AnalyticsSource<T> {
  return { state: 'disabled', observedAt: null, data: null };
}

function fromReading<T>(reading: CollectorReading | null, build: (reading: CollectorReading) => T): AnalyticsSource<T> {
  if (!reading) return { state: 'unavailable', observedAt: null, data: null };
  try { return { state: 'available', observedAt: reading.at, data: build(reading) }; } catch { return { state: 'unavailable', observedAt: null, data: null }; }
}

/** One on-demand source: bounded in time, and a failure stays its own. Null from the source means "nothing to ask". */
async function observe<T>(query: () => Promise<T | null>, now: number, timeoutMs = 3000): Promise<AnalyticsSource<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      query().then((data) => ({ data })),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!result) return { state: 'unavailable', observedAt: null, data: null };
    return result.data === null ? disabled<T>() : { state: 'available', observedAt: now, data: result.data };
  } catch {
    return { state: 'unavailable', observedAt: null, data: null };
  } finally { if (timer) clearTimeout(timer); }
}
