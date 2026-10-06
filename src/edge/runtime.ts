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
import { EdgeDetector } from './edgedetect.js';
import { join } from 'node:path';
import { HostMonitor } from './health.js';
import type { Ingest } from './ingest.js';
import type { OccupancyEngine } from './occupancy.js';
import { REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, type Raw, type Report, type Status } from './protocol.js';
import type { Recorder } from './recorder.js';
import type { FirmwareStore } from './firmware.js';
import type { Registry } from './registry.js';
import type { Rollouts } from './rollout.js';
import type { GatewayServer } from './gwlink.js';
import type { NodeServer } from './nodelink.js';
import type { Publisher } from './publisher.js';
import type { BoundedOccupancyHistorySink } from '../modules/occupancy-history/application/bounded-occupancy-history-sink.js';
import type { DurableCommandOutcomes } from '../modules/nodes/application/durable-command-outcomes.js';
import type { RolloutService } from '../modules/rollouts/application/rollout-service.js';
import { StaticBackground } from './staticbg.js';

export const EDGE_VERSION = '1.0.0';

interface NodeInfo {
  lastReport: Report | null;
  lastReportAt: number | null;
  status: Status | null;
  statusAt: number | null;
  lastRaw: RawFrameMessage | null;
  /** An edge-detected node's own REPORT: kept for its ambient reading, never counted. */
  nodeReport: Report | null;
}

export declare interface EdgeRuntime {
  on(event: 'report', l: (uid: string, dets: ConsoleDetection[], at: number) => void): this;
  on(event: 'raw', l: (msg: RawFrameMessage) => void): this;
  on(event: 'snapshot', l: (s: OccupancySnapshot) => void): this;
  on(event: 'rgb', l: (uid: string, jpeg: Buffer, at: number) => void): this;
  off(event: 'report', l: (uid: string, dets: ConsoleDetection[], at: number) => void): this;
  off(event: 'raw', l: (msg: RawFrameMessage) => void): this;
  off(event: 'snapshot', l: (s: OccupancySnapshot) => void): this;
  off(event: 'rgb', l: (uid: string, jpeg: Buffer, at: number) => void): this;
}

/** Dependencies supplied by the edge composition root. */
export interface EdgeRuntimeServices {
  ingest: Ingest;
  engine: OccupancyEngine;
  recorder: Recorder;
  publisher: Publisher;
  gateways: GatewayServer | null;
  direct: NodeServer | null;
  firmware: FirmwareStore;
  rollouts: Rollouts;
  occupancyHistory?: BoundedOccupancyHistorySink;
  commandOutcomes?: DurableCommandOutcomes;
  rolloutService?: RolloutService;
  persistenceAvailable?: () => Promise<boolean>;
}

export class EdgeRuntime extends EventEmitter {
  readonly ingest: Ingest;
  readonly engine: OccupancyEngine;
  readonly recorder: Recorder;
  readonly publisher: Publisher;
  readonly host = new HostMonitor();
  readonly dwell = new Map<string, DwellMap>();
  readonly gateways: GatewayServer | null;
  /** Nodes that reach this edge directly over WSS (NODE_PORT); null when off. */
  readonly direct: NodeServer | null;
  private readonly info = new Map<string, NodeInfo>();
  /** Per node with detector "edge", created on its first RAW. */
  readonly edgeDetectors = new Map<string, EdgeDetector>();
  private publishTimer: NodeJS.Timeout | null = null;
  private rolloutTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private started = false;
  readonly firmware: FirmwareStore;
  readonly rollouts: Rollouts;
  readonly occupancyHistory: BoundedOccupancyHistorySink | null;
  readonly commandOutcomes: DurableCommandOutcomes | null;
  readonly rolloutService: RolloutService;
  readonly persistenceAvailable: (() => Promise<boolean>) | null;
  private lastRecordedMinute = -1;
  latest: OccupancySnapshot;

  get isStarted(): boolean {
    return this.started;
  }

  constructor(readonly cfg: EdgeConfig, readonly reg: Registry, services: EdgeRuntimeServices = {} as EdgeRuntimeServices) {
    super();
    this.engine = services.engine;
    this.recorder = services.recorder;
    this.publisher = services.publisher;
    this.ingest = services.ingest;
    this.gateways = services.gateways;
    this.direct = services.direct;
    this.firmware = services.firmware;
    this.rollouts = services.rollouts;
    this.occupancyHistory = services.occupancyHistory ?? null;
    this.commandOutcomes = services.commandOutcomes ?? null;
    this.rolloutService = services.rolloutService ?? services.rollouts;
    this.persistenceAvailable = services.persistenceAvailable ?? null;
    for (const f of reg.floors) this.dwell.set(f.id, new DwellMap(f.width, f.height));
    this.ingest.on('report', (p, _a, at) => this.onReport(p, at));
    this.ingest.on('raw', (p, _a, at) => this.onRaw(p, at));
    this.ingest.on('status', (p, _a, at) => this.onStatus(p, at));
    this.ingest.on('ota', (p) => setImmediate(() => this.rollouts.onOtaStatus(p.uid, p)));
    this.latest = this.engine.snapshot(Date.now());
  }

