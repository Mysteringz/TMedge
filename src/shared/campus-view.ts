import type { CampusFloor, CampusView, CoverageStatus, PublishedFloorModel, Point, SeatSide, TableShape } from './types.js';
import { isValidSimpleBoundedPolygon, LOCATION_MODEL_TRANSFORM_LIMITS } from './location-validation.js';
import { isSimpleRoomRectangleOutline, SIMPLE_ROOM_SOURCE } from './simple-room-geometry.js';

interface Vector3 { x: number; y: number; z: number }

/** Parses the browser-facing public projection and discards unknown/private fields. */
export function parseCampusView(value: unknown): CampusView | null {
  if (!record(value) || !nonnegative(value.generatedAt) || !Array.isArray(value.floors) || value.floors.length > 51_200) return null;
  const floors: CampusFloor[] = [];
  for (const raw of value.floors) {
    const floor = parseFloor(raw);
    if (!floor) return null;
    floors.push(floor);
  }
  if (new Set(floors.map((floor) => floor.key)).size !== floors.length) return null;
  return { generatedAt: value.generatedAt, floors };
}

function parseFloor(value: unknown): CampusFloor | null {
  if (!record(value) || !text(value.id, 255) || !text(value.siteId, 255) || !text(value.edgeId, 99)
    || value.key !== JSON.stringify([value.siteId, value.id])
    || !text(value.building, 200) || !text(value.name, 200) || !finite(value.width) || !finite(value.height)
    || value.width <= 0 || value.height <= 0 || !points(value.outline, 3, 1000)
    || !Array.isArray(value.zones) || value.zones.length > 1000 || !Array.isArray(value.tables) || value.tables.length > 1000 || !record(value.totals)
    || !nonnegative(value.updatedAt) || typeof value.stale !== 'boolean') return null;
  const zones = value.zones.map(parseZone);
  if (zones.some((zone) => zone === null)) return null;
  if (new Set(zones.map((zone) => zone?.id)).size !== zones.length) return null;
  const tables = value.tables.map((table) => parseTable(table, value.width as number, value.height as number));
  if (tables.some((table) => table === null)) return null;
  if (new Set(tables.map((table) => table?.id)).size !== tables.length) return null;
  const parsedZones = zones as NonNullable<typeof zones[number]>[];
  const parsedTables = tables as NonNullable<typeof tables[number]>[];
  const zoneIds = new Set(parsedZones.map((zone) => zone.id));
  if (parsedTables.some((table) => !zoneIds.has(table.zoneId))) return null;
  const allSeats = parsedTables.flatMap((table) => table.seats);
  const seatIds = new Set(allSeats.map((seat) => seat.id));
  if (seatIds.size !== allSeats.length || parsedTables.some((table) => {
    const ownSeatIds = new Set(table.seats.map((seat) => seat.id));
    return table.seats.some((seat) => seat.neighbors.some((neighbor) => neighbor === seat.id || !ownSeatIds.has(neighbor)));
  })) return null;
  const totals = parseTotals(value.totals);
  const model = parseModel(value);
  const hasProceduralRoom = Object.hasOwn(value, 'proceduralRoom');
  if (!totals || model === invalidModel || (hasProceduralRoom && (
    value.proceduralRoom !== SIMPLE_ROOM_SOURCE || Object.hasOwn(value, 'model') ||
    !isSimpleRoomRectangleOutline(value.outline as Point[], value.width as number, value.height as number)
  ))) return null;
  const known = parsedTables.filter((table) => table.status !== 'unknown');
  const expectedTotals = {
    seats: parsedTables.reduce((sum, table) => sum + table.capacity, 0),
    free: known.reduce((sum, table) => sum + (table.free ?? 0), 0),
    occupied: known.reduce((sum, table) => sum + (table.occupied ?? 0), 0),
    unknownSeats: parsedTables.filter((table) => table.status === 'unknown').reduce((sum, table) => sum + table.capacity, 0),
    tablesFullyFree: known.filter((table) => table.occupied === 0).length,
  };
  if (Object.entries(expectedTotals).some(([key, expected]) => totals[key as keyof typeof totals] !== expected)) return null;
  if (value.stale && (parsedTables.some((table) => table.status !== 'unknown') || parsedZones.some((zone) => zone.people !== null))) return null;
  return {
    id: value.id, siteId: value.siteId, key: value.key, edgeId: value.edgeId,
    building: value.building, name: value.name, width: value.width, height: value.height,
    outline: value.outline as Point[], zones: parsedZones,
    tables: parsedTables, totals, updatedAt: value.updatedAt, stale: value.stale,
    ...(model === undefined ? {} : { model }),
    ...(hasProceduralRoom ? { proceduralRoom: SIMPLE_ROOM_SOURCE } : {}),
  };
}

