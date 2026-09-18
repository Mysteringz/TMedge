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

  put(snap: OccupancySnapshot, now = Date.now()): void {
    this.latest.set(snap.edgeId, { snap, receivedAt: now });
  }

  view(now = Date.now()): CampusView {
    const floors: CampusView['floors'] = [];
    for (const { snap, receivedAt } of this.latest.values()) {
      const stale = now - receivedAt > this.staleMs;
      for (const f of snap.floors) {
        floors.push({ ...(stale ? blank(f) : f), edgeId: snap.edgeId, updatedAt: receivedAt, stale });
      }
    }
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

/** Minimal structural check of a pushed snapshot: the edge is trusted, but a bug there must not crash the web tier. */
export function isSnapshot(v: unknown): v is OccupancySnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<OccupancySnapshot>;
  return s.version === 1 && typeof s.edgeId === 'string' && s.edgeId.length > 0 && s.edgeId.length < 100 &&
    Array.isArray(s.floors) && s.floors.every((f) => typeof f?.id === 'string' && Array.isArray(f.tables) && Array.isArray(f.zones));
}
