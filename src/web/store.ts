/**
 * Latest snapshot from each edge, merged into one campus view.
 *
 * Each edge owns its floors. If an edge stops pushing, its floors turn
 * unknown after STALE_MS -- a dead edge must never leave the last good numbers
 * on screen, or students are sent to a floor that filled up an hour ago.
 */
import type { CampusFloor, CampusView, FloorState, OccupancySnapshot, Rect, TableShape, TableState } from '../shared/types.js';
import { LOCATION_GEOMETRY_EPSILON, LOCATION_MODEL_TRANSFORM_LIMITS, isValidSimpleBoundedPolygon } from '../shared/location-validation.js';
import { tableBounds } from '../shared/table-geometry.js';
import { campusLocationKey } from '../shared/location-identity.js';

export class SnapshotStore {
  private readonly latest = new Map<string, { snap: OccupancySnapshot; receivedAt: number }>();

  constructor(private readonly staleMs = 30_000) {}

  put(snap: OccupancySnapshot, now = Date.now()): boolean {
    // A bad publisher must not grow an unbounded set of edge identities.
    if (!this.latest.has(snap.edgeId) && this.latest.size >= 256) return false;
    this.latest.set(snap.edgeId, { snap, receivedAt: now });
    return true;
  }

  view(now = Date.now()): CampusView {
    const byFloor = this.currentWinningFloors(now);
    const floors: CampusFloor[] = [...byFloor.values()].map(({ floor, siteId, edgeId, receivedAt, stale }) => ({
      ...(stale ? blank(floor) : floor), siteId, key: campusLocationKey(siteId, floor.id), edgeId, updatedAt: receivedAt, stale,
    }));
    floors.sort((a, b) => a.building.localeCompare(b.building) || a.name.localeCompare(b.name)
      || a.siteId.localeCompare(b.siteId) || a.id.localeCompare(b.id));
    return { generatedAt: now, floors };
  }

  /** Current winner lookup shared by the student view and model authorization. */
  referencesUploadedModel(assetId: string, now = Date.now()): boolean {
    for (const { floor } of this.currentWinningFloors(now).values()) {
      if (floor.model?.assetId === assetId) return true;
    }
    return false;
  }

  private currentWinningFloors(now: number): Map<string, { floor: FloorState; siteId: string; edgeId: string; receivedAt: number; stale: boolean }> {
    const byFloor = new Map<string, { floor: FloorState; siteId: string; edgeId: string; receivedAt: number; stale: boolean }>();
    for (const { snap, receivedAt } of this.latest.values()) {
      const stale = now - receivedAt > this.staleMs;
      for (const f of snap.floors) {
        // During an edge migration two publishers may name the same floor.
        // Show its newest publication once, rather than double-count its seats.
        const key = campusLocationKey(snap.site.id, f.id);
        const previous = byFloor.get(key);
        if (!previous || previous.receivedAt <= receivedAt) {
          byFloor.set(key, { floor: f, siteId: snap.site.id, edgeId: snap.edgeId, receivedAt, stale });
        }
      }
    }
    return byFloor;
  }

  edges(now = Date.now()): { edgeId: string; ageMs: number }[] {
    return [...this.latest.values()].map(({ snap, receivedAt }) => ({ edgeId: snap.edgeId, ageMs: now - receivedAt }));
  }
}

function blank(f: FloorState): FloorState {
  const tables: TableState[] = f.tables.map((t) => ({
    ...t,
    occupied: null,
    free: null,
    status: 'unknown',
    seats: t.seats.map((s) => ({ ...s, occupied: null })),
  }));
  return {
    ...f,
    tables,
    zones: f.zones.map((z) => ({ ...z, people: null })),
    totals: { seats: f.totals.seats, free: 0, occupied: 0, unknownSeats: f.totals.seats, tablesFullyFree: 0 },
  };
}

/**
 * Validate the entire public shape before it reaches sorting, search, stale
 * blanking or a browser. Exact keys also enforce the privacy boundary: raw
 * frames or debug metadata accidentally added by a publisher never pass.
 */
export function isSnapshot(v: unknown): v is OccupancySnapshot {
  if (!record(v, ['version', 'edgeId', 'site', 'generatedAt', 'floors'])) return false;
  const version = v.version;
  return (version === 1 || version === 2) && text(v.edgeId, 99) && record(v.site, ['id', 'name']) &&
    text(v.site.id) && text(v.site.name) && nonnegative(v.generatedAt) &&
    list(v.floors, 200) && unique(v.floors) && v.floors.every((floor) => validFloor(floor, version));
}

