import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { DataError, type TrainingDatabase } from './database.js';
import type { RemoteExportBackend } from './remote-exports.js';

export interface ExportJob {
  id: string; owner: string; epoch: string | null;
  state: 'queued' | 'processing' | 'completed' | 'failed';
  tables: string[]; createdAt: number; expiresAt: number;
  bytes: number; sha256: string | null; error: string | null;
  storage?: 'remote';
}
export type Dump = (tables: readonly string[]) => ChildProcess;
const TTL = 24 * 3600_000;
const ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const tableName = /^training\.[a-z_][a-z0-9_]{0,62}$/;

export function selectedTables(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || !value.every((t): t is string => typeof t === 'string' && tableName.test(t)) || new Set(value).size !== value.length) {
    throw new DataError('Select between 1 and 32 distinct training tables.');
  }
  return value;
}

export function nativeDump(url: string, command: string): Dump {
  const connection = new URL(url);
  return tables => spawn(command, ['--format=plain', '--no-owner', '--no-privileges', '--no-password', '--strict-names',
    '--lock-wait-timeout=10s', ...tables.flatMap(name => ['--table', `training."${name.slice(9)}"`])], {
    // No shell, no credential in argv, and no inherited app/cluster secrets.
    env: { PATH: process.env.PATH, PGHOST: connection.hostname, PGPORT: connection.port || '5432',
      PGDATABASE: connection.pathname.slice(1), PGUSER: connection.username, PGPASSWORD: decodeURIComponent(connection.password),
      PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'ml-data-export', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=7200000' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export class Exports {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly running = new Set<Promise<void>>();
  private readonly aborts = new Set<AbortController>();
  private readonly leases = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  constructor(readonly dir: string, private readonly db: TrainingDatabase, private readonly dump: Dump,
    private readonly maxBytes = 8 * 1024 ** 3, private readonly reserveBytes = 1024 ** 3,
    readonly remote?: RemoteExportBackend) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        const job: ExportJob = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (job.id !== name.slice(0, -5) || !Array.isArray(job.tables) || typeof job.owner !== 'string'
          || !Number.isFinite(job.expiresAt) || !['queued','processing','completed','failed'].includes(job.state)) continue;
        if (job.state === 'queued' || job.state === 'processing') {
          job.state = 'failed'; job.error = 'Export interrupted by a server restart. Generate it again.';
          this.remove(`${job.id}.part`); this.remove(`${job.id}.zip`); this.save(job);
        }
        this.jobs.set(job.id, job);
      } catch { /* A broken receipt must not prevent the edge from starting. */ }
    }
    this.cleanup();
    // Includes orphaned files left between rename and receipt persistence.
    for (const name of readdirSync(dir)) {
      if (/^[0-9a-f-]{36}\.(?:part|zip|json\.tmp)$/.test(name) && !this.jobs.has(name.slice(0, 36))) this.remove(name);
    }
    this.timer = setInterval(() => this.cleanup(), 3600_000).unref();
  }
  private remove(name: string): void { try { unlinkSync(join(this.dir, name)); } catch { /* retry cleanup later */ } }
  private save(job: ExportJob): void {
    const path = join(this.dir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  cleanup(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (job.expiresAt > now || ['queued','processing'].includes(job.state) || this.leases.has(id)) continue;
      this.remove(`${id}.zip`); this.remove(`${id}.part`); this.remove(`${id}.json`); this.remove(`${id}.json.tmp`);
      this.jobs.delete(id);
    }
  }
  list(owner: string, epoch: string | null): ExportJob[] {
    this.cleanup();
    return [...this.jobs.values()].filter(j => j.owner === owner && j.epoch === epoch).sort((a,b) => b.createdAt-a.createdAt);
  }
  get(id: string, owner: string, epoch: string | null): ExportJob {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || job.epoch !== epoch || job.expiresAt <= Date.now()) throw new DataError('Export not found or expired.', 404);
    return job;
  }
  start(owner: string, epoch: string | null, tables: unknown): ExportJob {
    const selected = selectedTables(tables);
    this.cleanup();
    if (this.stopped) throw new DataError('Exports are unavailable during shutdown.', 503);
    if ([...this.jobs.values()].some(j => j.state === 'queued' || j.state === 'processing')) throw new DataError('Another export is being prepared. Try again when it finishes.', 429);
    if (this.jobs.size >= 32) throw new DataError('The export queue is full. Try again after older exports expire.', 429);
    const now = Date.now();
    const job: ExportJob = { id: randomUUID(), owner, epoch, state: 'queued', tables: selected, createdAt: now,
      expiresAt: now + TTL, bytes: 0, sha256: null, error: null, ...(this.remote ? { storage: 'remote' as const } : {}) };
    this.save(job); this.jobs.set(job.id, job);
    // Return 202 before any database access, child process or compression.
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.generate(job));
    this.running.add(task); void task.finally(() => this.running.delete(task));
    return job;
  }
  lease(id: string): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.leases.get(id) ?? 1) - 1;
      if (remaining > 0) this.leases.set(id, remaining); else this.leases.delete(id);
    };
  }
  path(id: string): string { if (!ID.test(id)) throw new DataError('Export not found.', 404); return join(this.dir, `${id}.zip`); }
  private async generate(job: ExportJob): Promise<void> {
    const abort = new AbortController(); this.aborts.add(abort);
    let child: ChildProcess | undefined;
    let killer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => abort.abort(), 2 * 3600_000).unref();
    const terminate = () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); killer = setTimeout(() => child?.kill('SIGKILL'), 3000).unref(); } };
    abort.signal.addEventListener('abort', terminate);
    try {
      if (this.stopped) throw new Error('stopped');
      job.state = 'processing'; this.save(job);
      const tables = await this.db.schema();
      if (abort.signal.aborted || this.stopped) throw new Error('stopped');
      if (job.tables.some(name => !tables.some(t => t.name === name && t.kind === 'table'))) throw new DataError('A selected table is unavailable. Refresh the schema and select again.');
      if (job.storage === 'remote') {
        if (!this.remote) throw new DataError('The remote export service is not configured.', 503);
        const archive = await this.remote.generate(job.id, job.tables, this.maxBytes, this.reserveBytes, bytes => {
          job.bytes = bytes; this.save(job);
        }, abort.signal);
        if (abort.signal.aborted || this.stopped) throw new Error('stopped');
        job.bytes = archive.bytes; job.sha256 = archive.sha256; job.state = 'completed';
        job.expiresAt = Math.min(Date.now() + TTL, archive.expiresAt); this.save(job);
        return;
      }
      const space = statfsSync(this.dir);
      const available = Number(space.bavail) * Number(space.bsize) - this.reserveBytes;
      if (available < 256 * 1024 ** 2) throw new DataError('Insufficient disk space to prepare this export.');
      const limit = Math.min(available, this.maxBytes), hash = createHash('sha256');
      let savedAt = Date.now(), checkedAt = 0;
      const meter = new Transform({ transform: (chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) => {
        try {
        job.bytes += chunk.length;
        if (job.bytes > limit) return done(new DataError('Export exceeds the available disk space or configured size limit. Select fewer tables.'));
        if (job.bytes - checkedAt > 16 * 1024 ** 2) {
          const free = statfsSync(this.dir); checkedAt = job.bytes;
          if (Number(free.bavail) * Number(free.bsize) < this.reserveBytes) return done(new DataError('Disk reserve reached. Select fewer tables.'));
        }
        hash.update(chunk);
        if (Date.now() - savedAt > 5000) { savedAt = Date.now(); this.save(job); }
        done(null, chunk);
        } catch { done(new DataError('Export could not write to its private storage.')); }
      } });
      child = this.dump(job.tables);
      const processDone = new Promise<void>((resolve,reject) => {
        child?.once('error', () => reject(new DataError('pg_dump is unavailable. Ask an administrator to check the export service.')));
        child?.once('close', code => code === 0 ? resolve() : reject(new DataError('Database export failed. Check the private tunnel and matching pg_dump version.')));
      });
      if (!child.stdout) throw new Error('missing stdout');
      const zip = new ZipFile();
      zip.on('error', error => { (zip.outputStream as Readable).destroy(error); });
      zip.addBuffer(Buffer.from(JSON.stringify({ format: 'PostgreSQL plain SQL', tables: job.tables, createdAt: new Date(job.createdAt).toISOString(),
        note: 'Selected tables only. Foreign-key dependencies outside the selection are not included. Restore into a separate database with matching schema dependencies.' }, null, 2)), 'manifest.json');
      const stdout = child.stdout;
      const sql = Readable.from((async function* () {
        yield Buffer.from('CREATE SCHEMA IF NOT EXISTS training;\n');
        for await (const chunk of stdout) yield chunk;
      })());
      zip.addReadStream(sql, 'dataset.sql', { compressionLevel: 6, forceZip64Format: true });
      zip.end({ forceZip64Format: true, comment: '' });
      const packed = pipeline(zip.outputStream as Readable, meter, createWriteStream(join(this.dir, `${job.id}.part`), { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
      // Either failure cancels its counterpart; never publish a valid ZIP
      // containing a truncated SQL dump from an unsuccessful pg_dump.
      void processDone.catch(() => abort.abort()); void packed.catch(() => abort.abort());
      const result = await Promise.allSettled([processDone, packed]);
      const failed = result.find(r => r.status === 'rejected' && r.reason instanceof DataError && !String(r.reason.message).startsWith('Database export failed'))
        ?? result.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (abort.signal.aborted || this.stopped) throw new Error('stopped');
      renameSync(join(this.dir, `${job.id}.part`), this.path(job.id));
      job.sha256 = hash.digest('hex'); job.state = 'completed'; job.expiresAt = Date.now() + TTL; this.save(job);
    } catch (error) {
      abort.abort(); this.remove(`${job.id}.part`); this.remove(`${job.id}.zip`);
      job.state = 'failed'; job.error = error instanceof DataError ? error.message : 'Export interrupted. Generate it again.';
      try { this.save(job); } catch { /* In-memory failure still informs the caller when disk is full. */ }
    } finally {
      clearTimeout(timeout); if (killer && (child?.exitCode !== null || child?.signalCode !== null)) clearTimeout(killer);
      this.aborts.delete(abort);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer);
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled(this.running);
  }
}
