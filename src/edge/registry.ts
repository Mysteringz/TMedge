/**
 * Site configuration: floors, tables, seats, and where each node is.
 *
 *   config/site.json    floors, zones, tables (safe to share: no secrets)
 *   config/nodes.json   node MAC -> floor, pose, tables it owns
 *
 * Validation is strict on purpose. A typo that makes a table silently never
 * fill is far worse than refusing to start: an unknown field, a table owned
 * by two nodes, or a pose that cannot see the table it owns all stop the edge
 * with a message saying exactly where.
 */
import { readFileSync } from 'node:fs';
import { floorToPixel, GRID_H, GRID_W } from '../shared/geometry.js';
import { generateSeats, type SeatSpec } from '../shared/seats.js';
import type { NodePose, Point, Rect } from '../shared/types.js';

export interface TableDef {
  id: string;
  name: string;
  floorId: string;
  zoneId: string;
  rect: Rect;
  capacity: number;
  seats: SeatSpec[];
  /**
   * How far from a seat a person can be and still be on it, cm. Overrides the
   * site default (80) for compact layouts, where a person at the next piece of
   * furniture would otherwise land inside a seat's radius.
   */
  seatRadiusCm: number | null;
  /** Nodes that see every seat of this table: the owner first, then fallbacks. */
  coveredBy: string[];
  owner: string | null;
}

export interface ZoneDef {
  id: string;
  name: string;
  polygon: Point[];
}

/**
 * public   published to the web tier (students)
 * console  edge console only: demo and test spaces that must never reach
 *          students, e.g. the RGB-verified intern desk
 */
export type Visibility = 'public' | 'console';

export interface FloorDef {
  id: string;
  visibility: Visibility;
  building: string;
  name: string;
  width: number;
  height: number;
  outline: Point[];
  zones: ZoneDef[];
  tables: TableDef[];
}

export interface NodeDef {
  uid: string;
  label: string;
  floorId: string;
  pose: NodePose;
  owns: string[];
  simulated: boolean;
  /**
   * The node also streams an RGB camera image (verification rigs only). The
   * edge accepts RGB from no other node, keeps it in memory only, and shows
   * it only in the admin console.
   */
  rgb: boolean;
}

export interface Registry {
  site: { id: string; name: string };
  floors: FloorDef[];
  tables: Map<string, TableDef>;
  nodes: Map<string, NodeDef>;
  seatIndex: Map<string, { seat: SeatSpec; table: TableDef }>;
}

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${where}: expected an object`);
  return v as Obj;
}

function only(o: Obj, where: string, allowed: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${where}.${k}: expected a non-empty string`);
  return v;
}

function num(o: Obj, k: string, where: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${where}.${k}: expected a number in ${min}..${max}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function points(v: unknown, where: string): Point[] {
  if (!Array.isArray(v) || v.length < 3) throw new ConfigError(`${where}: expected at least 3 [x, y] points`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      throw new ConfigError(`${where}[${i}]: expected [x, y]`);
    }
    return [p[0] as number, p[1] as number];
  });
}

const UID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function loadRegistry(sitePath: string, nodesPath: string): Registry {
  const read = (p: string): unknown => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      throw new ConfigError(`${p}: ${(err as Error).message}`);
    }
  };
  return buildRegistry(read(sitePath), read(nodesPath));
}

