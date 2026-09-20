/**
 * "Which table should we sit at?" -- the HKUMySeat allocation rule.
 *
 * The student asks for N seats; a space answers with one table, or a run of
 * tables standing next to each other, whose free seats add up to N. Runs are
 * read across the floor the way a person walks it (front row left to right,
 * then the row behind), so "Tables M3-M4" really are neighbours.
 *
 * Of every run that fits, the fewest tables wins, then the least wasted
 * seats: a pair of four is better split 2+2 across two tables than scattered
 * over four.
 *
 * A table whose sensor is down is `unknown`, never free: it can neither be
 * allocated nor bridge a run, exactly as if it were full. Silence is not
 * emptiness -- sending a group to a table nobody can see is the one failure
 * that would cost the system its credibility.
 *
 * Shared by the web tier and the browser so the advice and the plan drawn
 * next to it cannot disagree.
 */
import type { FloorState, TableState } from './types.js';

export interface TableShare {
  tableId: string;
  /** Table name as written on the furniture, e.g. "M3". */
  name: string;
  /** Seats this table contributes to the group. */
  take: number;
}

export interface Allocation {
  /** In walking order, first table first. */
  shares: TableShare[];
  /** "Table M3" / "Tables M3-M4" / "Tables M3, M7". */
  label: string;
  seats: number;
  /** Free seats at the chosen tables that the group will not use. */
  waste: number;
}

/**
 * Tables in walking order: rows front to back, left to right within a row.
 * Rows are found by grouping on the table's centre y, which survives a plan
 * where the rows are not perfectly aligned.
 */
export function walkOrder(tables: TableState[]): TableState[] {
  const rowHeight = Math.max(1, ...tables.map((t) => t.rect.height));
  return [...tables].sort((a, b) => {
    const ay = a.rect.y + a.rect.height / 2;
    const by = b.rect.y + b.rect.height / 2;
    if (Math.abs(ay - by) > rowHeight * 0.75) return ay - by;
    return a.rect.x - b.rect.x;
  });
}

/** Row (0 = nearest the entrance) and column of each table, in walk order. */
export function gridPosition(tables: TableState[], tableId: string): { row: number; column: number; rows: number; columns: number } | null {
  const ordered = walkOrder(tables);
  const rowHeight = Math.max(1, ...tables.map((t) => t.rect.height));
  const rows: TableState[][] = [];
  for (const t of ordered) {
    const last = rows[rows.length - 1];
    const lastY = last?.[0] ? last[0].rect.y + last[0].rect.height / 2 : null;
    const y = t.rect.y + t.rect.height / 2;
    if (last && lastY !== null && Math.abs(y - lastY) <= rowHeight * 0.75) last.push(t);
    else rows.push([t]);
  }
  for (const [r, row] of rows.entries()) {
    const c = row.findIndex((t) => t.id === tableId);
    if (c >= 0) return { row: r, column: c, rows: rows.length, columns: Math.max(...rows.map((x) => x.length)) };
  }
  return null;
}

/**
 * The best run of neighbouring tables seating `n` together, or null when the
 * space has no such run.
 */
export function allocate(floor: FloorState, n: number): Allocation | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const tables = walkOrder(floor.tables);
  // A table with no live count is a wall as far as the search is concerned.
  const free = tables.map((t) => (t.status === 'unknown' || t.free === null ? 0 : t.free));
  let best: { start: number; end: number; length: number; waste: number } | null = null;
  for (let i = 0; i < tables.length; i++) {
    let sum = 0;
    for (let j = i; j < tables.length; j++) {
      if (free[j] === 0) break;
      sum += free[j] ?? 0;
      if (sum >= n) {
        const length = j - i + 1;
        const waste = sum - n;
        if (!best || length < best.length || (length === best.length && waste < best.waste)) {
          best = { start: i, end: j, length, waste };
        }
        break;
      }
    }
  }
  if (!best) return null;
  const shares: TableShare[] = [];
  let left = n;
  for (let k = best.start; k <= best.end && left > 0; k++) {
    const table = tables[k];
    const take = Math.min(free[k] ?? 0, left);
    if (!table || take <= 0) continue;
    shares.push({ tableId: table.id, name: table.name, take });
    left -= take;
  }
  return { shares, label: label(shares.map((s) => s.name)), seats: n, waste: best.waste };
}

/** "Table M3" for one, "Tables M3-M5" for a run, otherwise a list. */
export function label(names: string[]): string {
  if (names.length === 0) return 'No table';
  if (names.length === 1) return `Table ${names[0]}`;
  const first = names[0] ?? '';
  const last = names[names.length - 1] ?? '';
  return `Tables ${first}–${last}`;
}

/** Free seats a space can actually promise: unknown tables count for nothing. */
export function knownFree(floor: FloorState): number {
  return floor.tables.reduce((sum, t) => sum + (t.status === 'unknown' || t.free === null ? 0 : t.free), 0);
}

/** The most seats free at any one table, for the "scattered" explanation. */
export function largestTableFree(floor: FloorState): number {
  return Math.max(0, ...floor.tables.map((t) => (t.status === 'unknown' || t.free === null ? 0 : t.free)));
}

/** True when no table on the floor has a working sensor behind it. */
export function floorIsDark(floor: FloorState): boolean {
  return floor.tables.length > 0 && floor.tables.every((t) => t.status === 'unknown' || t.free === null);
}
