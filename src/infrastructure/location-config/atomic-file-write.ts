import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncDirectory, syncFileDescriptor } from '../../shared/directory-sync.js';

export type FileDurability = 'confirmed' | 'unconfirmed';

export interface AtomicFileCommitOutcome {
  durability: FileDurability;
  sha256: string;
}

/** Narrow I/O seam for deterministic failures at the file commit boundary. */
export interface AtomicFileOperations {
  rename?: typeof renameSync;
  syncFile?: typeof syncFileDescriptor;
  syncDirectory?: typeof syncDirectory;
}

/**
 * Writes a same-directory candidate and atomically replaces the target. Rename
 * is the logical commit point; a later directory-sync error is returned as an
 * applied but durability-unconfirmed result.
 */
export function atomicReplaceFile(
  path: string,
  bytes: Buffer | string,
  mode: number,
  temporaryPrefix: string,
  operations: AtomicFileOperations = {},
): AtomicFileCommitOutcome {
  const directory = dirname(path);
  const temporary = join(directory, `${temporaryPrefix}.${process.pid}.${randomUUID()}.tmp`);
  const content = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  try {
    writeFileSync(temporary, content, { mode, flag: 'wx' });
    const descriptor = openSync(temporary, 'r+');
    try { (operations.syncFile ?? syncFileDescriptor)(descriptor); }
    finally { closeSync(descriptor); }
    (operations.rename ?? renameSync)(temporary, path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve the original pre-commit failure */ }
    throw error;
  }

  try { (operations.syncDirectory ?? syncDirectory)(directory); }
  catch { return { durability: 'unconfirmed', sha256: digest(content) }; }
  return { durability: 'confirmed', sha256: digest(content) };
}

/** Reconciles a candidate and makes its current bytes and directory durable. */
export function verifyAndSyncFile(
  path: string,
  expectedSha256: string,
  validate: (bytes: Buffer) => void,
  operations: AtomicFileOperations = {},
): void {
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedSha256) throw new Error('Committed file digest does not match the expected revision.');
  validate(bytes);
  const descriptor = openSync(path, 'r+');
  try { (operations.syncFile ?? syncFileDescriptor)(descriptor); }
  finally { closeSync(descriptor); }
  (operations.syncDirectory ?? syncDirectory)(dirname(path));
}

export function fileSha256(bytes: Buffer | string): string {
  return digest(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
