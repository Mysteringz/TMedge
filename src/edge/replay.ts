import { closeSync, existsSync, fsync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Cursor { boot: number; seq: number }
const UID = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const u32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const MAX_QUEUED = 10_000;
interface Pending {
  uid: string;
  cursor: Cursor;
  commandSeq?: number;
  resolve(): void;
  reject(error: Error): void;
}

/** Durable write-ahead cursors: restarting the edge must not make old signed packets new. */
export class ReplayStore {
  readonly cursors = new Map<string, Cursor>();
  commandSeq = 0;
  private records = 0;
  private pending: Pending[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private failed: Error | null = null;
  private queued = 0;
  private readonly sync: (fd: number) => Promise<void>;

  constructor(private readonly path: string, opts: { sync?: (fd: number) => Promise<void>; batchMs?: number } = {}) {
    this.sync = opts.sync ?? ((fd) => new Promise((resolve, reject) => fsync(fd, (err) => err ? reject(err) : resolve())));
    this.batchMs = opts.batchMs ?? 5;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) this.checkpoint();
    if (statSync(path).size > 8 * 1024 * 1024) throw new Error('replay journal exceeds its limit');
    const lines = readFileSync(path, 'utf8').split('\n');
    if (lines.pop() !== '') throw new Error('incomplete replay journal; restore it before starting');
    for (const line of lines) {
      const r: unknown = JSON.parse(line);
      if (!Array.isArray(r)) throw new Error('invalid replay journal');
      // A STATUS can be queued before a newer command is allocated, then
      // persisted afterwards: that observation must never lower the cursor.
      if (r.length === 2 && r[0] === 'cmd' && u32(r[1])) this.commandSeq = Math.max(this.commandSeq, r[1]);
      else if (r.length === 3 && typeof r[0] === 'string' && UID.test(r[0]) &&
          Number.isInteger(r[1]) && r[1] >= 0 && r[1] <= 0xffffffff && u32(r[2])) {
        this.cursors.set(r[0], { boot: r[1], seq: r[2] });
      } else if (r.length === 2 && typeof r[0] === 'string' && UID.test(r[0]) && r[1] === null) this.cursors.delete(r[0]);
      else throw new Error('invalid replay journal record');
    }
    if (this.cursors.size > 5000) throw new Error('replay journal node limit exceeded');
    this.checkpoint();
  }
  private readonly batchMs: number;

  /** Synchronous compatibility path; production ingest uses acceptAsync. */
  accept(uid: string, cursor: Cursor): void {
    if (this.queued) throw new Error('durable packet writes are pending');
    this.validate(uid, cursor);
    this.append([uid, cursor.boot, cursor.seq]);
    this.cursors.set(uid, { ...cursor });
  }

  /** Several nodes share one async fsync; none is admitted until it finishes. */
  acceptAsync(uid: string, cursor: Cursor, commandSeq?: number): Promise<void> {
    try {
      this.checkHealth();
      this.validate(uid, cursor);
      if (commandSeq !== undefined && !u32(commandSeq)) throw new Error('invalid command cursor');
      if (this.queued >= MAX_QUEUED) throw new Error('replay journal queue full');
    } catch (error) { return Promise.reject(error); }
    this.queued += 1;
    const done = new Promise<void>((resolve, reject) => this.pending.push({ uid, cursor: { ...cursor }, commandSeq, resolve, reject }));
    this.schedule();
    return done;
  }

  command(seq: number): void {
    if (!u32(seq)) throw new Error('invalid command cursor');
    this.checkHealth();
    if (seq <= this.commandSeq) return;
    // Packet batches write complete records synchronously, then fsync on a
    // worker. A rare command can append and fsync the same inode safely.
    this.append(['cmd', seq]);
    this.commandSeq = seq;
  }

  reset(uid: string): boolean {
    if (!UID.test(uid)) throw new Error('invalid node uid');
    if (this.queued) throw new Error('durable packet writes are pending; retry cursor reset');
    const existed = this.cursors.has(uid);
    this.append([uid, null]);
    this.cursors.delete(uid);
    return existed;
  }

  private validate(uid: string, cursor: Cursor): void {
    if (!UID.test(uid) || !Number.isInteger(cursor.boot) || cursor.boot < 0 || cursor.boot > 0xffffffff || !u32(cursor.seq)) {
      throw new Error('invalid replay cursor');
    }
  }

  private checkHealth(): void { if (this.failed) throw this.failed; }

  private schedule(): void {
    if (this.flushing || this.timer || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.batchMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const batch = this.pending.splice(0);
    let fd: number | null = null;
    try {
      this.checkHealth();
      // A checkpoint cannot race an outstanding async fsync or forget its
      // records. It runs between batches, at most once per 10,000 records.
      if (this.records >= 10000) this.checkpoint();
      fd = openSync(this.path, 'a', 0o600);
      const lines: string[] = [];
      for (const p of batch) {
        lines.push(JSON.stringify([p.uid, p.cursor.boot, p.cursor.seq]));
        if (p.commandSeq !== undefined) lines.push(JSON.stringify(['cmd', p.commandSeq]));
      }
      this.write(fd, `${lines.join('\n')}\n`);
      await this.sync(fd);
      this.checkHealth();
      closeSync(fd);
      fd = null;
      for (const p of batch) {
        this.cursors.set(p.uid, p.cursor);
        if (p.commandSeq !== undefined) this.commandSeq = Math.max(this.commandSeq, p.commandSeq);
      }
      this.records += lines.length;
      for (const p of batch) p.resolve();
    } catch (error) {
      // A partially written/torn journal cannot safely accept further data.
      // Recovery will validate it and fail closed if the tail is incomplete.
      this.failed = error instanceof Error ? error : new Error(String(error));
      for (const p of batch) p.reject(this.failed);
      for (const p of this.pending.splice(0)) { this.queued -= 1; p.reject(this.failed); }
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* primary write/close error already latched */ } }
      this.queued -= batch.length;
      this.flushing = false;
      this.schedule();
    }
  }

  private append(record: unknown): void {
    this.checkHealth();
    // Never replace an inode while a worker is making its batch durable.
    if (!this.flushing && this.records >= 10000) this.checkpoint();
    const fd = openSync(this.path, 'a', 0o600);
    try { this.write(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); }
    catch (error) { this.failed = error instanceof Error ? error : new Error(String(error)); throw this.failed; }
    finally { closeSync(fd); }
    this.records += 1;
  }

  private write(fd: number, text: string): void {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n <= 0) throw new Error('replay journal write failed');
      offset += n;
    }
  }

  private checkpoint(): void {
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      this.write(fd, `${JSON.stringify(['cmd', this.commandSeq])}\n`);
      for (const [uid, c] of this.cursors) this.write(fd, `${JSON.stringify([uid, c.boot, c.seq])}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    this.records = 0;
  }
}
