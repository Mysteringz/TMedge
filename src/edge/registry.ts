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
import type { NodePose, Point, Rect, TableShape, PublishedFloorModel } from '../shared/types.js';
import { tableBounds } from '../shared/table-geometry.js';
import { LOCATION_MODEL_TRANSFORM_LIMITS } from '../shared/location-validation.js';
import { nodesArrayForRegistry } from '../modules/location-config/domain/nodes-config.js';
import { parseLocationDocument, type LocationDocument } from '../modules/location-config/domain/location-document.js';
import type { LegacySpatialProvenance } from '../modules/location-config/domain/location-candidate.js';

export interface TableDef {
  id: string;
  name: string;
  floorId: string;
  zoneId: string;
  shape: TableShape;
  /** True only when the source floor supplied an authored tagged shape. */
  shapeAuthored: boolean;
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
  model?: PublishedFloorModel;
}

export interface NodeDef {
  uid: string;
  label: string;
  /**
   * Where the node is, or null when it has been admitted but not yet placed.
   *
   * A node provisioned by TMflash is a known, allowed identity long before
   * anyone has been up a ladder with it: it may authenticate and stream, but
   * nothing is known about what it is looking at. Both of these are null
   * together and are typed nullable rather than filled with a sentinel, so
   * the compiler names every place that would otherwise do geometry on a
   * pose nobody has measured -- an unplaced node that quietly became a
   * table's fallback would put a stranger's heat on someone's seat.
   */
  floorId: string | null;
  pose: NodePose | null;
  /** Always empty while unplaced: a node cannot own a table it cannot see. */
  owns: string[];
  simulated: boolean;
  /**
   * The node also streams an RGB camera image (verification rigs only). The
   * edge accepts RGB from no other node, keeps it in memory only, and shows
   * it only in the admin console.
   */
  rgb: boolean;
  /**
   * Who finds the people. "node" (default): the node's own REPORT
   * detections. "edge": the node's REPORT detections are ignored and the edge
   * detects on its RAW frames against a background that only learns heat
   * present nearly all day (edgedetect.ts), so someone sitting still for
   * hours is not faded out. An edge node must send RAW every frame.
   */
  detector?: NodeDetector;
}

export type NodeDetector = 'node' | 'edge';

export interface Registry {
  site: { id: string; name: string };
  floors: FloorDef[];
  tables: Map<string, TableDef>;
  nodes: Map<string, NodeDef>;
  seatIndex: Map<string, { seat: SeatSpec; table: TableDef }>;
  /** Location-backed registries emit the version-2 public snapshot contract. */
  snapshotVersion?: 1 | 2;
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
  return buildRegistryCore(siteJson, nodesJson);
}

/**
 * The registry's normal entry point remains strict. Location assembly may
 * additionally permit only explicitly listed legacy seats whose coordinates
 * came from server-validated immutable revision provenance.
 */