  /**
   * Bind the direct node listener. Awaited by main: a listener that was
   * configured and cannot bind must stop the service, not leave an edge that
   * looks healthy while every direct node is shut out.
   */
  start(): void {
    if (this.started || this.stopPromise) return;
    this.started = true;
    // A rollout moves on its own: nodes report, gateways take delivery, and
    // stalled nodes have to time out even when nobody is watching a console.
    this.rolloutTimer = setInterval(() => {
      const tick = this.rolloutService.tick?.();
      if (tick instanceof Promise) void tick.catch(() => console.error('[edge] rollout persistence unavailable; dispatch paused'));
      else if (!this.rolloutService.tick) this.rollouts.tick();
    }, 1000);
    this.rolloutTimer.unref();
    this.publishTimer = setInterval(() => this.tick(Date.now()), this.cfg.publishMs);
    this.publishTimer.unref();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.started = false;
    if (this.publishTimer) clearInterval(this.publishTimer);
    if (this.rolloutTimer) clearInterval(this.rolloutTimer);
    this.publishTimer = null;
    this.rolloutTimer = null;
    this.stopPromise = this.stopComponents();
    return this.stopPromise;
  }

  private async stopComponents(): Promise<void> {
    const transportResults = await Promise.allSettled([
      this.ingest.stop(),
      this.gateways?.close() ?? Promise.resolve(),
      this.direct?.close() ?? Promise.resolve(),
    ]);
    const drainResults = await Promise.allSettled([
      this.recorder.close(),
      this.occupancyHistory?.dispose() ?? Promise.resolve(),
      this.commandOutcomes?.dispose() ?? Promise.resolve(),
      this.rolloutService.dispose?.() ?? Promise.resolve(),
    ]);
    const failure = [...transportResults, ...drainResults].find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  tick(now: number): OccupancySnapshot {
    this.latest = this.engine.snapshot(now);
    this.publisher.publish(this.publicSnapshot(this.latest));
    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastRecordedMinute) {
      this.lastRecordedMinute = minute;
      this.recorder.snapshot(this.latest);
      this.occupancyHistory?.enqueue(this.latest);
    }
    this.emit('snapshot', this.latest);
    return this.latest;
  }

  /**
   * What the web tier gets: public floors only. Console-only floors (demo
   * rigs, test spaces) stay on the edge -- students never see them.
   */
  publicSnapshot(s: OccupancySnapshot): OccupancySnapshot {
    const pub = new Set(this.reg.floors.filter((f) => f.visibility === 'public').map((f) => f.id));
    return { ...s, floors: s.floors.filter((f) => pub.has(f.id)) };
  }

  /** Latest RGB frame per RGB-enabled node: memory only, never recorded. */
  readonly rgb = new Map<string, { jpeg: Buffer; at: number }>();

  acceptRgb(uid: string, jpeg: Buffer, at: number): void {
    this.rgb.set(uid, { jpeg, at });
    this.emit('rgb', uid, jpeg, at);
  }

  private infoFor(uid: string): NodeInfo {
    let i = this.info.get(uid);
    if (!i) {
      i = { lastReport: null, lastReportAt: null, status: null, statusAt: null, lastRaw: null, nodeReport: null };
      this.info.set(uid, i);
    }
    return i;
  }

  /** True when this edge, not the node, finds the node's people. */
  private detectsHere(uid: string): boolean {
    return this.reg.nodes.get(uid)?.detector === 'edge';
  }

  private edgeDetector(uid: string): EdgeDetector {
    let d = this.edgeDetectors.get(uid);
    if (!d) {
      const file = join(this.cfg.dataDir, 'background', `${uid.replace(/:/g, '')}.json`);
      d = new EdgeDetector(new StaticBackground(file));
      this.edgeDetectors.set(uid, d);
    }
    return d;
  }

  private onReport(p: Report, at: number): void {
    if (this.detectsHere(p.uid)) {
      // The node's verdict comes from the background that forgets people who
      // sit still; its RAW frame is what gets counted (onRaw). The REPORT
      // still arrives -- it keeps the frame rate and liveness honest.
      this.infoFor(p.uid).nodeReport = p;
      return;
    }
    this.acceptReport(p, at);
  }

