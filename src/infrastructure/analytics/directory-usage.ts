/**
 * What is taking the room on the data volume, by top-level directory.
 *
 * A walk, not `du`: nothing is spawned, and it gives way to the event loop
 * every few hundred files so sensor packets are still answered on time while
 * a toolchain directory of a hundred thousand files is being counted. It is
 * bounded twice -- by entries and by time -- and says so when it stopped
 * early, so a partial total is never passed off as the whole.
 */
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

export interface DirectoryUsage {
  scannedAt: number;
  durationMs: number;
  /** True when a limit was reached: every figure is then a lower bound. */
  truncated: boolean;
  entries: { name: string; bytes: number; files: number }[];
}

export interface DirectoryUsageLimits { maxEntries: number; maxMs: number; yieldEvery: number }

export const DEFAULT_USAGE_LIMITS: DirectoryUsageLimits = { maxEntries: 400_000, maxMs: 45_000, yieldEvery: 200 };

export async function scanDirectoryUsage(root: string, limits: DirectoryUsageLimits = DEFAULT_USAGE_LIMITS, now: () => number = Date.now): Promise<DirectoryUsage> {
  const started = now();
  let seen = 0, truncated = false;
  const exhausted = () => {
    if (seen >= limits.maxEntries || now() - started > limits.maxMs) truncated = true;
    return truncated;
  };

  /** Allocated size where the file system reports it: a sparse or compressed file is what it occupies. */
  const sizeOf = async (path: string): Promise<{ bytes: number; directory: boolean } | null> => {
    try {
      const s = await lstat(path);
      // Links are not followed or counted: what they point at is somewhere else's data.
      if (s.isSymbolicLink()) return null;
      return { bytes: s.blocks > 0 ? s.blocks * 512 : s.size, directory: s.isDirectory() };
    } catch { return null; }
  };

  const walk = async (dir: string, total: { bytes: number; files: number }): Promise<void> => {
    let handle;
    try { handle = await opendir(dir); } catch { return; }
    for await (const entry of handle) {
      if (exhausted()) break;
      seen += 1;
      if (seen % limits.yieldEvery === 0) await yieldToLoop();
      const path = join(dir, entry.name);
      const info = await sizeOf(path);
      if (!info) continue;
      total.bytes += info.bytes;
      if (info.directory) await walk(path, total);
      else total.files += 1;
    }
  };

  const entries: DirectoryUsage['entries'] = [];
  let top;
  try { top = await opendir(root); } catch { return { scannedAt: started, durationMs: 0, truncated: false, entries: [] }; }
  const looseFiles = { name: '(files)', bytes: 0, files: 0 };
  for await (const entry of top) {
    if (exhausted()) break;
    const path = join(root, entry.name);
    const info = await sizeOf(path);
    if (!info) continue;
    if (!info.directory) { looseFiles.bytes += info.bytes; looseFiles.files += 1; continue; }
    const total = { bytes: info.bytes, files: 0 };
    await walk(path, total);
    entries.push({ name: entry.name, ...total });
  }
  if (looseFiles.files > 0) entries.push(looseFiles);
  entries.sort((a, b) => b.bytes - a.bytes);
  return { scannedAt: started, durationMs: now() - started, truncated, entries };
}

/** Runs at most one scan at a time and hands back the last finished one meanwhile. */
export class DirectoryUsageCache {
  private latest: DirectoryUsage | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly root: string, private readonly maxAgeMs = 15 * 60_000, private readonly limits = DEFAULT_USAGE_LIMITS) {}

  /** Never waits for a scan: returns what is known and starts a refresh if it is stale. */
  read(now: number = Date.now()): DirectoryUsage | null {
    if (!this.running && (!this.latest || now - this.latest.scannedAt > this.maxAgeMs)) {
      this.running = scanDirectoryUsage(this.root, this.limits)
        .then((result) => { this.latest = result; }, () => undefined)
        .finally(() => { this.running = null; });
    }
    return this.latest;
  }

  /** For tests and shutdown: resolves when no scan is in flight. */
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
}