function record(v: unknown, keys: string[], optionalKeys: string[] = []): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const actualKeys = Object.keys(v);
  const allowedKeys = new Set([...keys, ...optionalKeys]);
  return keys.every((key) => Object.hasOwn(v, key)) && actualKeys.every((key) => allowedKeys.has(key));
}
function text(v: unknown, max = 255): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function finite(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function nonnegative(v: unknown): v is number { return finite(v) && v >= 0; }
function count(v: unknown, max = 1_000_000): v is number {
  return nonnegative(v) && Number.isSafeInteger(v) && v <= max;
}
function list(v: unknown, max: number): v is unknown[] { return Array.isArray(v) && v.length <= max; }
function unique(v: unknown[]): boolean {
  const ids = v.map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined));
  return ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length;
}
function polygon(v: unknown): boolean {
  return list(v, 1000) && v.length >= 3 &&
    v.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite));
}
function validSeat(v: unknown, enforceBounds: boolean, floorWidth: number, floorHeight: number): boolean {
  return record(v, ['id', 'x', 'y', 'side', 'index', 'occupied', 'neighbors']) && text(v.id) &&
    finite(v.x) && finite(v.y) && (!enforceBounds || (v.x >= 0 && v.x <= floorWidth && v.y >= 0 && v.y <= floorHeight)) &&
    ['L', 'R', 'T', 'B'].includes(String(v.side)) && count(v.index, 100) &&
    (v.occupied === null || typeof v.occupied === 'boolean') &&
    list(v.neighbors, 100) && v.neighbors.every((n) => text(n)) && new Set(v.neighbors).size === v.neighbors.length;
}
function validTable(v: unknown, version: 1 | 2, floorWidth: number, floorHeight: number): v is unknown & TableState {
  const hasShape = !!v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'shape');
  if (!record(v, ['id', 'name', 'zoneId', 'rect', 'capacity', 'occupied', 'free', 'status', 'seats'], version === 2 ? ['shape'] : []) ||
      !text(v.id) || !text(v.name) || !text(v.zoneId) || !count(v.capacity, 100) || v.capacity < 1 ||
      !record(v.rect, ['x', 'y', 'width', 'height']) || !finite(v.rect.x) || !finite(v.rect.y) ||
      !finite(v.rect.width) || v.rect.width <= 0 || !finite(v.rect.height) || v.rect.height <= 0 ||
      !list(v.seats, 100) || v.seats.length !== v.capacity || !unique(v.seats) ||
      !v.seats.every((seat) => validSeat(seat, version === 2 && hasShape, floorWidth, floorHeight))) return false;
  const rect = v.rect as unknown as Rect;
  if (version === 2 && hasShape) {
    if (rect.width < LOCATION_GEOMETRY_EPSILON || rect.height < LOCATION_GEOMETRY_EPSILON ||
        rect.x < 0 || rect.y < 0 || rect.x + rect.width > floorWidth || rect.y + rect.height > floorHeight) return false;
    const shape = Object.hasOwn(v, 'shape') ? validShape(v.shape, floorWidth, floorHeight) : undefined;
    if (Object.hasOwn(v, 'shape') && !shape) return false;
    if (shape && !sameRect(rect, tableBounds(shape))) return false;
  }
  const t = v as unknown as TableState;
  const ids = new Set(t.seats.map((s) => s.id));
  if (t.seats.some((s) => s.neighbors.some((id) => id === s.id || !ids.has(id)))) return false;
  if (t.status === 'unknown') return t.occupied === null && t.free === null && t.seats.every((s) => s.occupied === null);
  return (t.status === 'ok' || t.status === 'fallback') && count(t.occupied, t.capacity) && count(t.free, t.capacity) &&
    t.occupied + t.free === t.capacity && t.seats.every((s) => typeof s.occupied === 'boolean') &&
    t.seats.filter((s) => s.occupied).length === t.occupied;
}
function validFloor(v: unknown, version: 1 | 2): boolean {
  if (!record(v, ['id', 'building', 'name', 'width', 'height', 'outline', 'zones', 'tables', 'totals'], version === 2 ? ['model'] : []) ||
      !text(v.id) || !text(v.building) || !text(v.name) || !finite(v.width) || v.width <= 0 || !finite(v.height) || v.height <= 0 ||
      !polygon(v.outline) || (Object.hasOwn(v, 'model') && v.model !== null && !validPublishedModel(v.model)) ||
      !list(v.zones, 1000) || !unique(v.zones) || !list(v.tables, 1000) || !unique(v.tables) ||
      !record(v.totals, ['seats', 'free', 'occupied', 'unknownSeats', 'tablesFullyFree']) ||
      !Object.values(v.totals).every((n) => count(n))) return false;
  const width = v.width, height = v.height;
  if (!v.zones.every((z) => record(z, ['id', 'name', 'polygon', 'people']) && text(z.id) && text(z.name) && polygon(z.polygon) &&
        (z.people === null || count(z.people))) ||
      !v.tables.every((table) => validTable(table, version, width, height))) return false;
  const tables = v.tables as TableState[];
  const zones = new Set((v.zones as { id: string }[]).map((z) => z.id));
  if (tables.some((t) => !zones.has(t.zoneId))) return false;
  const seats = tables.flatMap((t) => t.seats.map((s) => s.id));
  if (new Set(seats).size !== seats.length) return false;
  const known = tables.filter((t) => t.status !== 'unknown');
  return v.totals.seats === tables.reduce((n, t) => n + t.capacity, 0) &&
    v.totals.free === known.reduce((n, t) => n + (t.free ?? 0), 0) &&
    v.totals.occupied === known.reduce((n, t) => n + (t.occupied ?? 0), 0) &&
    v.totals.unknownSeats === tables.filter((t) => t.status === 'unknown').reduce((n, t) => n + t.capacity, 0) &&
    v.totals.tablesFullyFree === known.filter((t) => t.occupied === 0).length;
}