  private acceptReport(p: Report, at: number): void {
    const i = this.infoFor(p.uid);
    i.lastReport = p;
    i.lastReportAt = at;
    const dets = this.engine.ingest(p, at);
    this.recorder.report(p, at);
    const node = this.reg.nodes.get(p.uid);
    const dwell = node?.floorId ? this.dwell.get(node.floorId) : undefined;
    if (dwell) {
      const dt = Math.max(0.2, Math.min(5, 1 / Math.max(this.ingest.frameRate(p.uid), 0.2)));
      for (const d of dets) if (d.counted) dwell.add(d.floorX, d.floorY, d.persons * dt, at);
    }
    this.emit('report', p.uid, dets, at);
  }

  private onRaw(p: Raw, at: number): void {
    const msg: RawFrameMessage = { uid: p.uid, frame: p.frame, tMin: p.tMin, step: p.step, pixels: Array.from(p.pixels), receivedAt: at };
    const i = this.infoFor(p.uid);
    i.lastRaw = msg;
    this.recorder.rawFrame(p, at);
    this.emit('raw', msg);
    if (this.detectsHere(p.uid)) {
      const ta = i.nodeReport?.ta ?? i.status?.ta ?? 0;
      this.acceptReport(this.edgeDetector(p.uid).step(p, at, ta), at);
    }
  }

  private onStatus(p: Status, at: number): void {
    const i = this.infoFor(p.uid);
    i.status = p;
    i.statusAt = at;
    this.commandOutcomes?.observeStatus(p.uid, p.lastCmd);
  }

  lastRaw(uid: string): RawFrameMessage | null {
    return this.info.get(uid)?.lastRaw ?? null;
  }

  /**
   * The node's own last REPORT. The algo debugger pairs it with the RAW of
   * the same `frame`, which is the only way to show what the sensor decided
   * about a picture rather than what something here would decide.
   */
  lastReport(uid: string): Report | null {
    return this.info.get(uid)?.lastReport ?? null;
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
        transport: link ? (link.route?.kind ?? null) : null,
        direct: this.directInfo(uid),
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
        detector: def?.detector ?? 'node',
        edgeBackground: this.edgeDetectors.get(uid)?.state(now) ?? null,
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

  private directInfo(uid: string): NodeHealth['direct'] {
    if (!this.direct) return null;
    const { session: s, history: h } = this.direct.nodeInfo(uid);
    if (!s && !h) return null;
    return {
      connected: !!s,
      sessionId: s?.sessionId ?? null,
      source: s?.source ?? null,
      connectedAt: s?.connectedAt ?? null,
      lastAcceptedAt: s?.lastAcceptedAt ?? null,
      lastReportAt: s?.lastReportAt ?? null,
      acks: s?.acks ?? 0,
      rejected: s?.rejected ?? 0,
      lastRejection: s?.lastRejection ?? null,
      previousKey: (s?.keyIndex ?? 0) > 0,
      connects: h?.connects ?? 0,
      lastDisconnectAt: h?.lastDisconnectAt ?? null,
      lastDisconnectReason: h?.lastDisconnectReason ?? null,
    };
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
      recorder: {
        dir: this.recorder.dir,
        bytesToday: this.recorder.bytesToday(),
        rawEnabled: this.recorder.rawEnabled,
        health: this.recorder.health(),
      },
      udp: { port: this.cfg.udpPort, iface: this.cfg.udpHost },
      gateways: this.gateways?.gateways() ?? [],
      gatewayPort: this.gateways ? this.cfg.gatewayPort : null,
      nodeListener: this.direct ? { port: this.cfg.nodePort, host: this.cfg.nodeHost, ...this.direct.stats() } : null,
    };
  }

  /** Static layout for the console: plan, tables, seats, node poses and footprints. */
  layout() {
    return {
      site: this.reg.site,
      floors: this.reg.floors.map((f) => ({
        id: f.id, visibility: f.visibility, building: f.building, name: f.name, width: f.width, height: f.height, outline: f.outline,
        zones: f.zones,
        tables: f.tables.map((t) => ({ id: t.id, name: t.name, rect: t.rect, capacity: t.capacity, seats: t.seats, owner: t.owner, coveredBy: t.coveredBy })),
      })),
      nodes: [...this.reg.nodes.values()].map((n) => ({
        uid: n.uid, label: n.label, floorId: n.floorId, pose: n.pose, owns: n.owns, simulated: n.simulated, rgb: n.rgb,
        // An unplaced node has no pose, so it draws no footprint on any
        // plan; the console lists it separately instead.
        footprint: n.pose ? footprint(n.pose) : null,
        floorFootprint: n.pose ? footprint(n.pose, 0) : null,
      })),
    };
  }
}
