/** Append-only daily JSONL logs under the edge data directory. */
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { OccupancySnapshot } from '../shared/types.js';
import type { RecorderHealth, RecordingHealthProvider, RecordingStreamHealth } from '../modules/recordings/repositories/recording-lifecycle.js';
import { operationalLog } from '../shared/logging/operational-logger.js';
import type { Raw, Report } from './protocol.js';

export const DEFAULT_RECORDING_QUEUE_BYTES = 1_048_576;

export interface RecorderOptions {
  maxQueuedBytes?: number;
  openStream?: (file: string) => Writable;
}

interface QueuedRecord {
  day: string;
  line: string;
  bytes: number;
}

/** Owns one file stream and a bounded FIFO across daily rotations. */
export class DailyLog {
  private stream: Writable | null = null;
  private streamDay = '';
  private readonly queue: QueuedRecord[] = [];
  private queuedBytes = 0;
  private processing = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private droppedRecords = 0;
  private writeErrors = 0;
  private lastSuccessfulWriteAt: number | null = null;
  private lastError: string | null = null;  bytesToday = 0;

  constructor(
    private readonly dir: string,
    private readonly maxQueuedBytes = DEFAULT_RECORDING_QUEUE_BYTES,
    private readonly openStream: (file: string) => Writable = (file) => createWriteStream(file, { flags: 'a' }),
  ) {
    mkdirSync(dir, { recursive: true });
  }

  write(at: number, record: unknown): void {
    const day = new Date(at).toISOString().slice(0, 10);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.closing || bytes > this.maxQueuedBytes || this.queuedBytes + bytes > this.maxQueuedBytes) {
      this.droppedRecords += 1;
      return;
    }
    this.queue.push({ day, line, bytes });
    this.queuedBytes += bytes;
    this.pump();
  }

  health(): RecordingStreamHealth {
    return {
      queuedBytes: this.queuedBytes,
      queueLimitBytes: this.maxQueuedBytes,
      droppedRecords: this.droppedRecords,
      writeErrors: this.writeErrors,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      healthy: this.lastError === null,
      lastError: this.lastError,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    this.pump();
    return this.closePromise;
  }

  private pump(): void {
    if (this.processing) return;
    const next = this.queue[0];
    if (next && this.stream && this.streamDay !== next.day) {
      this.finishStream();
      return;
    }
    if (next) {
      this.writeNext(next);
      return;
    }
    if (this.closing && this.stream) {
      this.finishStream();
      return;
    }
    if (this.closing) this.resolveClose?.();
  }

  private writeNext(record: QueuedRecord): void {
    const stream = this.stream ?? this.openDay(record.day);
    if (!stream) return;
    this.processing = true;
    stream.write(record.line, (error?: Error | null) => {
      if (this.stream !== stream) return;
      if (error) {
        this.failStream(stream, error);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= record.bytes;
      this.bytesToday += record.bytes;
      this.lastSuccessfulWriteAt = Date.now();
      this.lastError = null;
      this.processing = false;
      this.pump();
    });
  }

  private openDay(day: string): Writable | null {
    const file = join(this.dir, `${day}.jsonl`);
    try {
      this.bytesToday = statSync(file).size;
    } catch {
      this.bytesToday = 0;
    }
    let stream: Writable;
    try {
      stream = this.openStream(file);
    } catch (error: unknown) {
      this.failQueued(error);
      return null;
    }
    this.stream = stream;
    this.streamDay = day;
    stream.on('error', (error: Error) => this.failStream(stream, error));
    return stream;
  }

  private finishStream(): void {
    const stream = this.stream;
    if (!stream || this.processing) return;
    this.processing = true;
    stream.end(() => {
      if (this.stream === stream) {
        this.stream = null;
        this.streamDay = '';
      }
      this.processing = false;
      this.pump();
    });
  }

  private failStream(stream: Writable, error: Error): void {
    if (this.stream !== stream) return;
    this.stream = null;
    this.streamDay = '';
    this.processing = false;
    this.writeErrors += 1;
    this.lastError = error.message;
    operationalLog('recording.write_failed', { component: 'recorder', outcome: 'failed', count: 1 });
    this.droppedRecords += this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
    stream.destroy();
    this.pump();
  }

  private failQueued(error: unknown): void {
    this.writeErrors += 1;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.droppedRecords += this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.pump();  }
}

const r2 = (value: number): number => Math.round(value * 100) / 100;

export class Recorder implements RecordingHealthProvider {
  private readonly detections: DailyLog;
  private readonly occupancy: DailyLog;
  private readonly raw: DailyLog | null;

  constructor(readonly dir: string, readonly rawEnabled: boolean, options: RecorderOptions = {}) {
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_RECORDING_QUEUE_BYTES;
    const openStream = options.openStream ?? ((file: string) => createWriteStream(file, { flags: 'a' }));
    this.detections = new DailyLog(join(dir, 'detections'), maxQueuedBytes, openStream);
    this.occupancy = new DailyLog(join(dir, 'occupancy'), maxQueuedBytes, openStream);
    this.raw = rawEnabled ? new DailyLog(join(dir, 'raw'), maxQueuedBytes, openStream) : null;
  }

  report(report: Report, at: number): void {
    this.detections.write(at, {
      t: at,
      uid: report.uid,
      boot: report.boot,
      frame: report.frame,
      flags: report.flags,
      bg: report.bgMean,
      d: report.detections.map((detection) => [r2(detection.x), r2(detection.y), detection.area,
        r2(detection.contrast), detection.peak, r2(detection.heat)]),
    });
  }

  rawFrame(frame: Raw, at: number): void {
    this.raw?.write(at, { t: at, uid: frame.uid, frame: frame.frame, tMin: frame.tMin,
      step: frame.step, px: Buffer.from(frame.pixels).toString('base64') });
  }

  snapshot(snapshot: OccupancySnapshot): void {
    const tables: Record<string, [number | null, string, string]> = {};
    for (const floor of snapshot.floors) {
      for (const table of floor.tables) {
        tables[table.id] = [table.occupied, table.status,
          table.seats.map((seat) => (seat.occupied === null ? '?' : seat.occupied ? '1' : '0')).join('')];
      }
    }
    this.occupancy.write(snapshot.generatedAt, { t: snapshot.generatedAt, tables });
  }

  bytesToday(): number {
    return this.detections.bytesToday + this.occupancy.bytesToday + (this.raw?.bytesToday ?? 0);
  }

  health(): RecorderHealth {
    return { detections: this.detections.health(), occupancy: this.occupancy.health(), raw: this.raw?.health() ?? null };
  }

  async close(): Promise<void> {
    await Promise.all([this.detections.close(), this.occupancy.close(), this.raw?.close()]);
  }
}