function parseZone(value: unknown) {
  if (!record(value) || !text(value.id, 255) || !text(value.name, 200) || !points(value.polygon, 3, 1000)
    || !(value.people === null || integer(value.people) && value.people >= 0 && value.people <= 1_000_000)) return null;
  return { id: value.id, name: value.name, polygon: value.polygon as Point[], people: value.people as number | null };
}

function parseTable(value: unknown, width: number, height: number) {
  if (!record(value) || !text(value.id, 255) || !text(value.name, 200) || !text(value.zoneId, 255) || !record(value.rect)
    || !finite(value.rect.x) || !finite(value.rect.y) || !finite(value.rect.width) || !finite(value.rect.height)
    || value.rect.width <= 0 || value.rect.height <= 0 || !integer(value.capacity) || value.capacity < 1
    || !validCount(value.occupied) || !validCount(value.free) || !coverageStatus(value.status)
    || !Array.isArray(value.seats) || value.capacity > 100 || value.seats.length !== value.capacity) return null;
  const hasShape = Object.hasOwn(value, 'shape');
  const shape = hasShape ? parseShape(value.shape, width, height, value.rect) : undefined;
  if (hasShape && !shape) return null;
  const seats = value.seats.map((seat) => parseSeat(seat, width, height, hasShape));
  if (seats.some((seat) => seat === null)) return null;
  const parsedSeats = seats as NonNullable<typeof seats[number]>[];
  if (parsedSeats.some((seat) => new Set(seat.neighbors).size !== seat.neighbors.length)) return null;
  if (value.status === 'unknown') {
    if (value.occupied !== null || value.free !== null || parsedSeats.some((seat) => seat.occupied !== null)) return null;
  } else if (value.status === 'ok' || value.status === 'fallback') {
    if (value.occupied === null || value.free === null || value.occupied + value.free !== value.capacity ||
      parsedSeats.some((seat) => seat.occupied === null) || parsedSeats.filter((seat) => seat.occupied).length !== value.occupied) return null;
  }
  return {
    id: value.id, name: value.name, zoneId: value.zoneId,
    rect: { x: value.rect.x, y: value.rect.y, width: value.rect.width, height: value.rect.height },
    ...(shape ? { shape } : {}), capacity: value.capacity, occupied: value.occupied, free: value.free,
    status: value.status, seats: parsedSeats,
  };
}

function parseSeat(value: unknown, width: number, height: number, authored: boolean) {
  if (!record(value) || !text(value.id, 255) || !finite(value.x) || !finite(value.y)
    || (authored && (value.x < 0 || value.y < 0 || value.x > width || value.y > height))
    || !seatSide(value.side) || !integer(value.index) || value.index < 0 || value.index > 100
    || !(typeof value.occupied === 'boolean' || value.occupied === null)
    || !Array.isArray(value.neighbors) || value.neighbors.length > 100 || value.neighbors.some((item) => !text(item, 255))) return null;
  return { id: value.id, x: value.x, y: value.y, side: value.side, index: value.index,
    occupied: value.occupied, neighbors: [...value.neighbors] as string[] };
}

