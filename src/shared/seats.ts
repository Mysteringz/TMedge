/**
 * Seat layout and the "N seats together" search.
 *
 * Seats are points around a table. Two seats are *together* if they are side
 * by side on the same edge of the table, or directly across from each other --
 * a group of three can take two on one side and the one opposite, which is
 * how people actually sit. A set of free seats fits a group when it is
 * connected through those links.
 *
 * Shared by the web server (the search API) and the dashboard, so the list a
 * student sees and the seats highlighted on the plan cannot disagree.
 */
import type { FloorState, Rect, SeatSide, SeatState, SeatSuggestion, TableState } from './types.js';

/** How far a seat's centre sits from the table edge, cm. */
export const SEAT_OFFSET_CM = 35;

export interface SeatSpec {
  id: string;
  x: number;
  y: number;
  side: SeatSide;
  index: number;
  neighbors: string[];
}

/**
 * Default layout: seats along the two long sides, split as evenly as the
 * capacity allows. The makerspace benches (105 x 167 cm, 6 seats) come out
 * as three a side, which is what the drawing shows.
 */
export function generateSeats(tableId: string, rect: Rect, capacity: number): SeatSpec[] {
  const vertical = rect.height >= rect.width;
  const sides: [SeatSide, SeatSide] = vertical ? ['L', 'R'] : ['T', 'B'];
  const counts = [Math.ceil(capacity / 2), Math.floor(capacity / 2)];
  const seats: SeatSpec[] = [];
  sides.forEach((side, s) => {
    const n = counts[s] ?? 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = vertical
        ? side === 'L' ? rect.x - SEAT_OFFSET_CM : rect.x + rect.width + SEAT_OFFSET_CM
        : rect.x + t * rect.width;
      const y = vertical
        ? rect.y + t * rect.height
        : side === 'T' ? rect.y - SEAT_OFFSET_CM : rect.y + rect.height + SEAT_OFFSET_CM;
      seats.push({ id: `${tableId}-${side}${i + 1}`, x: Math.round(x), y: Math.round(y), side, index: i, neighbors: [] });
    }
  });
  const at = (side: SeatSide, index: number) => seats.find((s) => s.side === side && s.index === index);
  for (const seat of seats) {
    const other = seat.side === sides[0] ? sides[1] : sides[0];
    for (const n of [at(seat.side, seat.index - 1), at(seat.side, seat.index + 1), at(other, seat.index)]) {
      if (n) seat.neighbors.push(n.id);
    }
  }
  return seats;
}

/**
 * Pick `n` free seats at one table that are connected through neighbour
 * links, preferring to keep the group on one side. Returns null if the table
 * has no such group.
 */
export function findGroup(table: TableState, n: number): string[] | null {
  if (table.status === 'unknown' || n < 1) return null;
  const free = new Map(table.seats.filter((s) => s.occupied === false).map((s) => [s.id, s]));
  if (free.size < n) return null;
  let best: string[] | null = null;
  let bestSides = Infinity;
  for (const start of free.values()) {
    // Breadth-first from each start, visiting same-side neighbours first, so
    // the first n reached are as tight a cluster as the free seats allow.
    const picked: SeatState[] = [];
    const seen = new Set<string>([start.id]);
    const queue: SeatState[] = [start];
    while (queue.length > 0 && picked.length < n) {
      const seat = queue.shift();
      if (!seat) break;
      picked.push(seat);
      const next = seat.neighbors
        .map((id) => free.get(id))
        .filter((s): s is SeatState => s !== undefined && !seen.has(s.id))
        .sort((a, b) => Number(a.side !== seat.side) - Number(b.side !== seat.side));
      for (const s of next) {
        seen.add(s.id);
        queue.push(s);
      }
    }
    if (picked.length < n) continue;
    const sides = new Set(picked.map((s) => s.side)).size;
    if (sides < bestSides) {
      best = picked.map((s) => s.id);
      bestSides = sides;
    }
  }
  return best;
}

/**
 * Every place a group of `n` can sit together, quietest first. A group larger
 * than one table can hold is offered two neighbouring tables in the same zone
 * whose free seats add up, listed after any single-table answer.
 */
export function searchSeats(floors: FloorState[], n: number, floorId?: string): SeatSuggestion[] {
  const out: SeatSuggestion[] = [];
  for (const floor of floors) {
    if (floorId && floor.id !== floorId) continue;
    for (const table of floor.tables) {
      const group = findGroup(table, n);
      if (!group || table.free === null || table.occupied === null) continue;
      out.push({
        floorId: floor.id,
        floorName: floor.name,
        building: floor.building,
        tableIds: [table.id],
        tableName: table.name,
        seatIds: group,
        freeAtTable: table.free,
        capacity: table.capacity,
        busyness: table.occupied / table.capacity,
      });
    }
    const maxCapacity = Math.max(0, ...floor.tables.map((t) => t.capacity));
    if (n > maxCapacity) {
      for (const [a, b] of neighbouringTables(floor.tables)) {
        if (a.free === null || b.free === null || a.occupied === null || b.occupied === null) continue;
        if (a.free + b.free < n) continue;
        const seats = [...a.seats, ...b.seats].filter((s) => s.occupied === false).slice(0, n).map((s) => s.id);
        out.push({
          floorId: floor.id,
          floorName: floor.name,
          building: floor.building,
          tableIds: [a.id, b.id],
          tableName: `${a.name} + ${b.name}`,
          seatIds: seats,
          freeAtTable: a.free + b.free,
          capacity: a.capacity + b.capacity,
          busyness: (a.occupied + b.occupied) / (a.capacity + b.capacity),
        });
      }
    }
  }
  return out.sort(
    (p, q) => p.tableIds.length - q.tableIds.length || p.busyness - q.busyness || q.freeAtTable - p.freeAtTable,
  );
}

/** Pairs of tables in the same zone whose nearest edges are within 3 m. */
function neighbouringTables(tables: TableState[]): [TableState, TableState][] {
  const pairs: [TableState, TableState][] = [];
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      if (!a || !b || a.zoneId !== b.zoneId) continue;
      const gapX = Math.max(0, Math.max(a.rect.x, b.rect.x) - Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width));
      const gapY = Math.max(0, Math.max(a.rect.y, b.rect.y) - Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height));
      if (Math.hypot(gapX, gapY) <= 300) pairs.push([a, b]);
    }
  }
  return pairs;
}
