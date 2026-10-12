import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { DataError } from './database.js';
import { selectedTables } from './exports.js';

export interface RemoteArchive { bytes: number; sha256: string; expiresAt: number }
export interface RemoteExportBackend {
  generate(id: string, tables: string[], maxBytes: number, reserveBytes: number,
    progress: (bytes: number) => void, signal: AbortSignal): Promise<RemoteArchive>;
  download(id: string, start: number, length: number): { stream: Readable; cancel(): void };
}
interface SshOptions { host: string; port: number; key: string; knownHosts: string; command?: string }
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const unavailable = () => new DataError('The Proxmox export service is unavailable. Try again or ask an administrator to check its private connection.', 503);
const failures: Record<string, string> = {
  disk_full: 'The export server needs more free disk space. Ask an administrator to increase export storage and retry.',
  too_large: 'The compressed ZIP exceeds the configured export limit. Select fewer tables or ask an administrator to raise the limit.',
  busy: 'Another export is being prepared on the export server. Try again when it finishes.',
  database: 'Database export failed. Check the private database tunnel and matching pg_dump version.',
  interrupted: 'Export interrupted. Generate it again.',
};
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  child.once('close', () => clearTimeout(force));
}
function completed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(unavailable()));
    child.once('close', code => code === 0 ? resolve() : reject(unavailable()));
  });
}

/** The SSH command can only generate or stream private archives; it offers no shell. */
export class SshRemoteExports implements RemoteExportBackend {
  constructor(private readonly options: SshOptions) {
    if (!/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(options.host)
      || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid ML export SSH destination');
    for (const path of [options.key, options.knownHosts]) {
      if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error('ML export SSH files must be absolute regular files');
    }
    if (statSync(options.key).mode & 0o077) throw new Error('ML export SSH key must be private (0600)');
  }
  private run(args: string[]): ChildProcess {
    if (!ID.test(args[1] ?? '')) throw new DataError('Invalid export ID.');
    const o = this.options;
    return spawn(o.command ?? 'ssh', ['-F', '/dev/null', '-T', '-p', String(o.port),
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'UserKnownHostsFile=' + o.knownHosts, '-i', o.key, o.host, args.join(' ')], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
  async generate(id: string, tables: string[], maxBytes: number, reserveBytes: number,
    progress: (bytes: number) => void, signal: AbortSignal): Promise<RemoteArchive> {
    selectedTables(tables);
    if (signal.aborted) throw new DataError(failures.interrupted ?? 'Export interrupted.');
    const child = this.run(['generate', id, Buffer.from(JSON.stringify(tables)).toString('base64'), String(maxBytes), String(reserveBytes)]);
    const exit = completed(child); void exit.catch(() => undefined);
    const cancel = () => terminate(child); signal.addEventListener('abort', cancel, { once: true });
    let buffer = '', archive: RemoteArchive | undefined, lastBytes = 0;
    try {
      if (!child.stdout) throw unavailable();
      for await (const chunk of child.stdout) {
        buffer += (chunk as Buffer).toString('utf8');
        if (buffer.length > 16_384) throw unavailable();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || !('state' in value) || archive) throw unavailable();
          if (value.state === 'failed') {
            const code = 'error' in value && typeof value.error === 'string' ? value.error : '';
            throw new DataError(failures[code] ?? 'The remote export failed. Try again or ask an administrator to check the export service.');
          }
          if (!('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
            || value.bytes < lastBytes || value.bytes > maxBytes) throw unavailable();
          lastBytes = value.bytes; progress(lastBytes);
          if (value.state === 'completed' && 'sha256' in value && typeof value.sha256 === 'string'
            && /^[0-9a-f]{64}$/.test(value.sha256) && lastBytes > 0 && 'expiresAt' in value
            && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0) {
            archive = { bytes: lastBytes, sha256: value.sha256, expiresAt: value.expiresAt };
          } else if (value.state !== 'processing') throw unavailable();
        }
      }
      await exit;
      if (buffer || !archive || signal.aborted) throw unavailable();
      return archive;
    } catch (error) {
      cancel(); await exit.catch(() => undefined);
      if (signal.aborted) throw new DataError(failures.interrupted ?? 'Export interrupted.');
      throw error instanceof DataError ? error : unavailable();
    } finally { signal.removeEventListener('abort', cancel); }
  }
  download(id: string, start: number, length: number): { stream: Readable; cancel(): void } {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1) throw new DataError('Invalid download range.', 416);
    const child = this.run(['download', id, String(start), String(length)]);
    const exit = completed(child); void exit.catch(() => undefined);
    const cancel = () => terminate(child);
    const source = child.stdout;
    if (!source) { cancel(); throw unavailable(); }
    let bytes = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
        bytes += chunk.length;
        done(bytes > length ? unavailable() : null, chunk);
      },
      flush(done: TransformCallback) {
        void exit.then(() => done(bytes === length ? null : unavailable()), () => done(unavailable()));
      },
    });
    source.once('error', error => stream.destroy(error));
    stream.once('close', cancel);
    source.pipe(stream);
    return { stream, cancel };
  }
}

export function remoteExports(env: NodeJS.ProcessEnv): SshRemoteExports | null {
  const names = ['ML_EXPORT_SSH_HOST', 'ML_EXPORT_SSH_KEY', 'ML_EXPORT_SSH_KNOWN_HOSTS'] as const;
  if (!names.some(name => env[name]) && !env.ML_EXPORT_SSH_PORT) return null;
  if (!names.every(name => env[name])) throw new Error('ML export SSH host, key and known_hosts must be configured together');
  const port = env.ML_EXPORT_SSH_PORT ?? '2223';
  if (!/^\d+$/.test(port)) throw new Error('ML_EXPORT_SSH_PORT must be a TCP port');
  return new SshRemoteExports({ host: env.ML_EXPORT_SSH_HOST ?? '', port: Number(port),
    key: env.ML_EXPORT_SSH_KEY ?? '', knownHosts: env.ML_EXPORT_SSH_KNOWN_HOSTS ?? '' });
}