function parseShape(value: unknown, width: number, height: number, rect: Record<string, unknown>): TableShape | null {
  if (!record(value) || typeof value.type !== 'string') return null;
  if (value.type === 'rect' && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height)) {
    if (value.width <= 0 || value.height <= 0 || !inBounds(value.x, value.y, value.width, value.height, width, height)) return null;
    return sameRect(rect, value) ? { type: 'rect', x: value.x, y: value.y, width: value.width, height: value.height } : null;
  }
  if (value.type === 'circle' && finite(value.cx) && finite(value.cy) && finite(value.radius)) {
    if (value.radius <= 0 || !inBounds(value.cx - value.radius, value.cy - value.radius, value.radius * 2, value.radius * 2, width, height)) return null;
    return sameRect(rect, { x: value.cx - value.radius, y: value.cy - value.radius, width: value.radius * 2, height: value.radius * 2 })
      ? { type: 'circle', cx: value.cx, cy: value.cy, radius: value.radius } : null;
  }
  if (value.type === 'polygon' && isValidSimpleBoundedPolygon(value.points, width, height)) {
    const xs = (value.points as Point[]).map(([x]) => x), ys = (value.points as Point[]).map(([, y]) => y);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    if (!w || !h || !inBounds(x, y, w, h, width, height) || !sameRect(rect, { x, y, width: w, height: h })) return null;
    return { type: 'polygon', points: value.points as Point[] };
  }
  return null;
}

function parseModel(floor: Record<string, unknown>): PublishedFloorModel | null | undefined | typeof invalidModel {
  if (!Object.hasOwn(floor, 'model')) return undefined;
  if (floor.model === null) return null;
  if (!record(floor.model) || typeof floor.model.assetId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(floor.model.assetId)
    || !record(floor.model.transform)) return invalidModel;
  const transform = floor.model.transform;
  if (!modelVector(transform.scale, LOCATION_MODEL_TRANSFORM_LIMITS.scale.min, LOCATION_MODEL_TRANSFORM_LIMITS.scale.max)
    || !modelVector(transform.rotationDeg, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.min, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.max)
    || !modelVector(transform.positionM, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.min, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.max)) return invalidModel;
  return {
    assetId: floor.model.assetId.toLowerCase(),
    transform: { scale: vector(transform.scale), rotationDeg: vector(transform.rotationDeg), positionM: vector(transform.positionM) },
  };
}

const invalidModel = Symbol('invalid model descriptor');
function parseTotals(value: Record<string, unknown>) {
  const names = ['seats', 'free', 'occupied', 'unknownSeats', 'tablesFullyFree'];
  if (names.some((name) => !integer(value[name]) || (value[name] as number) < 0)) return null;
  return { seats: value.seats as number, free: value.free as number, occupied: value.occupied as number,
    unknownSeats: value.unknownSeats as number, tablesFullyFree: value.tablesFullyFree as number };
}

function validCount(value: unknown): value is number | null { return value === null || integer(value) && value >= 0 && value <= 1_000_000; }
function modelVector(value: unknown, min: number, max: number): value is Vector3 {
  return record(value) && ['x', 'y', 'z'].every((axis) => finite(value[axis]) && value[axis] >= min && value[axis] <= max);
}
function vector(value: Vector3): Vector3 { return { x: value.x, y: value.y, z: value.z }; }
function sameRect(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ['x', 'y', 'width', 'height'].every((key) => finite(a[key]) && finite(b[key]) && Math.abs((a[key] as number) - (b[key] as number)) <= 0.000001);
}
function inBounds(x: number, y: number, width: number, height: number, floorWidth: number, floorHeight: number): boolean {
  return x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= floorWidth && y + height <= floorHeight;
}
function points(value: unknown, min: number, max: number): value is Point[] {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every((point) => Array.isArray(point) && point.length === 2 && finite(point[0]) && finite(point[1]));
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function integer(value: unknown): value is number { return finite(value) && Number.isInteger(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function nonnegative(value: unknown): value is number { return finite(value) && value >= 0; }
function coverageStatus(value: unknown): value is CoverageStatus { return value === 'ok' || value === 'fallback' || value === 'unknown'; }
function seatSide(value: unknown): value is SeatSide { return value === 'L' || value === 'R' || value === 'T' || value === 'B'; }
