/**
 * Where people spend time, per floor, on a 25 cm grid in plan coordinates.
 *
 * Every counted detection adds its person-seconds to its cell; the map decays
 * with a half-life so it follows the current layout. The console draws it,
 * which is the quickest way to see a mis-set pose: dwell that should sit on
 * the chairs lands on a table or in the aisle.
 *
 * This is also the seed of the Phase 3 layout learner, which will work from
 * the recorded detection logs rather than this live, decaying map.
 */
export const DWELL_CELL_CM = 25;

export class DwellMap {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Float32Array;
  private lastDecayAt = 0;

  constructor(readonly width: number, readonly height: number, private readonly halfLifeMs = 3_600_000) {
    this.cols = Math.ceil(width / DWELL_CELL_CM);
    this.rows = Math.ceil(height / DWELL_CELL_CM);
    this.cells = new Float32Array(this.cols * this.rows);
  }

  add(x: number, y: number, personSeconds: number, at: number): void {
    this.decay(at);
    const c = Math.floor(x / DWELL_CELL_CM);
    const r = Math.floor(y / DWELL_CELL_CM);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return;
    this.cells[r * this.cols + c] = (this.cells[r * this.cols + c] ?? 0) + personSeconds;
  }

  private decay(at: number): void {
    if (this.lastDecayAt === 0) {
      this.lastDecayAt = at;
      return;
    }
    const dt = at - this.lastDecayAt;
    if (dt < 10_000) return;   // decaying the whole grid per frame is wasteful; every 10 s is plenty
    const f = Math.pow(0.5, dt / this.halfLifeMs);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = (this.cells[i] ?? 0) * f;
    this.lastDecayAt = at;
  }

  toJSON(): { cellCm: number; cols: number; rows: number; max: number; cells: number[] } {
    let max = 0;
    for (const v of this.cells) max = Math.max(max, v);
    return { cellCm: DWELL_CELL_CM, cols: this.cols, rows: this.rows, max, cells: Array.from(this.cells, (v) => Math.round(v * 10) / 10) };
  }
}