export function buildRegistry(siteJson: unknown, nodesJson: unknown): Registry {
  const root = obj(siteJson, 'site.json');
  only(root, 'site.json', ['site', 'floors']);
  const siteObj = obj(root.site, 'site.json.site');
  only(siteObj, 'site', ['id', 'name']);
  const site = { id: str(siteObj, 'id', 'site'), name: str(siteObj, 'name', 'site') };

  if (!Array.isArray(root.floors) || root.floors.length === 0) throw new ConfigError('site.json.floors: expected a non-empty array');
  const floors: FloorDef[] = [];
  const tables = new Map<string, TableDef>();
  const seatIndex = new Map<string, { seat: SeatSpec; table: TableDef }>();

  root.floors.forEach((fv, fi) => {
    const w = `floors[${fi}]`;
    const f = obj(fv, w);
    only(f, w, ['id', 'building', 'name', 'width', 'height', 'outline', 'zones', 'tables', 'visibility']);
    if (f.visibility !== undefined && f.visibility !== 'public' && f.visibility !== 'console') {
      throw new ConfigError(`${w}.visibility: expected "public" or "console"`);
    }
    const floor: FloorDef = {
      id: str(f, 'id', w),
      visibility: f.visibility === 'console' ? 'console' : 'public',
      building: str(f, 'building', w),
      name: str(f, 'name', w),
      width: num(f, 'width', w, 100, 100000),
      height: num(f, 'height', w, 100, 100000),
      outline: points(f.outline, `${w}.outline`),
      zones: [],
      tables: [],
    };
    if (floors.some((x) => x.id === floor.id)) throw new ConfigError(`${w}: duplicate floor id "${floor.id}"`);

    if (!Array.isArray(f.zones) || f.zones.length === 0) throw new ConfigError(`${w}.zones: expected a non-empty array`);
    f.zones.forEach((zv, zi) => {
      const zw = `${w}.zones[${zi}]`;
      const z = obj(zv, zw);
      only(z, zw, ['id', 'name', 'polygon']);
      const zone: ZoneDef = { id: str(z, 'id', zw), name: str(z, 'name', zw), polygon: points(z.polygon, `${zw}.polygon`) };
      if (floor.zones.some((x) => x.id === zone.id)) throw new ConfigError(`${zw}: duplicate zone id "${zone.id}"`);
      floor.zones.push(zone);
    });

    if (!Array.isArray(f.tables)) throw new ConfigError(`${w}.tables: expected an array`);
    f.tables.forEach((tv, ti) => {
      const tw = `${w}.tables[${ti}]`;
      const t = obj(tv, tw);
      only(t, tw, ['id', 'name', 'zone', 'x', 'y', 'width', 'height', 'capacity', 'seats', 'seatRadiusCm']);
      const id = str(t, 'id', tw);
      if (tables.has(id)) throw new ConfigError(`${tw}: duplicate table id "${id}" (table ids are unique site-wide)`);
      const zoneId = str(t, 'zone', tw);
      if (!floor.zones.some((z) => z.id === zoneId)) throw new ConfigError(`${tw}.zone: no zone "${zoneId}" on floor ${floor.id}`);
      const rect: Rect = {
        x: num(t, 'x', tw, 0, floor.width),
        y: num(t, 'y', tw, 0, floor.height),
        width: num(t, 'width', tw, 20, 2000),
        height: num(t, 'height', tw, 20, 2000),
      };
      if (rect.x + rect.width > floor.width || rect.y + rect.height > floor.height) {
        throw new ConfigError(`${tw}: table extends past the floor (${floor.width} x ${floor.height} cm)`);
      }
      const capacity = num(t, 'capacity', tw, 1, 20);
      if (!Number.isInteger(capacity)) throw new ConfigError(`${tw}.capacity: must be a whole number`);
      const table: TableDef = {
        id,
        name: str(t, 'name', tw),
        floorId: floor.id,
        zoneId,
        rect,
        capacity,
        seats: t.seats === undefined ? generateSeats(id, rect, capacity) : explicitSeats(t.seats, id, capacity, floor, tw),
        seatRadiusCm: t.seatRadiusCm === undefined ? null : num(t, 'seatRadiusCm', tw, 20, 150),
        coveredBy: [],
        owner: null,
      };
      tables.set(id, table);
      floor.tables.push(table);
      for (const seat of table.seats) seatIndex.set(seat.id, { seat, table });
    });
    floors.push(floor);
  });

  const nodes = new Map<string, NodeDef>();
  const nroot = obj(nodesJson, 'nodes.json');
  only(nroot, 'nodes.json', ['nodes']);
  if (!Array.isArray(nroot.nodes)) throw new ConfigError('nodes.json.nodes: expected an array');
  nroot.nodes.forEach((nv, ni) => {
    const w = `nodes[${ni}]`;
    const n = obj(nv, w);
    only(n, w, ['uid', 'label', 'floor', 'pose', 'owns', 'simulated', 'rgb']);
    const uid = str(n, 'uid', w).toLowerCase();
    if (!UID_RE.test(uid)) throw new ConfigError(`${w}.uid: expected a MAC like 30:ed:a0:cb:f5:f8, got "${uid}"`);
    if (nodes.has(uid)) throw new ConfigError(`${w}: duplicate uid ${uid}`);
    const floorId = str(n, 'floor', w);
    const floor = floors.find((f) => f.id === floorId);
    if (!floor) throw new ConfigError(`${w}.floor: no floor "${floorId}"`);
    const p = obj(n.pose, `${w}.pose`);
    only(p, `${w}.pose`, ['x', 'y', 'heightCm', 'yawDeg', 'mirror']);
    const pose: NodePose = {
      x: num(p, 'x', `${w}.pose`, -1000, floor.width + 1000),
      y: num(p, 'y', `${w}.pose`, -1000, floor.height + 1000),
      // Below 1.5 m the sensor is at head height and the projection model
      // (people are TARGET_HEIGHT_CM tall, seen from above) stops meaning anything.
      heightCm: num(p, 'heightCm', `${w}.pose`, 150, 1500),
      yawDeg: p.yawDeg === undefined ? 0 : num(p, 'yawDeg', `${w}.pose`, -360, 360),
      mirror: p.mirror === undefined ? false : p.mirror === true,
    };
    if (p.mirror !== undefined && typeof p.mirror !== 'boolean') throw new ConfigError(`${w}.pose.mirror: expected true/false`);
    if (!Array.isArray(n.owns) || !n.owns.every((x) => typeof x === 'string')) throw new ConfigError(`${w}.owns: expected an array of table ids`);
    const owns = n.owns as string[];
    for (const tid of owns) {
      const t = tables.get(tid);
      if (!t) throw new ConfigError(`${w}.owns: no table "${tid}"`);
      if (t.floorId !== floorId) throw new ConfigError(`${w}.owns: table ${tid} is on floor ${t.floorId}, node is on ${floorId}`);
      if (t.owner) throw new ConfigError(`${w}.owns: table ${tid} is already owned by ${t.owner} -- one owner per table, or it is counted twice`);
      t.owner = uid;
    }
    if (n.simulated !== undefined && typeof n.simulated !== 'boolean') throw new ConfigError(`${w}.simulated: expected true/false`);
    if (n.rgb !== undefined && typeof n.rgb !== 'boolean') throw new ConfigError(`${w}.rgb: expected true/false`);
    // A camera image must never sit on a floor students can see.
    if (n.rgb === true && floor.visibility !== 'console') {
      throw new ConfigError(`${w}.rgb: an RGB node is only allowed on a floor with "visibility": "console"`);
    }
    nodes.set(uid, {
      uid,
      label: typeof n.label === 'string' && n.label ? n.label : uid,
      floorId,
      pose,
      owns,
      simulated: n.simulated === true,
      rgb: n.rgb === true,
    });
  });

  // Which nodes see every seat of each table. The owner must; the rest are
  // fallbacks, closest first, used only while the owner is down.
  for (const table of tables.values()) {
    const seeing = [...nodes.values()]
      .filter((n) => n.floorId === table.floorId)
      .filter((n) => table.seats.every((s) => seesWithMargin(n.pose, s.x, s.y)))
      .sort((a, b) => dist(a.pose, table) - dist(b.pose, table));
    if (table.owner && !seeing.some((n) => n.uid === table.owner)) {
      throw new ConfigError(`table ${table.id}: its owner ${table.owner} cannot see all of its seats from that pose`);
    }
    table.coveredBy = [
      ...(table.owner ? [table.owner] : []),
      ...seeing.map((n) => n.uid).filter((u) => u !== table.owner),
    ];
  }

  return { site, floors, tables, nodes, seatIndex };
}

