/**
 * Where the tables are, inferred from where people sit.
 *
 * Today the edge is told the tables: `config/site.json` carries a rectangle
 * per table, measured by hand. That does not scale past a pilot, and it is
 * the thing Phase 3 is meant to remove. This is a first estimator, written so
 * the debugger can show its reasoning stage by stage rather than only its
 * answer -- an estimator that is confidently wrong looks exactly like a
 * detection bug from the outside, which is why the plan calls this the key
 * debugging stage.
 *
 * The idea: a seat is a place people are repeatedly still. Sum dwell (person
 * seconds) per floor cell, find the peaks, and a table is the middle of a
 * group of peaks that sit about one seat-depth apart. Nothing here decides
 * occupancy; it only proposes rectangles, which are then compared against the
 * configured ones so the difference is visible.
 */
import { DWELL_CELL_CM } from '../edge/dwell.js';

export interface DeskParams {
  /** Cells this far apart or closer are one cluster, cm. */
  clusterRadiusCm: number;
  /** Person-seconds a cell needs before it counts as a seat at all. */
  minDwellSeconds: number;
  /** How far a seated person is from the middle of their table, cm. */
  seatToDeskCm: number;
  /** Clusters closer than this belong to the same table. */
  deskSpacingCm: number;
  /** Below this, a candidate is reported but not selected. */
  minConfidence: number;
}

export const DEFAULT_DESK: DeskParams = {
  clusterRadiusCm: 60,
  minDwellSeconds: 120,
  seatToDeskCm: 55,
  deskSpacingCm: 140,
  minConfidence: 0.35,
};

export interface SeatCluster {
  x: number;
  y: number;
  /** Person-seconds gathered into this cluster. */
  weight: number;
  cells: number;
}

export interface DeskCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The seat clusters that voted for it. */
  support: SeatCluster[];
  confidence: number;
  selected: boolean;
  rejectedBecause: string | null;
  /** The configured table it lands on, when there is one, and how far off it is. */
  matches: { tableId: string; offsetCm: number } | null;
}

export interface DeskResult {
  /** Every stage, so the UI can show the deduction rather than the verdict. */
  stages: {
    cells: { x: number; y: number; weight: number }[];
    clusters: SeatCluster[];
    candidates: DeskCandidate[];
  };
  desks: DeskCandidate[];
  params: DeskParams;
}

export interface ConfiguredTable {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * @param grid dwell weights, row-major, in DWELL_CELL_CM cells
 */
export function estimateDesks(
  grid: number[],
  cols: number,
  rows: number,
  tables: ConfiguredTable[],
  params: DeskParams = DEFAULT_DESK,
): DeskResult {
  // 1. cells worth considering at all
  const cells: { x: number; y: number; weight: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = grid[r * cols + c] ?? 0;
      if (w >= params.minDwellSeconds) {
        cells.push({ x: (c + 0.5) * DWELL_CELL_CM, y: (r + 0.5) * DWELL_CELL_CM, weight: w });
      }
    }
  }

  // 2. cluster them into seats: heaviest cell first, absorb everything within
  //    the radius. Greedy rather than k-means because the number of seats is
  //    exactly what we do not know.
  const clusters: SeatCluster[] = [];
  const taken = new Set<number>();
  const order = cells.map((_, i) => i).sort((a, b) => (cells[b]?.weight ?? 0) - (cells[a]?.weight ?? 0));
  for (const i of order) {
    if (taken.has(i)) continue;
    const seed = cells[i];
    if (!seed) continue;
    let sx = 0, sy = 0, sw = 0, n = 0;
    for (const j of order) {
      const c = cells[j];
      if (taken.has(j) || !c) continue;
      if (Math.hypot(c.x - seed.x, c.y - seed.y) > params.clusterRadiusCm) continue;
      taken.add(j);
      sx += c.x * c.weight;
      sy += c.y * c.weight;
      sw += c.weight;
      n += 1;
    }
    if (sw > 0) clusters.push({ x: sx / sw, y: sy / sw, weight: sw, cells: n });
  }

  // 3. group seat clusters into tables: people sit around one, so clusters
  //    within a table's span vote for the same rectangle.
  const groups: SeatCluster[][] = [];
  const used = new Set<number>();
  const byWeight = clusters.map((_, i) => i).sort((a, b) => (clusters[b]?.weight ?? 0) - (clusters[a]?.weight ?? 0));
  for (const i of byWeight) {
    if (used.has(i)) continue;
    const seed = clusters[i];
    if (!seed) continue;
    const group: SeatCluster[] = [];
    for (const j of byWeight) {
      const c = clusters[j];
      if (used.has(j) || !c) continue;
      if (Math.hypot(c.x - seed.x, c.y - seed.y) > params.deskSpacingCm) continue;
      used.add(j);
      group.push(c);
    }
    if (group.length > 0) groups.push(group);
  }

  // 4. a candidate table is the middle of its group, grown to cover the seats
  //    minus the distance a person sits back from the edge.
  const totalWeight = clusters.reduce((s, c) => s + c.weight, 0) || 1;
  const candidates: DeskCandidate[] = groups.map((group, i) => {
    const w = group.reduce((s, c) => s + c.weight, 0);
    const cx = group.reduce((s, c) => s + c.x * c.weight, 0) / w;
    const cy = group.reduce((s, c) => s + c.y * c.weight, 0) / w;
    const xs = group.map((c) => c.x);
    const ys = group.map((c) => c.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // People sit on the long sides, so the table is the span along the axis
    // they spread on, and narrower across it by twice the seat setback.
    const alongX = spanX >= spanY;
    const width = Math.max(60, alongX ? spanX : Math.max(40, spanX - params.seatToDeskCm));
    const height = Math.max(60, alongX ? Math.max(40, spanY - params.seatToDeskCm) : spanY);

    // Confidence: how much of the floor's dwell this table gathered, how many
    // seats agreed, and whether those seats sit at a plausible distance.
    const share = w / totalWeight;
    const seats = Math.min(1, group.length / 4);
    const spread = group.length < 2 ? 0.4
      : Math.min(1, params.deskSpacingCm / Math.max(1, Math.max(spanX, spanY)));
    const confidence = Math.min(1, 0.45 * Math.min(1, share * 6) + 0.35 * seats + 0.2 * spread);

    const match = nearestTable(cx, cy, tables);
    return {
      id: `desk-${i + 1}`,
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      support: group,
      confidence,
      selected: confidence >= params.minConfidence,
      rejectedBecause: confidence >= params.minConfidence ? null
        : group.length < 2 ? 'only one seat cluster supports it'
          : 'not enough dwell to be sure',
      matches: match,
    };
  }).sort((a, b) => b.confidence - a.confidence);

  return {
    stages: { cells, clusters, candidates },
    desks: candidates.filter((c) => c.selected),
    params,
  };
}

function nearestTable(x: number, y: number, tables: ConfiguredTable[]): { tableId: string; offsetCm: number } | null {
  let best: { tableId: string; offsetCm: number } | null = null;
  for (const t of tables) {
    const d = Math.hypot(x - (t.x + t.width / 2), y - (t.y + t.height / 2));
    if (!best || d < best.offsetCm) best = { tableId: t.id, offsetCm: d };
  }
  return best;
}