function buildRegistryCore(
  siteJson: unknown,
  nodesJson: unknown,
  trustedLegacySeats: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): Registry {
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
    only(f, w, ['id', 'building', 'name', 'width', 'height', 'outline', 'zones', 'tables', 'visibility', 'model']);
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
    if (f.model !== undefined) floor.model = parseFloorModel(f.model, `${w}.model`);
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
      only(t, tw, ['id', 'name', 'zone', 'x', 'y', 'width', 'height', 'shape', 'capacity', 'seats', 'seatRadiusCm']);
      const id = str(t, 'id', tw);
      if (tables.has(id)) throw new ConfigError(`${tw}: duplicate table id "${id}" (table ids are unique site-wide)`);
      const zoneId = str(t, 'zone', tw);
      if (!floor.zones.some((z) => z.id === zoneId)) throw new ConfigError(`${tw}.zone: no zone "${zoneId}" on floor ${floor.id}`);
      const shape = t.shape === undefined
        ? parseLegacyRectangle(t, tw, floor)
        : parseTableShape(t.shape, `${tw}.shape`, floor);
      const rect = tableBounds(shape);
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
        shape,
        shapeAuthored: t.shape !== undefined,
        rect,
        capacity,
        seats: t.seats === undefined ? generateSeats(id, shape, capacity) : explicitSeats(t.seats, id, capacity, floor, tw, trustedLegacySeats),
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
  let configuredNodes: unknown[];
  try {
    configuredNodes = nodesArrayForRegistry(nodesJson);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  configuredNodes.forEach((nv, ni) => {
    const w = `nodes[${ni}]`;
    const n = obj(nv, w);
    only(n, w, ['uid', 'label', 'floor', 'pose', 'owns', 'simulated', 'rgb', 'detector']);
    for (const key of ['simulated', 'rgb']) {
      if (n[key] !== undefined && typeof n[key] !== 'boolean') throw new ConfigError(`${w}.${key}: expected true/false`);
    }
    if (n.owns !== undefined && (!Array.isArray(n.owns) || !n.owns.every((x) => typeof x === 'string'))) {
      throw new ConfigError(`${w}.owns: expected an array of table ids`);
    }
    if (n.detector !== undefined && n.detector !== 'node' && n.detector !== 'edge') {
      // A typo here would silently leave the node on its own detector, which
      // is the one that forgets people who sit still.
      throw new ConfigError(`${w}.detector: expected "node" or "edge", got ${JSON.stringify(n.detector)}`);
    }
    const detector: NodeDetector = n.detector === 'edge' ? 'edge' : 'node';
    const uid = str(n, 'uid', w).toLowerCase();
    if (!UID_RE.test(uid)) throw new ConfigError(`${w}.uid: expected a MAC like 30:ed:a0:cb:f5:f8, got "${uid}"`);
    if (nodes.has(uid)) throw new ConfigError(`${w}: duplicate uid ${uid}`);
    // Unplaced: admitted as an identity, not yet installed anywhere. Both
    // halves must be absent together -- half a placement is a typo, and the
    // whole point of this file being strict is that a typo cannot become a
    // silently mis-sited node.
    const unplaced = n.floor === undefined && n.pose === undefined;
    if (!unplaced && (n.floor === undefined || n.pose === undefined)) {
      throw new ConfigError(`${w}: give both "floor" and "pose", or neither (an unplaced node)`);
    }
    if (unplaced) {
      if (Array.isArray(n.owns) && n.owns.length > 0) {
        throw new ConfigError(`${w}.owns: an unplaced node cannot own tables; place it first`);
      }
      if (n.rgb === true) {
        // Placing it later decides which floor it lands on, and RGB is only
        // ever allowed on a console-visible one. Refuse now rather than
        // discover it at placement time.
        throw new ConfigError(`${w}.rgb: place the node before marking it RGB`);
      }
      nodes.set(uid, {
        uid,
        label: typeof n.label === 'string' && n.label ? n.label : uid,
        floorId: null,
        pose: null,
        owns: [],
        simulated: n.simulated === true,
        rgb: false,
        detector,
      });
      return;
    }
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
      detector,
    });
  });

  // Which nodes see every seat of each table. The owner must; the rest are
  // fallbacks, closest first, used only while the owner is down.
  for (const table of tables.values()) {
    const seeing = [...nodes.values()]
      // An unplaced node has no pose, so it can see nothing and covers
      // nothing. It must never become a fallback on the strength of a
      // position nobody has measured.
      .filter((n): n is NodeDef & { pose: NodePose } => n.pose !== null)
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

/** Assemble a complete runtime registry from the immutable site seed and all active published location documents. */
export function buildRegistryFromLocationDocuments(
  siteJson: unknown,
  nodesJson: unknown,
  documents: readonly LocationDocument[],
  legacySpatialByLocation: ReadonlyMap<string, LegacySpatialProvenance> = new Map(),
): Registry {
  const root = obj(siteJson, 'site.json');
  if (!Array.isArray(root.floors)) throw new ConfigError('site.json.floors: expected a non-empty array');
  const replacements = new Map<string, LocationDocument>();
  for (const input of documents) {
    const document = parseLocationDocument(input);
    if (replacements.has(document.locationId)) throw new ConfigError(`duplicate published location "${document.locationId}"`);
    replacements.set(document.locationId, document);
  }
  const seedIds = new Set(root.floors.map((floor, index) => str(obj(floor, `floors[${index}]`), 'id', `floors[${index}]`)));
  const floors = (root.floors as unknown[]).map((floor, index) => {
    const raw = obj(floor, `floors[${index}]`);
    const replacement = replacements.get(str(raw, 'id', `floors[${index}]`));
    if (!replacement) return structuredClone(raw);
    replacements.delete(replacement.locationId);
    return locationDocumentFloor(replacement, legacySpatialByLocation.get(replacement.locationId));
  });
  for (const document of replacements.values()) floors.push(locationDocumentFloor(document, legacySpatialByLocation.get(document.locationId)));
  const trustedLegacySeats = new Map<string, { x: number; y: number }>();
  for (const legacy of legacySpatialByLocation.values()) {
    for (const inherited of legacy.tables) {
      for (const position of inherited.seats) trustedLegacySeats.set(legacySeatKey(inherited.id, position.id), { x: position.x, y: position.y });
    }
  }
  // This is the only assembly path that can admit legacy out-of-floor seat
  // coordinates, and its allow-list comes from exact-base validated storage
  // provenance. The registry computes ownership and coverage from the real
  // inherited positions rather than temporary placeholders.
  const registry = buildRegistryCore({ ...root, floors }, nodesJson, trustedLegacySeats);
  registry.snapshotVersion = 2;
  return registry;
}

function locationDocumentFloor(document: LocationDocument, legacySpatial?: LegacySpatialProvenance): Obj {
  const outline = legacySpatial?.outline ?? document.outline;
  const zones = document.zones.map((zone) => ({
    ...zone,
    polygon: legacySpatial?.zones.find((inherited) => inherited.id === zone.id)?.polygon ?? zone.polygon,
  }));
  const tables = document.tables.map((table) => {
    const inherited = legacySpatial?.tables.find((item) => item.id === table.id);
    const seatPositions = new Map((inherited?.seats ?? []).map((seat) => [seat.id, seat]));
    const seats = table.seats.map((seat, index) => {
      const position = seatPositions.get(seat.id);
      const x = position?.x ?? seat.x;
      const y = position?.y ?? seat.y;
      return {
        id: seat.id,
        x,
        y,
        neighbors: seat.neighbors, side: seat.side ?? 'L', index: seat.index ?? index,
      };
    });
    if (inherited?.rect) {
      return {
        id: table.id, name: table.name, zone: table.zoneId, capacity: table.capacity,
        x: inherited.rect.x, y: inherited.rect.y, width: inherited.rect.width, height: inherited.rect.height,
        seatRadiusCm: table.seatRadiusCm, seats,
      };
    }
    return {
      id: table.id, name: table.name, zone: table.zoneId, shape: table.shape, capacity: table.capacity,
      seatRadiusCm: table.seatRadiusCm, seats,
    };
  });
  const floor: Obj = {
    id: document.locationId,
    visibility: document.visibility,
    building: document.building,
    name: document.name,
    width: document.widthCm,
    height: document.heightCm,
    outline,
    zones,
    tables,
  };
  if (document.modelAssetId && document.modelTransform) floor.model = { assetId: document.modelAssetId, transform: document.modelTransform };
  return floor;
}

function parseLegacyRectangle(table: Obj, where: string, floor: FloorDef): TableShape {
  const shape: TableShape = {
    type: 'rect', x: num(table, 'x', where, 0, floor.width), y: num(table, 'y', where, 0, floor.height),
    width: num(table, 'width', where, 20, 2000), height: num(table, 'height', where, 20, 2000),
  };
  const bounds = tableBounds(shape);
  if (bounds.x + bounds.width > floor.width || bounds.y + bounds.height > floor.height) {
    throw new ConfigError(`${where}: table extends past the floor (${floor.width} x ${floor.height} cm)`);
  }
  return shape;
}

function parseTableShape(value: unknown, where: string, floor: FloorDef): TableShape {
  const input = obj(value, where);
  if (input.type === 'rect') {
    only(input, where, ['type', 'x', 'y', 'width', 'height']);
    const shape: TableShape = {
      type: 'rect', x: num(input, 'x', where, 0, floor.width), y: num(input, 'y', where, 0, floor.height),
      width: num(input, 'width', where, Number.EPSILON, floor.width), height: num(input, 'height', where, Number.EPSILON, floor.height),
    };
    const bounds = tableBounds(shape);
    if (bounds.x + bounds.width > floor.width || bounds.y + bounds.height > floor.height) throw new ConfigError(`${where}: table extends past the floor`);
    return shape;
  }
  if (input.type === 'circle') {
    only(input, where, ['type', 'cx', 'cy', 'radius']);
    const shape: TableShape = {
      type: 'circle', cx: num(input, 'cx', where, 0, floor.width), cy: num(input, 'cy', where, 0, floor.height),
      radius: num(input, 'radius', where, Number.EPSILON, Math.min(floor.width, floor.height)),
    };
    const bounds = tableBounds(shape);
    if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > floor.width || bounds.y + bounds.height > floor.height) throw new ConfigError(`${where}: circle extends past the floor`);
    return shape;
  }
  if (input.type === 'polygon') {
    only(input, where, ['type', 'points']);
    const vertices = points(input.points, `${where}.points`);
    if (vertices.some(([x, y]) => x < 0 || y < 0 || x > floor.width || y > floor.height)) throw new ConfigError(`${where}: polygon extends past the floor`);
    return { type: 'polygon', points: vertices };
  }
  throw new ConfigError(`${where}.type: expected rect, circle or polygon`);
}

