/**
 * Detections from many nodes -> which seats are taken.
 *
 * 1. Project. Each blob's centroid goes through the node's pose to a plan
 *    point at seated-head height.
 * 2. Decide who counts. Nodes overlap heavily (one per desk, each seeing
 *    8-14 m of floor), so every person is seen several times. For each table,
 *    exactly one node is its *authority* at any moment: the owner if it is
 *    healthy, else the nearest healthy node that sees every seat of it, else
 *    nobody -- and then the table is unknown, never empty. Only the
 *    authority's detections move that table's seats. People not at a table
 *    are counted by the nearest healthy node that sees them. Either way each
 *    person is counted once. (Phase 3 replaces "nearest" with learned overlap.)
 * 3. Seat. People at a table claim its nearest free seats. A blob whose heat
 *    is ~2x a typical person here claims two: at 5 m, neighbours can merge.
 *    A table never reports more people than seats; the zone still counts
 *    everyone.
 * 4. Smooth. A seat becomes taken after 3 of the last 5 frames and is released
 *    only after RELEASE_MS without anyone on it, so a student leaning back or
 *    a blob flickering between frames does not flip the seat.
 */
import { floorToPixel, pixelAreaCm2, pixelToFloor, pointInPolygon } from '../shared/geometry.js';
import type {
  ConsoleDetection,
  CoverageStatus,
  FloorState,
  OccupancySnapshot,
  SeatState,
  TableState,
  ZoneState,
} from '../shared/types.js';
import { REPORT_BACKGROUND_READY, REPORT_GLOBAL_SHIFT, type Report } from './protocol.js';
import type { NodeDef, Registry, TableDef } from './registry.js';

export interface OccupancyOptions {
  /** A node silent this long is not trusted. */
  staleMs: number;
  /** A seat stays taken this long after it was last seen occupied. */
  releaseMs: number;
  /** A blob further than this from every seat is not at a table. */
  seatRadiusCm: number;
  /** Frames considered for taking a seat, and how many must show someone. */
  enterWindow: number;
  enterMin: number;
  /**
   * Blobs from one node closer than this on the floor are one person. The
   * detector splits in pixels, and near the edge of a 110 deg view one hunched
   * person (head and back) can come out as two peaks ~45 cm apart -- measured
   * on the intern rig, where it put one person in both seats of a desk. Two
   * Distance alone cannot decide it: chairs back to back at neighbouring
   * makerspace tables are 45 cm apart, and merging on distance fused those two
   * real people (seat accuracy fell from 98% to 86.5% in simulation). A split
   * piece is small next to the rest of its person, while a neighbour is a whole
   * person of similar heat -- so blobs merge only when close AND the smaller
   * one carries under FRAGMENT_RATIO of the larger one's heat.
   */
  mergeCm: number;
}

export const DEFAULT_OCCUPANCY: OccupancyOptions = {
  staleMs: 10_000,
  releaseMs: 20_000,
  seatRadiusCm: 80,
  enterWindow: 5,
  enterMin: 3,
  mergeCm: 50,
};

interface NodeState {
  lastReportAt: number;
  healthy: boolean;
  /**
   * Recent blob heats, normalised to floor area (C*m^2); the median is one
   * person. Raw heat (C*px) cannot be compared across the view: at 110 deg a
   * pixel at the edge covers ~2x the floor of one under the node, so the same
   * person is ~2x the heat in the middle -- which read as "two people merged"
   * and put phantom neighbours on the seats nearest each node (measured: 86%
   * seat accuracy against simulator truth before this, see git history).
   */
  heats: number[];
  /** Everyone this node counted outside tables, per zone, over recent frames. */
  zoneHistory: Map<string, number[]>;
  lastDetections: ConsoleDetection[];
}

interface SeatTrack {
  window: boolean[];
  occupied: boolean;
  lastSeenAt: number;
  framesSeen: number;
}

