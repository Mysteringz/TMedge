import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { syncDirectory, syncFileDescriptor } from './directory-sync.js';

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
  try { writeFileSync(fd, JSON.stringify(value)); syncFileDescriptor(fd); }
  catch (err) { closeSync(fd); try { unlinkSync(temp); } catch { /* absent */ } throw err; }
  closeSync(fd);
  try {
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } catch (err) { try { unlinkSync(temp); } catch { /* already renamed */ } throw err; }
}