function parseFloorModel(value: unknown, where: string): PublishedFloorModel {
  const model = obj(value, where);
  only(model, where, ['assetId', 'transform']);
  const assetId = str(model, 'assetId', where);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) throw new ConfigError(`${where}.assetId: expected an opaque UUID`);
  const transform = obj(model.transform, `${where}.transform`);
  only(transform, `${where}.transform`, ['scale', 'rotationDeg', 'positionM']);
  const vector = (value: unknown, path: string, min: number, max: number) => {
    const v = obj(value, path); only(v, path, ['x', 'y', 'z']);
    return { x: num(v, 'x', path, min, max), y: num(v, 'y', path, min, max), z: num(v, 'z', path, min, max) };
  };
  return { assetId: assetId.toLowerCase(), transform: {
    scale: vector(transform.scale, `${where}.transform.scale`, LOCATION_MODEL_TRANSFORM_LIMITS.scale.min, LOCATION_MODEL_TRANSFORM_LIMITS.scale.max),
    rotationDeg: vector(transform.rotationDeg, `${where}.transform.rotationDeg`, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.min, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.max),
    positionM: vector(transform.positionM, `${where}.transform.positionM`, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.min, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.max),
  } };
}

/**
 * Seats placed by hand (or, later, learned) rather than generated: for tables
 * whose chairs do not follow the "along both long sides" pattern -- e.g. a
 * desk against a wall with every chair on one side. Seats within a metre of
 * each other count as neighbours for the "sit together" search.
 */
