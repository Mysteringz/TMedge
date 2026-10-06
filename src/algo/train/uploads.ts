/**
 * Code arriving for a job: a single .py (at most 5 MB) or a .zip project
 * (at most maxUploadMb), HANDOVER.md §6.2.
 *
 * The body is the file itself (application/octet-stream), streamed to disk
 * through a byte meter: no multipart parser to add as a dependency, and
 * never 200 MB held in memory on a box with 1 GB of it. An upload is
 * pending until a job adopts it, and pending uploads that nobody saves are
 * swept after an hour.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HpcConfig } from './config.js';
import type { CodeInfo, JobStore } from './store.js';
import { UUID } from './store.js';
import { extractZip, readZip, ZipError } from './zip.js';

export const MAX_PY_BYTES = 5 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5000;
/** More than this many .py files is a virtualenv or site-packages, not a project. */
export const MAX_PY_FILES = 1000;
export const PENDING_TTL_MS = 60 * 60 * 1000;
export const MAX_PENDING_PER_USER = 5;
/** A file name as uploaded: no path, no leading dot or dash. */
const FILENAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\.(py|zip)$/;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface Upload extends CodeInfo {
  id: string;
  user: string;
  createdAt: number;
}

class Counter extends Transform {
  bytes = 0;
  readonly hash = createHash('sha256');
  constructor(private readonly max: number) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) return done(new UploadError(`larger than ${Math.round(this.max / 1048576)} MB`, 413));
    this.hash.update(chunk);
    done(null, chunk);
  }
}

export class Uploads {
  private pending = new Map<string, Upload>();
  readonly dir: string;
  private readonly incoming: string;