interface TableTrack {
  authority: string | null;
  /** Everyone the authority saw at this table over recent frames, uncapped. */
  peopleHistory: number[];
  unknownSince: number | null;
}

/** Median: raw per-frame counts jitter as blobs split and merge. */
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

const HEAT_SAMPLES = 300;
const FRAGMENT_RATIO = 0.4;
const HEAT_MIN_SAMPLES = 30;
const ZONE_WINDOW = 7;

export class OccupancyEngine {
  private readonly nodes = new Map<string, NodeState>();
  private readonly seats = new Map<string, SeatTrack>();
  private readonly tables = new Map<string, TableTrack>();

  constructor(
    private readonly reg: Registry,
    private readonly edgeId: string,
    private opts: OccupancyOptions = DEFAULT_OCCUPANCY,
  ) {
    for (const t of reg.tables.values()) {
      this.tables.set(t.id, { authority: null, peopleHistory: [], unknownSince: null });
      for (const s of t.seats) this.seats.set(s.id, { window: [], occupied: false, lastSeenAt: 0, framesSeen: 0 });
    }
  }

  /** What the engine is running on right now. */
  options(): OccupancyOptions {
    return { ...this.opts };
  }

  /**
   * Change a tuning value while the edge is running, for the algo debugger.
   * Every field is clamped here rather than trusted: these numbers decide what
   * students are told about a real room, and the caller is a web request.
   */
  setOptions(patch: Partial<OccupancyOptions>): OccupancyOptions {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const next = { ...this.opts };
    if (patch.staleMs !== undefined) next.staleMs = clamp(patch.staleMs, 2_000, 120_000);
    if (patch.releaseMs !== undefined) next.releaseMs = clamp(patch.releaseMs, 2_000, 300_000);
    if (patch.seatRadiusCm !== undefined) next.seatRadiusCm = clamp(patch.seatRadiusCm, 20, 300);
    if (patch.enterWindow !== undefined) next.enterWindow = Math.round(clamp(patch.enterWindow, 1, 60));
    if (patch.enterMin !== undefined) next.enterMin = Math.round(clamp(patch.enterMin, 1, 60));
    if (patch.mergeCm !== undefined) next.mergeCm = clamp(patch.mergeCm, 0, 200);
    // A window that needs more frames than it holds would never seat anyone.
    next.enterMin = Math.min(next.enterMin, next.enterWindow);
    this.opts = next;
    return { ...next };
  }

