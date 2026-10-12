import { closeSync, fsyncSync, openSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Flushes a regular file and deliberately propagates every failure. */
export function syncFileDescriptor(descriptor: number): void {
  fsyncSync(descriptor);
}

/** Async counterpart for large immutable files written without blocking the event loop. */
export async function syncFileHandle(handle: Pick<FileHandle, 'sync'>): Promise<void> {
  await handle.sync();
}

/** Persist directory entry updates where the platform supports directory handles. */
export function syncDirectory(path: string): void {
  // Windows does not support flushing directory handles through Node's fsync.
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try { syncFileDescriptor(descriptor); } finally { closeSync(descriptor); }
}
