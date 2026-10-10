/**
 * Finished analytics buckets on disk, as append-only JSON lines.
 *
 * One line per bucket, one file per day or month. Appending a few hundred
 * bytes a minute costs nothing, a crash can only lose the line being written,
 * and retention is deleting whole files -- no rewrite of a history file on a
 * box that also has to keep up with sensor packets.
 *
 * Nothing here throws. It is called from request handlers and sampling
 * timers of services whose real job is elsewhere: a directory that cannot be
 * written costs the charts their history, and must cost nothing more.
 */
import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogPeriod = 'day' | 'month';

export interface BucketLine<T> { t: number; v: T }

export class BucketLog {
  private queue: Promise<void> = Promise.resolve();
  private made = false;
  writeErrors = 0;

  /** `dir` null keeps everything in memory: tests, and a tier nobody configured a directory for. */
  constructor(private readonly dir: string | null) {}

  get persistent(): boolean { return this.dir !== null; }

  private ensureDir(): string | null {
    if (!this.dir) return null;
    if (!this.made) {
      try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.made = true; } catch { this.writeErrors += 1; return null; }
    }
    return this.dir;
  }

  private entries(): string[] {
    if (!this.dir) return [];
    try { return existsSync(this.dir) ? readdirSync(this.dir) : []; } catch { return []; }
  }

  private file(name: string, period: LogPeriod, at: number): string {
    const iso = new Date(at).toISOString();
    return `${name}-${period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7)}.jsonl`;
  }

  /** Queued so lines land in order; a failed write is counted, never thrown at the caller. */
  append<T>(name: string, period: LogPeriod, line: BucketLine<T>): void {
    this.queue = this.queue.then(async () => {
      const dir = this.ensureDir();
      if (!dir) return;
      await appendFile(join(dir, this.file(name, period, line.t)), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    }).catch(() => { this.writeErrors += 1; });
  }

  /** Every retained line at or after `since`, oldest first. A torn last line is skipped. */
  load<T>(name: string, since: number): BucketLine<T>[] {
    if (!this.dir) return [];
    const out: BucketLine<T>[] = [];
    const prefix = `${name}-`;
    const earliestDay = new Date(since).toISOString().slice(0, 10);
    for (const entry of this.entries().sort()) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue;
      const stamp = entry.slice(prefix.length, -'.jsonl'.length);
      // A month file (YYYY-MM) may still hold wanted days; compare on the shared prefix.
      if (stamp < earliestDay.slice(0, stamp.length)) continue;
      let text: string;
      try { text = readFileSync(join(this.dir, entry), 'utf8'); } catch { continue; }
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          const line = JSON.parse(raw) as BucketLine<T>;
          if (typeof line?.t === 'number' && Number.isFinite(line.t) && line.t >= since && line.v !== undefined) out.push(line);
        } catch { /* torn or damaged line */ }
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Delete whole files that end before `before`. */
  prune(name: string, period: LogPeriod, before: number): number {
    if (!this.dir) return 0;
    const prefix = `${name}-`;
    const keepFrom = this.file(name, period, before);
    let removed = 0;
    for (const entry of this.entries()) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl') || entry.length !== keepFrom.length) continue;
      if (entry < keepFrom) { try { unlinkSync(join(this.dir, entry)); removed += 1; } catch { /* already gone */ } }
    }
    return removed;
  }

  /**
   * The bucket in progress, so a restart continues it instead of leaving a
   * hole. Read once and removed: after a crash there is no fresh state, and an
   * old one must not be replayed over a bucket that has since been finished.
   */
  takeState<T>(name: string): T | null {
    if (!this.dir) return null;
    const path = join(this.dir, `${name}.state.json`);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as T;
      unlinkSync(path);
      return value;
    } catch { return null; }
  }

  writeState(name: string, value: unknown): void {
    const dir = this.ensureDir();
    if (!dir) return;
    const path = join(dir, `${name}.state.json`);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch { this.writeErrors += 1; }
  }

  /** Resolves once every queued append has reached the file system. */
  flush(): Promise<void> { return this.queue; }
}
