/**
 * The edge, assembled: ingest -> occupancy -> recorder / publisher, plus the
 * per-node bookkeeping the debug console shows. No HTTP here (see console.ts),
 * so tests can drive a whole edge with datagrams and a fake clock.
 */
import { EventEmitter } from 'node:events';
import { footprint } from '../shared/geometry.js';
import type { ConsoleDetection, EdgeHealth, NodeHealth, OccupancySnapshot, RawFrameMessage } from '../shared/types.js';
import type { EdgeConfig } from './config.js';
import { DwellMap } from './dwell.js';
import { HostMonitor } from './health.js';
import { Ingest } from './ingest.js';
import { DEFAULT_OCCUPANCY, OccupancyEngine, type OccupancyOptions } from './occupancy.js';
import { REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, type Raw, type Report, type Status } from './protocol.js';
import { Publisher } from './publisher.js';
import { Recorder } from './recorder.js';
import type { Registry } from './registry.js';

export const EDGE_VERSION = '1.0.0';

interface NodeInfo {
  lastReport: Report | null;
  lastReportAt: number | null;
  status: Status | null;
  statusAt: number | null;
  lastRaw: RawFrameMessage | null;
}

export declare interface EdgeRuntime {
  on(event: 'report', l: (uid: string, dets: ConsoleDetection[], at: number) => void): this;
  on(event: 'raw', l: (msg: RawFrameMessage) => void): this;
  on(event: 'snapshot', l: (s: OccupancySnapshot) => void): this;
}

export class EdgeRuntime extends EventEmitter {
  readonly ingest: Ingest;
  readonly engine: OccupancyEngine;
  readonly recorder: Recorder;
  readonly publisher: Publisher;
  readonly host = new HostMonitor();
  readonly dwell = new Map<string, DwellMap>();
  private readonly info = new Map<string, NodeInfo>();
  private publishTimer: NodeJS.Timeout | null = null;
  private lastRecordedMinute = -1;
  latest: OccupancySnapshot;

  constructor(readonly cfg: EdgeConfig, readonly reg: Registry, occupancy: OccupancyOptions = DEFAULT_OCCUPANCY) {
    super();
    this.engine = new OccupancyEngine(reg, cfg.edgeId, occupancy);
    this.recorder = new Recorder(cfg.dataDir, cfg.recordRaw);
    this.publisher = new Publisher(cfg.pushUrls, cfg.pushToken);
    for (const f of reg.floors) this.dwell.set(f.id, new DwellMap(f.width, f.height));
    this.ingest = new Ingest({
      port: cfg.udpPort,
      host: cfg.udpHost,
      verify: { keys: cfg.keys, allowUnsigned: cfg.allowUnsigned },
      commandKey: cfg.keys[0] ?? null,
    });
    this.ingest.on('report', (p, _a, at) => this.onReport(p, at));
    this.ingest.on('raw', (p, _a, at) => this.onRaw(p, at));
    this.ingest.on('status', (p, _a, at) => this.onStatus(p, at));
    this.latest = this.engine.snapshot(Date.now());
  }

  start(): void {
    this.ingest.start();
    this.publishTimer = setInterval(() => this.tick(Date.now()), this.cfg.publishMs);
  }

  async stop(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    await this.ingest.stop();
    await this.recorder.close();
  }

