import { randomUUID, createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawFrameMessage } from '../shared/types.js';
import type { FrameStore } from './frames.js';
import { MAX_SKEW_MS, type PairStats } from './pairs.js';

/** Disk is an outbox: only the worker removes a record after database verification. */
export class TrainingSpool {
  recording = false;
  private lastError: string | null = null;
  private thermalIds = new Map<string, string>();
  private budget = { at: 0, bytes: 0, files: 0 };

  constructor(private readonly dir: string, private readonly recordingFile: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(recordingFile)) this.recording = readFileSync(recordingFile, 'utf8').trim() === '1';
  }

  setRecording(on: boolean): void {
    writeFileSync(this.recordingFile, on ? '1' : '0');
    this.recording = on;
  }

  stats(): PairStats {
    let transferError: string | null = null;
    let counts = { samples: 0, withPeople: 0, bytes: 0, oldest: null as number | null, newest: null as number | null };
    try {
      const status: unknown = JSON.parse(readFileSync(join(this.dir, 'status.json'), 'utf8'));
      if (typeof status === 'object' && status !== null && 'samples' in status) {
        const s = status as Record<string, unknown>;
        if (this.recording && (typeof s.updatedAt !== 'number' || Date.now() - s.updatedAt > 60_000)) {
          transferError = 'PostgreSQL transfer status is stale; recordings remain in the local outbox';
        }
        if (typeof s.samples === 'number' && typeof s.withPeople === 'number' && typeof s.bytes === 'number') {
          counts = { samples: s.samples, withPeople: s.withPeople, bytes: s.bytes,
            oldest: typeof s.oldest === 'number' ? s.oldest : null,
            newest: typeof s.newest === 'number' ? s.newest : null };
        }
      }
    } catch {
      if (this.recording) transferError = 'Waiting for the PostgreSQL transfer worker';
    }
    return { ...counts, recording: this.recording, lastSkipped: this.lastError ?? transferError };
  }

  raw(msg: RawFrameMessage, metadata: unknown): void {
    if (!this.recording) return;
    const id = createHash('sha256').update(`${msg.uid}:${msg.receivedAt}:${msg.frame}`).digest('hex');
    if (this.write({ version: 1, id, kind: 'thermal', ...msg,
      pixels: Buffer.from(msg.pixels).toString('base64'), metadata })) {
      this.thermalIds.set(`${msg.uid}:${msg.frame}:${msg.receivedAt}`, id);
      if (this.thermalIds.size > 4096) {
        const oldest = this.thermalIds.keys().next().value;
        if (oldest !== undefined) this.thermalIds.delete(oldest);
      }
    }
  }

  offer(uid: string, jpeg: Buffer, at: number, frames: FrameStore, mirror: boolean): void {
    if (!this.recording) return;
    const receivedAt = Date.now();
    const nearest = frames.list(uid).reduce<ReturnType<FrameStore['latest']>>((best, f) =>
      !best || Math.abs(f.receivedAt - at) < Math.abs(best.receivedAt - at) ? f : best, null);
    const skew = nearest ? Math.abs(nearest.receivedAt - at) : null;
    const thermalId = nearest && skew !== null && skew <= MAX_SKEW_MS
      ? this.thermalIds.get(`${uid}:${nearest.frame}:${nearest.receivedAt}`) : undefined;
    this.write({ version: 1, id: randomUUID(), kind: 'rgb', uid, at, receivedAt,
      jpeg: jpeg.toString('base64'), mirror, thermalId: thermalId ?? null,
      skewMs: thermalId ? skew : null, observed: nearest?.deviceDetections ?? null,
      metadata: { timestampMeaning: 'camera clock after JPEG encoding' } });
  }

  prune(): number {
    // Pruning an unacknowledged outbox would silently discard training data.
    this.lastError = 'PostgreSQL recordings are retained; use a reviewed database retention policy';
    return 0;
  }

  private write(record: unknown): boolean {
    const name = join(this.dir, `${Date.now()}-${randomUUID()}.json`);
    const temporary = `${name}.tmp`;
    try {
      const contents = JSON.stringify(record);
      const bytes = Buffer.byteLength(contents);
      if (Date.now() - this.budget.at > 10000) {
        let size = 0, files = 0;
        for (const file of readdirSync(this.dir)) {
          if (!file.endsWith('.json') && !file.endsWith('.tmp')) continue;
          try { size += statSync(join(this.dir, file)).size; files += 1; } catch { /* worker removed it */ }
        }
        this.budget = { at: Date.now(), bytes: size, files };
      }
      const disk = statfsSync(this.dir);
      if (this.budget.bytes + bytes > 512 * 1024 * 1024 || this.budget.files >= 10000 ||
          disk.bavail * disk.bsize < 128 * 1024 * 1024 + bytes) {
        this.lastError = 'training outbox at capacity; new recordings paused until the worker drains it';
        return false;
      }
      writeFileSync(temporary, contents, { mode: 0o600 });
      const fd = openSync(temporary, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, name);
      const directory = openSync(this.dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.lastError = null;
      this.budget.bytes += bytes;
      this.budget.files += 1;
      return true;
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* disk remains unavailable */ }
      this.lastError = 'training outbox could not be written; inspect disk and worker health';
      console.error('[training] outbox write failed');
      return false;
    }
  }
}