  /** Floor-normalised heat (C*m^2) of a typical single person in this node's view, once learned. */
  refHeat(uid: string): number | null {
    const st = this.nodes.get(uid);
    if (!st || st.heats.length < HEAT_MIN_SAMPLES) return null;
    const sorted = [...st.heats].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  lastDetections(uid: string): ConsoleDetection[] {
    return this.nodes.get(uid)?.lastDetections ?? [];
  }

  /** Current authority per table, for the console. */
  authorities(): Record<string, { authority: string | null; status: CoverageStatus }> {
    const out: Record<string, { authority: string | null; status: CoverageStatus }> = {};
    for (const t of this.reg.tables.values()) {
      const a = this.authorityFor(t, Number.NaN);
      out[t.id] = { authority: a, status: this.statusFor(t, a) };
    }
    return out;
  }

  ingest(report: Report, at: number): ConsoleDetection[] {
    const node = this.reg.nodes.get(report.uid);
    let st = this.nodes.get(report.uid);
    if (!st) {
      st = { lastReportAt: at, healthy: false, heats: [], zoneHistory: new Map(), lastDetections: [] };
      this.nodes.set(report.uid, st);
    }
    st.lastReportAt = at;
    // A node still learning its background, or whose whole scene just moved,
    // reports nothing useful: it must not be anyone's authority this frame.
    st.healthy = (report.flags & REPORT_BACKGROUND_READY) !== 0 && (report.flags & REPORT_GLOBAL_SHIFT) === 0;

    if (!node) {
      st.lastDetections = report.detections.map((d) => ({
        ...d, floorX: Number.NaN, floorY: Number.NaN, tableId: null, counted: false, persons: 1,
      }));
      return st.lastDetections;
    }

    const ref = this.refHeat(report.uid);
    const normHeat = (d: { x: number; y: number; heat: number }) => (d.heat * pixelAreaCm2(node.pose, d.x, d.y)) / 10_000;

    const floor = this.reg.floors.find((f) => f.id === node.floorId);
    const dets: ConsoleDetection[] = this.mergeClose(report.detections.map((d) => {
      const [fx, fy] = pixelToFloor(node.pose, d.x, d.y);
      return { ...d, floorX: fx, floorY: fy, norm: normHeat(d) };
    })).map(({ norm, ...d }) => {
      const ratio = ref ? norm / ref : 1;
      const persons = ratio < 1.6 ? 1 : ratio < 2.5 ? 2 : 3;
      return { ...d, tableId: this.nearestTable(node.floorId, d.floorX, d.floorY), counted: false, persons, norm };
    }).map(({ norm, ...d }) => {
      // Learn "one person" only from blobs on a seat. Anything else -- a warm
      // chair, a laptop, a radiator -- sits in view every frame and would drag
      // the reference down until every real person read as two (seen on the
      // intern rig: one seated intern took both seats of the desk).
      if (d.tableId) {
        st.heats.push(norm);
        if (st.heats.length > HEAT_SAMPLES) st.heats.shift();
      }
      return d;
    });

    // Tables this node is currently the authority for get this frame's seats.
    const byTable = new Map<string, ConsoleDetection[]>();
    for (const d of dets) {
      if (!d.tableId) continue;
      const list = byTable.get(d.tableId) ?? [];
      list.push(d);
      byTable.set(d.tableId, list);
    }
    for (const table of this.reg.tables.values()) {
      if (table.floorId !== node.floorId) continue;
      const authority = this.authorityFor(table, at);
      const track = this.tables.get(table.id);
      if (!track) continue;
      track.authority = authority;
      if (authority !== report.uid || !st.healthy) continue;
      const here = byTable.get(table.id) ?? [];
      for (const d of here) d.counted = true;
      track.peopleHistory.push(here.reduce((a, d) => a + d.persons, 0));
      if (track.peopleHistory.length > ZONE_WINDOW) track.peopleHistory.shift();
      this.updateSeats(table, this.assignSeats(table, here), at);
    }

    // People away from tables: counted by the nearest healthy node that sees them.
    if (floor && st.healthy) {
      for (const zone of floor.zones) {
        let n = 0;
        for (const d of dets) {
          if (d.tableId || !pointInPolygon([d.floorX, d.floorY], zone.polygon)) continue;
          if (this.nearestHealthyViewer(node.floorId, d.floorX, d.floorY, at) !== report.uid) continue;
          d.counted = true;
          n += d.persons;
        }
        const hist = st.zoneHistory.get(zone.id) ?? [];
        hist.push(n);
        if (hist.length > ZONE_WINDOW) hist.shift();
        st.zoneHistory.set(zone.id, hist);
      }
    }

    st.lastDetections = dets;
    return dets;
  }

  snapshot(now: number): OccupancySnapshot {
    const floors: FloorState[] = this.reg.floors.map((floor) => {
      const tables: TableState[] = floor.tables.map((t) => this.tableState(t, now));
      const zones: ZoneState[] = floor.zones.map((z) => {
        const zt = tables.filter((t) => t.zoneId === z.id);
        const anyUnknown = zt.some((t) => t.status === 'unknown');
        let people = 0;
        for (const t of zt) people += median(this.tables.get(t.id)?.peopleHistory ?? []);
        let covered = zt.length > 0 && !anyUnknown;
        for (const [uid, st] of this.nodes) {
          if (!this.isHealthy(uid, now)) continue;
          const h = st.zoneHistory.get(z.id);
          if (!h || h.length === 0) continue;
          covered = true;
          people += median(h);
        }
        return { id: z.id, name: z.name, polygon: z.polygon, people: covered && !anyUnknown ? people : null };
      });
      const known = tables.filter((t) => t.status !== 'unknown');
      return {
        id: floor.id,
        building: floor.building,
        name: floor.name,
        width: floor.width,
        height: floor.height,
        outline: floor.outline,
        zones,
        tables,
        totals: {
          seats: tables.reduce((a, t) => a + t.capacity, 0),
          free: known.reduce((a, t) => a + (t.free ?? 0), 0),
          occupied: known.reduce((a, t) => a + (t.occupied ?? 0), 0),
          unknownSeats: tables.filter((t) => t.status === 'unknown').reduce((a, t) => a + t.capacity, 0),
          tablesFullyFree: known.filter((t) => t.occupied === 0).length,
        },
      };
    });
    return { version: 1, edgeId: this.edgeId, site: this.reg.site, generatedAt: now, floors };
  }

  // --- internals -------------------------------------------------------------

  private isHealthy(uid: string, now: number): boolean {
    const st = this.nodes.get(uid);
    if (!st || !st.healthy) return false;
    // NaN `now` means "as of the last frame" (console use): only health counts.
    return Number.isNaN(now) || now - st.lastReportAt <= this.opts.staleMs;
  }

  private authorityFor(table: TableDef, now: number): string | null {
    for (const uid of table.coveredBy) if (this.isHealthy(uid, now)) return uid;
    return null;
  }

  private statusFor(table: TableDef, authority: string | null): CoverageStatus {
    if (!authority) return 'unknown';
    return authority === table.owner ? 'ok' : 'fallback';
  }

  /**
   * Single-linkage clustering of one node's blobs on the floor: anything
   * within mergeCm of a blob already in a cluster joins it. The cluster keeps
   * the pixel position of its largest member (for the console overlay), a
   * heat-weighted floor position, and the summed heat and area.
   */
  private mergeClose<T extends { x: number; y: number; area: number; contrast: number; peak: number; heat: number; floorX: number; floorY: number; norm: number }>(blobs: T[]): T[] {
    const n = blobs.length;
    const group = blobs.map((_, i) => i);
    const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i] ?? i)));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = blobs[i];
        const b = blobs[j];
        if (!a || !b || Math.hypot(a.floorX - b.floorX, a.floorY - b.floorY) >= this.opts.mergeCm) continue;
        const small = Math.min(a.norm, b.norm);
        const large = Math.max(a.norm, b.norm);
        if (large > 0 && small / large < FRAGMENT_RATIO) group[root(i)] = root(j);
      }
    }
    const byRoot = new Map<number, T[]>();
    blobs.forEach((b, i) => {
      const list = byRoot.get(root(i)) ?? [];
      list.push(b);
      byRoot.set(root(i), list);
    });
    return [...byRoot.values()].map((members) => {
      if (members.length === 1) return members[0] as T;
      const largest = members.reduce((a, b) => (b.area > a.area ? b : a));
      const w = members.reduce((a, b) => a + Math.max(b.norm, 1e-6), 0);
      return {
        ...largest,
        floorX: members.reduce((a, b) => a + b.floorX * Math.max(b.norm, 1e-6), 0) / w,
        floorY: members.reduce((a, b) => a + b.floorY * Math.max(b.norm, 1e-6), 0) / w,
        area: members.reduce((a, b) => a + b.area, 0),
        heat: members.reduce((a, b) => a + b.heat, 0),
        norm: members.reduce((a, b) => a + b.norm, 0),
        contrast: Math.max(...members.map((b) => b.contrast)),
        peak: Math.max(...members.map((b) => b.peak)),
      };
    });
  }

  private nearestTable(floorId: string, x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const t of this.reg.tables.values()) {
      if (t.floorId !== floorId) continue;
      const radius = t.seatRadiusCm ?? this.opts.seatRadiusCm;
      for (const s of t.seats) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= radius && d < bestD) {
          bestD = d;
          best = t.id;
        }
      }
    }
    return best;
  }

  private nearestHealthyViewer(floorId: string, x: number, y: number, now: number): string | null {
    let best: NodeDef | null = null;
    let bestD = Infinity;
    for (const n of this.reg.nodes.values()) {
      if (n.floorId !== floorId || !this.isHealthy(n.uid, now) || !floorToPixel(n.pose, x, y)) continue;
      const d = Math.hypot(n.pose.x - x, n.pose.y - y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best?.uid ?? null;
  }

  /** Seats claimed this frame: each person takes the nearest seat still free. */
  private assignSeats(table: TableDef, dets: ConsoleDetection[]): Set<string> {
    const pairs: { d: number; det: ConsoleDetection; seat: string }[] = [];
    for (const det of dets) {
      for (const s of table.seats) {
        const dist = Math.hypot(s.x - det.floorX, s.y - det.floorY);
        // A blob holding two people spans two seats; let it reach one seat further.
        if (dist <= (table.seatRadiusCm ?? this.opts.seatRadiusCm) + (det.persons > 1 ? 60 : 0)) pairs.push({ d: dist, det, seat: s.id });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const remaining = new Map(dets.map((d) => [d, d.persons]));
    const taken = new Set<string>();
    for (const p of pairs) {
      const left = remaining.get(p.det) ?? 0;
      if (left <= 0 || taken.has(p.seat)) continue;
      taken.add(p.seat);
      remaining.set(p.det, left - 1);
    }
    return taken;
  }

  private updateSeats(table: TableDef, observed: Set<string>, at: number): void {
    for (const s of table.seats) {
      const track = this.seats.get(s.id);
      if (!track) continue;
      const seen = observed.has(s.id);
      track.window.push(seen);
      if (track.window.length > this.opts.enterWindow) track.window.shift();
      track.framesSeen += 1;
      if (seen) track.lastSeenAt = at;
      if (!track.occupied) {
        if (track.window.filter(Boolean).length >= this.opts.enterMin) {
          track.occupied = true;
          track.lastSeenAt = at;
        }
      } else if (at - track.lastSeenAt > this.opts.releaseMs) {
        track.occupied = false;
      }
    }
  }

  private tableState(t: TableDef, now: number): TableState {
    const authority = this.authorityFor(t, now);
    const status = this.statusFor(t, authority);
    const track = this.tables.get(t.id);
    if (track) {
      if (status === 'unknown') {
        track.unknownSince ??= now;
        // Blind for longer than a seat is held: what we knew is stale. Start
        // over when coverage returns rather than resurrecting old seats.
        if (now - track.unknownSince > this.opts.releaseMs) {
          for (const s of t.seats) this.seats.set(s.id, { window: [], occupied: false, lastSeenAt: 0, framesSeen: 0 });
          track.peopleHistory = [];
        }
      } else {
        track.unknownSince = null;
      }
    }
    // Still warming up: fewer frames than it takes to decide a seat.
    const warm = t.seats.every((s) => (this.seats.get(s.id)?.framesSeen ?? 0) >= this.opts.enterWindow);
    const known = status !== 'unknown' && warm;
    const seats: SeatState[] = t.seats.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      side: s.side,
      index: s.index,
      neighbors: s.neighbors,
      occupied: known ? (this.seats.get(s.id)?.occupied ?? false) : null,
    }));
    const occupied = known ? seats.filter((s) => s.occupied).length : null;
    return {
      id: t.id,
      name: t.name,
      zoneId: t.zoneId,
      rect: t.rect,
      capacity: t.capacity,
      occupied,
      free: occupied === null ? null : t.capacity - occupied,
      status: known ? status : 'unknown',
      seats,
    };
  }
}

