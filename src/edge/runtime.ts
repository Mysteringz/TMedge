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
import { GatewayServer } from './gwlink.js';
import { HostMonitor } from './health.js';
import { Ingest } from './ingest.js';
import { DEFAULT_OCCUPANCY, OccupancyEngine, type OccupancyOptions } from './occupancy.js';
import { REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, type Raw, type Report, type Status } from './protocol.js';
import { Publisher } from './publisher.js';
import { Recorder } from './recorder.js';
import { FirmwareStore } from './firmware.js';
import { join } from 'node:path';
import type { Registry } from './registry.js';
import { Rollouts } from './rollout.js';

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
  on(event: 'rgb', l: (uid: string, jpeg: Buffer, at: number) => void): this;
}

export class EdgeRuntime extends EventEmitter {
  readonly ingest: Ingest;
  readonly engine: OccupancyEngine;
  readonly recorder: Recorder;
  readonly publisher: Publisher;
  readonly host = new HostMonitor();
  readonly dwell = new Map<string, DwellMap>();
  readonly gateways: GatewayServer | null;
  private readonly info = new Map<string, NodeInfo>();
  private publishTimer: NodeJS.Timeout | null = null;
  private rolloutTimer: NodeJS.Timeout | null = null;
  readonly firmware: FirmwareStore;
  readonly rollouts: Rollouts;
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
      routeViaGateway: (address, buf) => this.gateways?.sendDownlink(address, buf) ?? false,
    });
    // Access gateways only if a token is configured: an unauthenticated
    // uplink port would let anyone on the tailnet inject datagrams (still
    // signed per node, but a flood is a flood).
    this.gateways = cfg.gatewayPort > 0 && cfg.gatewayToken
      ? new GatewayServer({
        port: cfg.gatewayPort, host: '0.0.0.0', token: cfg.gatewayToken, edgeId: cfg.edgeId,
        onUplink: (datagram, source) => this.ingest.handle(datagram, source),
        onImageReady: (gatewayId, result) => this.rollouts.onImageReady(gatewayId, result),
        log: (m) => console.log(`[edge] ${m}`),
      })
      : null;
    // Firmware uploads, builds and rollouts. The console drives these; the
    // runtime owns them so a rollout survives the console being closed.
    this.firmware = new FirmwareStore(join(cfg.dataDir, 'firmware'), { log: (m) => console.log(`[edge] ${m}`) });
    this.rollouts = new Rollouts({
      image: (buildId) => {
        const build = this.firmware.get(buildId);
        const bytes = this.firmware.bytes(buildId);
        return build && bytes ? { bytes, sha256: build.sha256, size: build.size, version: build.version } : null;
      },
      nodes: () => this.nodes().filter((n) => n.registered).map((n) => ({
        uid: n.uid, label: n.label, floorId: n.floorId, address: n.address, online: n.online,
      })),
      sendImageToGateway: (id, meta, bytes) => this.gateways?.sendImage(id, meta, bytes) ?? false,
      sendOta: (uid, image) => this.ingest.sendOta(uid, image),
      directPort: cfg.consolePort,
      log: (m) => console.log(`[edge] ${m}`),
    });
    this.ingest.on('report', (p, _a, at) => this.onReport(p, at));
    this.ingest.on('raw', (p, _a, at) => this.onRaw(p, at));
    this.ingest.on('status', (p, _a, at) => this.onStatus(p, at));
    this.ingest.on('ota', (p) => this.rollouts.onOtaStatus(p.uid, p));
    this.latest = this.engine.snapshot(Date.now());
  }

  start(): void {
    this.ingest.start();
    // A rollout moves on its own: nodes report, gateways take delivery, and
    // stalled nodes have to time out even when nobody is watching a console.
    this.rolloutTimer = setInterval(() => this.rollouts.tick(), 1000);
    this.rolloutTimer.unref();
    void this.gateways?.listen().then((p) => console.log(`[edge] access gateways: TCP 0.0.0.0:${p} (TMGW v1)`));
    this.publishTimer = setInterval(() => this.tick(Date.now()), this.cfg.publishMs);
  }

  async stop(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    if (this.rolloutTimer) clearInterval(this.rolloutTimer);
    await this.ingest.stop();
    await this.gateways?.close();
    await this.recorder.close();
  }

  tick(now: number): OccupancySnapshot {
    this.latest = this.engine.snapshot(now);
    this.publisher.publish(this.publicSnapshot(this.latest));
    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastRecordedMinute) {
      this.lastRecordedMinute = minute;
      this.recorder.snapshot(this.latest);
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
      gateways: this.gateways?.gateways() ?? [],
      gatewayPort: this.gateways ? this.cfg.gatewayPort : null,
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
        footprint: footprint(n.pose),
        floorFootprint: footprint(n.pose, 0),
      })),
    };
  }
}
