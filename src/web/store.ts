/**
 * Latest snapshot from each edge, merged into one campus view.
 *
 * Each edge owns its floors. If an edge stops pushing, its floors turn
 * unknown after STALE_MS -- a dead edge must never leave the last good numbers
 * on screen, or students are sent to a floor that filled up an hour ago.
 */
import type { CampusView, FloorState, OccupancySnapshot, TableState } from '../shared/types.js';

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
    const byFloor = new Map<string, CampusView['floors'][number]>();
    for (const { snap, receivedAt } of this.latest.values()) {
      const stale = now - receivedAt > this.staleMs;
      for (const f of snap.floors) {
        // During an edge migration two publishers may name the same floor.
        // Show its newest publication once, rather than double-count its seats.
        const previous = byFloor.get(f.id);
        if (!previous || previous.updatedAt <= receivedAt) {
          byFloor.set(f.id, { ...(stale ? blank(f) : f), edgeId: snap.edgeId, updatedAt: receivedAt, stale });
        }
      }
    }
    const floors = [...byFloor.values()];
    floors.sort((a, b) => a.building.localeCompare(b.building) || a.name.localeCompare(b.name));
    return { generatedAt: now, floors };
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
  return v.version === 1 && text(v.edgeId, 99) && record(v.site, ['id', 'name']) &&
    text(v.site.id) && text(v.site.name) && nonnegative(v.generatedAt) &&
    list(v.floors, 200) && unique(v.floors) && v.floors.every(validFloor);
}

function record(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
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
function validSeat(v: unknown): boolean {
  return record(v, ['id', 'x', 'y', 'side', 'index', 'occupied', 'neighbors']) && text(v.id) &&
    finite(v.x) && finite(v.y) && ['L', 'R', 'T', 'B'].includes(String(v.side)) && count(v.index, 100) &&
    (v.occupied === null || typeof v.occupied === 'boolean') &&
    list(v.neighbors, 100) && v.neighbors.every((n) => text(n)) && new Set(v.neighbors).size === v.neighbors.length;
}
function validTable(v: unknown): v is unknown & TableState {
  if (!record(v, ['id', 'name', 'zoneId', 'rect', 'capacity', 'occupied', 'free', 'status', 'seats']) ||
      !text(v.id) || !text(v.name) || !text(v.zoneId) || !count(v.capacity, 100) || v.capacity < 1 ||
      !record(v.rect, ['x', 'y', 'width', 'height']) || !finite(v.rect.x) || !finite(v.rect.y) ||
      !finite(v.rect.width) || v.rect.width <= 0 || !finite(v.rect.height) || v.rect.height <= 0 ||
      !list(v.seats, 100) || v.seats.length !== v.capacity || !unique(v.seats) || !v.seats.every(validSeat)) return false;
  const t = v as unknown as TableState;
  const ids = new Set(t.seats.map((s) => s.id));
  if (t.seats.some((s) => s.neighbors.some((id) => id === s.id || !ids.has(id)))) return false;
  if (t.status === 'unknown') return t.occupied === null && t.free === null && t.seats.every((s) => s.occupied === null);
  return (t.status === 'ok' || t.status === 'fallback') && count(t.occupied, t.capacity) && count(t.free, t.capacity) &&
    t.occupied + t.free === t.capacity && t.seats.every((s) => typeof s.occupied === 'boolean') &&
    t.seats.filter((s) => s.occupied).length === t.occupied;
}
function validFloor(v: unknown): boolean {
  if (!record(v, ['id', 'building', 'name', 'width', 'height', 'outline', 'zones', 'tables', 'totals']) ||
      !text(v.id) || !text(v.building) || !text(v.name) || !finite(v.width) || v.width <= 0 ||
      !finite(v.height) || v.height <= 0 || !polygon(v.outline) ||
      !list(v.zones, 1000) || !unique(v.zones) || !v.zones.every((z) =>
        record(z, ['id', 'name', 'polygon', 'people']) && text(z.id) && text(z.name) && polygon(z.polygon) &&
        (z.people === null || count(z.people))) ||
      !list(v.tables, 1000) || !unique(v.tables) || !v.tables.every(validTable) ||
      !record(v.totals, ['seats', 'free', 'occupied', 'unknownSeats', 'tablesFullyFree']) ||
      !Object.values(v.totals).every((n) => count(n))) return false;
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
