/**
 * Append-only daily logs under DATA_DIR. These are the calibration data the
 * Phase 3 layout learner will train on, so they are written from day one:
 *
 *   detections/YYYY-MM-DD.jsonl   every REPORT: node, frame, blobs (sensor px)
 *   occupancy/YYYY-MM-DD.jsonl    once a minute: each table's seats and status
 *   raw/YYYY-MM-DD.jsonl          every RAW frame, only with RECORD_RAW=1
 *                                 (~70 MB per node per day at 1 fps)
 *
 * Detections are stored in sensor pixels, not plan cm, so a later change to a
 * node's pose can be re-applied to old data rather than invalidating it.
 * These files stay on the edge: they are below the privacy boundary.
 */
import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { OccupancySnapshot } from '../shared/types.js';
import type { Raw, Report } from './protocol.js';

class DailyLog {
  private stream: WriteStream | null = null;
  private day = '';
  bytesToday = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  write(at: number, record: unknown): void {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.stream?.end();
      this.day = day;
      const file = join(this.dir, `${day}.jsonl`);
      try {
        this.bytesToday = statSync(file).size;
      } catch {
        this.bytesToday = 0;
      }
      this.stream = createWriteStream(file, { flags: 'a' });
    }
    const line = JSON.stringify(record) + '\n';
    this.bytesToday += Buffer.byteLength(line);
    this.stream?.write(line);
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class Recorder {
  private readonly detections: DailyLog;
  private readonly occupancy: DailyLog;
  private readonly raw: DailyLog | null;

  constructor(readonly dir: string, readonly rawEnabled: boolean) {
    this.detections = new DailyLog(join(dir, 'detections'));
    this.occupancy = new DailyLog(join(dir, 'occupancy'));
    this.raw = rawEnabled ? new DailyLog(join(dir, 'raw')) : null;
  }

  report(p: Report, at: number): void {
    this.detections.write(at, {
      t: at,
      uid: p.uid,
      boot: p.boot,
      frame: p.frame,
      flags: p.flags,
      bg: p.bgMean,
      d: p.detections.map((d) => [r2(d.x), r2(d.y), d.area, r2(d.contrast), d.peak, r2(d.heat)]),
    });
  }

  rawFrame(p: Raw, at: number): void {
    this.raw?.write(at, { t: at, uid: p.uid, frame: p.frame, tMin: p.tMin, step: p.step, px: Buffer.from(p.pixels).toString('base64') });
  }

  snapshot(s: OccupancySnapshot): void {
    const tables: Record<string, [number | null, string, string]> = {};
    for (const f of s.floors) {
      for (const t of f.tables) {
        tables[t.id] = [t.occupied, t.status, t.seats.map((x) => (x.occupied === null ? '?' : x.occupied ? '1' : '0')).join('')];
      }
    }
    this.occupancy.write(s.generatedAt, { t: s.generatedAt, tables });
  }

  bytesToday(): number {
    return this.detections.bytesToday + this.occupancy.bytesToday + (this.raw?.bytesToday ?? 0);
  }

  async close(): Promise<void> {
    await Promise.all([this.detections.close(), this.occupancy.close(), this.raw?.close()]);
  }
}