/**
 * Seats placed by hand (or, later, learned) rather than generated: for tables
 * whose chairs do not follow the "along both long sides" pattern -- e.g. a
 * desk against a wall with every chair on one side. Seats within a metre of
 * each other count as neighbours for the "sit together" search.
 */
function explicitSeats(v: unknown, tableId: string, capacity: number, floor: FloorDef, where: string): SeatSpec[] {
  if (!Array.isArray(v) || v.length !== capacity) {
    throw new ConfigError(`${where}.seats: expected exactly ${capacity} seats (the table's capacity)`);
  }
  const seats: SeatSpec[] = v.map((sv, i) => {
    const sw = `${where}.seats[${i}]`;
    const o = obj(sv, sw);
    only(o, sw, ['id', 'x', 'y', 'side']);
    const side = o.side === undefined ? 'L' : o.side;
    if (side !== 'L' && side !== 'R' && side !== 'T' && side !== 'B') throw new ConfigError(`${sw}.side: expected L, R, T or B`);
    return {
      id: `${tableId}-${str(o, 'id', sw)}`,
      x: num(o, 'x', sw, 0, floor.width),
      y: num(o, 'y', sw, 0, floor.height),
      side,
      index: i,
      neighbors: [],
    };
  });
  if (new Set(seats.map((s) => s.id)).size !== seats.length) throw new ConfigError(`${where}.seats: duplicate seat id`);
  for (const a of seats) {
    for (const b of seats) if (a !== b && Math.hypot(a.x - b.x, a.y - b.y) <= 100) a.neighbors.push(b.id);
  }
  return seats;
}

function seesWithMargin(pose: NodePose, x: number, y: number): boolean {
  const px = floorToPixel(pose, x, y);
  return px !== null && px[0] >= 0.5 && px[0] <= GRID_W - 0.5 && px[1] >= 0.5 && px[1] <= GRID_H - 0.5;
}

function dist(pose: NodePose, t: TableDef): number {
  return Math.hypot(pose.x - (t.rect.x + t.rect.width / 2), pose.y - (t.rect.y + t.rect.height / 2));
}