  tick(now: number): OccupancySnapshot {
    this.latest = this.engine.snapshot(now);
    this.publisher.publish(this.latest);
    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastRecordedMinute) {
      this.lastRecordedMinute = minute;
      this.recorder.snapshot(this.latest);
    }
    this.emit('snapshot', this.latest);
    return this.latest;
  }

  private infoFor(uid: string): NodeInfo {
    let i = this.info.get(uid);
    if (!i) {
      i = { lastReport: null, lastReportAt: null, status: null, statusAt: null, lastRaw: null };
      this.info.set(uid, i);
    }
    return i;
  }

  private onReport(p: Report, at: number): void {
    const i = this.infoFor(p.uid);
    i.lastReport = p;
    i.lastReportAt = at;
    const dets = this.engine.ingest(p, at);
    this.recorder.report(p, at);
    const node = this.reg.nodes.get(p.uid);
    const dwell = node ? this.dwell.get(node.floorId) : undefined;
    if (dwell) {
      const dt = Math.max(0.2, Math.min(5, 1 / Math.max(this.ingest.frameRate(p.uid), 0.2)));
      for (const d of dets) if (d.counted) dwell.add(d.floorX, d.floorY, d.persons * dt, at);
    }
    this.emit('report', p.uid, dets, at);
  }

  private onRaw(p: Raw, at: number): void {
    const msg: RawFrameMessage = { uid: p.uid, frame: p.frame, tMin: p.tMin, step: p.step, pixels: Array.from(p.pixels), receivedAt: at };
    this.infoFor(p.uid).lastRaw = msg;
    this.recorder.rawFrame(p, at);
    this.emit('raw', msg);
  }

  private onStatus(p: Status, at: number): void {
    const i = this.infoFor(p.uid);
    i.status = p;
    i.statusAt = at;
  }

  lastRaw(uid: string): RawFrameMessage | null {
    return this.info.get(uid)?.lastRaw ?? null;
  }

  nodes(now = Date.now()): NodeHealth[] {
    const uids = new Set([...this.reg.nodes.keys(), ...this.ingest.links.keys()]);
    return [...uids].sort().map((uid) => {
      const def = this.reg.nodes.get(uid);
      const link = this.ingest.links.get(uid);
      const i = this.info.get(uid);
      const r = i?.lastReport ?? null;
      const s = i?.status ?? null;
      return {
        uid,
        label: def?.label ?? 'unregistered',
        registered: !!def,
        floorId: def?.floorId ?? null,
        owns: def?.owns ?? [],
        pose: def?.pose ?? null,
        online: !!i?.lastReportAt && now - i.lastReportAt < 10_000,
        address: link?.address ?? null,
        lastSeen: link?.lastSeen ?? null,
        firstSeen: link?.firstSeen ?? null,
        signed: link?.signed ?? false,
        boot: link?.boot ?? null,
        fps: this.ingest.frameRate(uid),
        lossRate: this.ingest.lossRate(uid),
        reports: link?.reports ?? 0,
        raws: link?.raws ?? 0,
        rejected: link?.rejected ?? 0,
        lastPeople: r ? r.detections.length : null,
        backgroundReady: r ? (r.flags & REPORT_BACKGROUND_READY) !== 0 : false,
        globalShift: r ? (r.flags & REPORT_GLOBAL_SHIFT) !== 0 : false,
        sceneMin: r?.sceneMin ?? null,
        sceneMax: r?.sceneMax ?? null,
        ta: r?.ta ?? null,
        status: s && i?.statusAt
          ? {
            fw: s.fw, ip: s.ip, rssi: s.rssi, channel: s.channel, heap: s.freeHeap, minHeap: s.minHeap,
            stackFree: s.stackFree, wifiDrops: s.wifiDrops, sensorErrors: s.sensorErrors, frames: s.frames,
            fps: s.fps, vdd: s.vdd, lastCmd: s.lastCmd, params: s.params as Record<string, number>,
            receivedAt: i.statusAt,
          }
          : null,
        refHeat: this.engine.refHeat(uid),
      };
    });
  }

  health(now = Date.now()): EdgeHealth {
    const rates = this.ingest.rates();
    return {
      edgeId: this.cfg.edgeId,
      version: EDGE_VERSION,
      now,
      ...this.host.sample(),
      ...rates,
      rejectReasons: Object.fromEntries(this.ingest.rejectReasons),
      unknownSources: [...this.ingest.rejectedSources.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20),
      publish: this.publisher.status,
      recorder: { dir: this.recorder.dir, bytesToday: this.recorder.bytesToday(), rawEnabled: this.recorder.rawEnabled },
      udp: { port: this.cfg.udpPort, iface: this.cfg.udpHost },
    };
  }

  /** Static layout for the console: plan, tables, seats, node poses and footprints. */
  layout() {
    return {
      site: this.reg.site,
      floors: this.reg.floors.map((f) => ({
        id: f.id, building: f.building, name: f.name, width: f.width, height: f.height, outline: f.outline,
        zones: f.zones,
        tables: f.tables.map((t) => ({ id: t.id, name: t.name, rect: t.rect, capacity: t.capacity, seats: t.seats, owner: t.owner, coveredBy: t.coveredBy })),
      })),
      nodes: [...this.reg.nodes.values()].map((n) => ({
        uid: n.uid, label: n.label, floorId: n.floorId, pose: n.pose, owns: n.owns, simulated: n.simulated,
        footprint: footprint(n.pose),
        floorFootprint: footprint(n.pose, 0),
      })),
    };
  }
}