  constructor(root: string, private readonly cfg: HpcConfig, private readonly store: JobStore) {
    this.dir = join(root, 'uploads');
    this.incoming = join(root, 'incoming');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.incoming, { recursive: true, mode: 0o700 });
    // A restart keeps uploads made in the last hour: someone may be about to save.
    for (const id of readdirSync(this.dir)) {
      try {
        const u = JSON.parse(readFileSync(join(this.dir, id, 'upload.json'), 'utf8')) as Upload;
        if (u.id === id && UUID.test(id) && typeof u.user === 'string') this.pending.set(id, u);
      } catch { /* swept below */ }
    }
    this.sweep();
  }

  /** Limits for one file name, before a byte is read. */
  limitFor(filename: string): number {
    return filename.endsWith('.py') ? MAX_PY_BYTES : this.cfg.maxUploadMb * 1024 * 1024;
  }

  /** The person's pending upload, or undefined (also for anyone else's). */
  get(user: string, id: string): Upload | undefined {
    const u = UUID.test(id) ? this.pending.get(id) : undefined;
    return u && u.user === user && Date.now() - u.createdAt < PENDING_TTL_MS ? u : undefined;
  }

  codeDir(id: string): string {
    return join(this.dir, id, 'code');
  }

  /** The job store took the code directory; forget the rest. */
  adopted(id: string): void {
    this.pending.delete(id);
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  usage(user: string): number {
    let n = 0;
    for (const u of this.pending.values()) if (u.user === user) n += u.unpackedBytes;
    return n;
  }

  async receive(user: string, rawName: unknown, req: IncomingMessage): Promise<Upload> {
    const filename = typeof rawName === 'string' ? rawName : '';
    if (!FILENAME.test(filename)) {
      throw new UploadError('upload a .py or .zip file whose name is letters, digits, _ . - (not starting with . or -)');
    }
    const kind = filename.endsWith('.py') ? 'py' : 'zip';
    const max = this.limitFor(filename);
    // An honest client says how big it is; refuse before reading a byte.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) throw new UploadError(`${filename} is larger than ${Math.round(max / 1048576)} MB`, 413);
    const quota = this.cfg.quotaMb * 1024 * 1024;
    const used = this.store.usage(user) + this.usage(user);
    if (used >= quota) throw new UploadError(`you are using all of your ${this.cfg.quotaMb} MB of job code; delete old drafts first`, 413);

    // Keep the newest few pending uploads per person, not an unbounded pile.
    const mine = [...this.pending.values()].filter((u) => u.user === user).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_PENDING_PER_USER) this.drop(mine.shift()!.id);

    const id = randomUUID();
    const part = join(this.incoming, `${id}.part`);
    const dest = join(this.dir, id);
    const counter = new Counter(max);
    try {
      await pipeline(req, counter, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
      if (counter.bytes === 0) throw new UploadError(`${filename} is empty`);
      mkdirSync(dest, { mode: 0o700 });
      let info: Omit<CodeInfo, 'filename' | 'bytes' | 'sha256'>;
      if (kind === 'py') {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(part));
        } catch {
          throw new UploadError(`${filename} is not UTF-8 text`);
        }
        if (used + counter.bytes > quota) throw new UploadError(`this would pass your ${this.cfg.quotaMb} MB of job code; delete old drafts first`, 413);
        mkdirSync(join(dest, 'code'), { mode: 0o700 });
        renameSync(part, join(dest, 'code', filename));
        info = { kind, unpackedBytes: counter.bytes, fileCount: 1, py: [filename] };
      } else {
        const { entries, unpackedBytes } = await readZip(part, {
          maxEntries: MAX_ZIP_ENTRIES, maxUnpackedBytes: this.cfg.maxUnpackedMb * 1024 * 1024,
        });
        if (used + unpackedBytes > quota) throw new UploadError(`this unpacks past your ${this.cfg.quotaMb} MB of job code; delete old drafts first`, 413);
        const files = entries.filter((e) => !e.dir && !e.skip).map((e) => e.path);
        const py = files.filter((f) => f.endsWith('.py')).sort();
        if (py.length === 0) throw new UploadError(`${filename} has no .py file to run`);
        if (py.length > MAX_PY_FILES) {
          throw new UploadError(`${filename} has ${py.length} .py files; leave virtualenvs and site-packages out and install packages in a conda env on HPC`);
        }
        await extractZip(part, join(dest, 'code'), entries);
        rmSync(part, { force: true });
        info = { kind, unpackedBytes, fileCount: files.length, py };
      }
      const upload: Upload = {
        id, user, createdAt: Date.now(), filename, bytes: counter.bytes,
        sha256: counter.hash.digest('hex'), ...info,
      };
      writeFileSync(join(dest, 'upload.json'), JSON.stringify(upload), { mode: 0o600 });
      this.pending.set(id, upload);
      return upload;
    } catch (err) {
      rmSync(part, { force: true });
      rmSync(dest, { recursive: true, force: true });
      if (err instanceof ZipError) throw new UploadError(`${filename}: ${err.message}`);
      if (err instanceof UploadError) throw err;
      // The browser went away mid-upload, or the disk is full: not their input's fault.
      throw new UploadError(`upload failed: ${(err as Error).message}`, 500);
    }
  }

  private drop(id: string): void {
    this.pending.delete(id);
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /** Pending uploads past their hour, and half-received files from a crash. */
  sweep(now = Date.now()): void {
    for (const [id, u] of this.pending) if (now - u.createdAt >= PENDING_TTL_MS) this.drop(id);
    for (const id of readdirSync(this.dir)) if (!this.pending.has(id)) rmSync(join(this.dir, id), { recursive: true, force: true });
    for (const f of readdirSync(this.incoming)) {
      const p = join(this.incoming, f);
      try { if (now - statSync(p).mtimeMs >= PENDING_TTL_MS) rmSync(p, { force: true }); } catch { /* gone */ }
    }
  }

  /** For tests and shutdown: is anything left half-written? */
  incomingFiles(): string[] {
    return existsSync(this.incoming) ? readdirSync(this.incoming) : [];
  }
}