function validShape(v: unknown, floorWidth: number, floorHeight: number): TableShape | null {
  if (!record(v, ['type'], ['x', 'y', 'width', 'height', 'cx', 'cy', 'radius', 'points'])) return null;
  const shape = v;
  if (shape.type === 'rect') {
    if (!record(shape, ['type', 'x', 'y', 'width', 'height']) || !finite(shape.x) || !finite(shape.y) ||
        !finite(shape.width) || shape.width < LOCATION_GEOMETRY_EPSILON || !finite(shape.height) || shape.height < LOCATION_GEOMETRY_EPSILON ||
        shape.x < 0 || shape.y < 0 || shape.x + shape.width > floorWidth || shape.y + shape.height > floorHeight) return null;
    return { type: 'rect', x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  }
  if (shape.type === 'circle') {
    if (!record(shape, ['type', 'cx', 'cy', 'radius']) || !finite(shape.cx) || !finite(shape.cy) ||
        !finite(shape.radius) || shape.radius < LOCATION_GEOMETRY_EPSILON ||
        shape.cx - shape.radius < 0 || shape.cy - shape.radius < 0 ||
        shape.cx + shape.radius > floorWidth || shape.cy + shape.radius > floorHeight) return null;
    return { type: 'circle', cx: shape.cx, cy: shape.cy, radius: shape.radius };
  }
  if (shape.type === 'polygon') {
    if (!record(shape, ['type', 'points']) || !isValidSimpleBoundedPolygon(shape.points, floorWidth, floorHeight)) return null;
    return { type: 'polygon', points: shape.points };
  }
  return null;
}

function sameRect(actual: Rect, expected: Rect): boolean {
  return actual.x === expected.x && actual.y === expected.y && actual.width === expected.width && actual.height === expected.height;
}

function validPublishedModel(v: unknown): boolean {
  if (!record(v, ['assetId', 'transform']) || typeof v.assetId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.assetId)) return false;
  const transform = v.transform;
  return record(transform, ['scale', 'rotationDeg', 'positionM'])
    && boundedVector3(transform.scale, LOCATION_MODEL_TRANSFORM_LIMITS.scale.min, LOCATION_MODEL_TRANSFORM_LIMITS.scale.max)
    && boundedVector3(transform.rotationDeg, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.min, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.max)
    && boundedVector3(transform.positionM, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.min, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.max);
}

function boundedVector3(v: unknown, min: number, max: number): boolean {
  return record(v, ['x', 'y', 'z']) && finite(v.x) && v.x >= min && v.x <= max &&
    finite(v.y) && v.y >= min && v.y <= max && finite(v.z) && v.z >= min && v.z <= max;
}