function explicitSeats(
  v: unknown,
  tableId: string,
  capacity: number,
  floor: FloorDef,
  where: string,
  trustedLegacySeats: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): SeatSpec[] {
  if (!Array.isArray(v) || v.length !== capacity) {
    throw new ConfigError(`${where}.seats: expected exactly ${capacity} seats (the table's capacity)`);
  }
  const seats: SeatSpec[] = v.map((sv, i) => {
    const sw = `${where}.seats[${i}]`;
    const o = obj(sv, sw);
    only(o, sw, ['id', 'x', 'y', 'side', 'index', 'neighbors']);
    const side = o.side === undefined ? 'L' : o.side;
    if (side !== 'L' && side !== 'R' && side !== 'T' && side !== 'B') throw new ConfigError(`${sw}.side: expected L, R, T or B`);
    const exactId = Array.isArray(o.neighbors);
    if (exactId && !(o.neighbors as unknown[]).every((id) => typeof id === 'string')) throw new ConfigError(`${sw}.neighbors: expected seat IDs`);
    const id = exactId ? str(o, 'id', sw) : `${tableId}-${str(o, 'id', sw)}`;
    const trustedPosition = trustedLegacySeats.get(legacySeatKey(tableId, id));
    const coordinate = (key: 'x' | 'y', max: number) => {
      if (!trustedPosition) return num(o, key, sw, 0, max);
      const value = o[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ConfigError(`${sw}.${key}: expected a finite legacy seat coordinate`);
      if (value !== trustedPosition[key]) throw new ConfigError(`${sw}.${key}: does not match the exact inherited legacy coordinate`);
      return trustedPosition[key];
    };
    return {
      id,
      x: coordinate('x', floor.width),
      y: coordinate('y', floor.height),
      side,
      index: o.index === undefined ? i : num(o, 'index', sw, 0, 10000),
      neighbors: exactId ? [...o.neighbors as string[]] : [],
    };
  });
  if (new Set(seats.map((s) => s.id)).size !== seats.length) throw new ConfigError(`${where}.seats: duplicate seat id`);
  if (seats.some((seat) => seat.neighbors.length > 0) || (Array.isArray(v) && v.some((item) => Array.isArray((item as Obj).neighbors)))) {
    const ids = new Set(seats.map((seat) => seat.id));
    for (const seat of seats) {
      if (new Set(seat.neighbors).size !== seat.neighbors.length || seat.neighbors.some((id) => id === seat.id || !ids.has(id))) throw new ConfigError(`${where}.seats.${seat.id}.neighbors: invalid seat adjacency`);
      if (seat.neighbors.some((id) => !seats.find((other) => other.id === id)?.neighbors.includes(seat.id))) throw new ConfigError(`${where}.seats.${seat.id}.neighbors: adjacency must be symmetric`);
    }
  } else {
    for (const a of seats) for (const b of seats) if (a !== b && Math.hypot(a.x - b.x, a.y - b.y) <= 100) a.neighbors.push(b.id);
  }
  return seats;
}

function legacySeatKey(tableId: string, seatId: string): string {
  return `${tableId}\u0000${seatId}`;
}

function seesWithMargin(pose: NodePose, x: number, y: number): boolean {
  const px = floorToPixel(pose, x, y);
  return px !== null && px[0] >= 0.5 && px[0] <= GRID_W - 0.5 && px[1] >= 0.5 && px[1] <= GRID_H - 0.5;
}

function dist(pose: NodePose, t: TableDef): number {
  return Math.hypot(pose.x - (t.rect.x + t.rect.width / 2), pose.y - (t.rect.y + t.rect.height / 2));
}
