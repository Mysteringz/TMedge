import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class FileBusyError extends Error {}
/** Short exclusive commit section shared by service and CLI writers. */
export function withPrivateFileLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new FileBusyError('Account storage is busy. Try again shortly.');
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    return work();
  } finally { try { closeSync(fd); } finally { unlinkSync(lock); } }
  // A crash leaves the lock in place and subsequent writes fail closed.
  // An operator may remove it only after confirming no writer is active.
}
/** Durable atomic replacement; never exposes a partially written JSON file. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  catch (err) { closeSync(fd); try { unlinkSync(temp); } catch { /* absent */ } throw err; }
  closeSync(fd);
  try {
    renameSync(temp, path);
    // Windows cannot fsync directory handles; the file itself was already flushed before renaming.
    if (process.platform === 'win32') return;
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (err) { try { unlinkSync(temp); } catch { /* already renamed */ } throw err; }
}
