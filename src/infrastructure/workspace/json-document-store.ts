import { readFileSync, statSync } from 'node:fs';
import { writePrivateJson } from '../../shared/private-file.js';
import { WorkspaceError } from '../../modules/workspace/domain/workspace.js';
import type { DocumentStore } from '../../modules/workspace/repositories/document-store.js';

/** A mailbox of a thousand full-length messages is about 5 MB; anything far past that was not written here. */
const MAX_BYTES = 16_000_000;

const unavailable = (): never => { throw new WorkspaceError('STORAGE_UNAVAILABLE', 503, 'Team storage is unavailable.'); };

/**
 * A private JSON file, replaced atomically on every change.
 *
 * There is no lock file, unlike the account store: only the edge process
 * writes here, and a read-modify-write that never awaits cannot interleave
 * with itself. A lock would only add a way to be stuck -- one left behind by
 * a crash closes account changes on purpose, but it has no business stopping
 * people from writing to each other.
 */
export class JsonDocumentStore<T> implements DocumentStore<T> {
  private cached: T | null = null;
  private seen = '';

  constructor(private readonly path: string, private readonly empty: () => T, private readonly parse: (value: unknown) => T) {}

  private stamp(): string | null {
    try {
      const stat = statSync(this.path, { bigint: true });
      if (stat.size > BigInt(MAX_BYTES)) return unavailable();
      return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return unavailable();
    }
  }

  read(): T {
    const stamp = this.stamp();
    // No file yet is an empty store, not a broken one.
    if (stamp === null) { this.seen = ''; this.cached = null; return this.empty(); }
    if (this.cached !== null && stamp === this.seen) return this.cached;
    let document: T;
    try { document = this.parse(JSON.parse(readFileSync(this.path, 'utf8'))); }
    // A half-written or hand-edited file is refused, and so never replaced:
    // update() reads first, and what it would overwrite is somebody's mail.
    catch { return unavailable(); }
    this.cached = document; this.seen = stamp;
    return document;
  }

  update<R>(change: (draft: T) => R): R {
    const draft = structuredClone(this.read());
    const result = change(draft);
    try { writePrivateJson(this.path, draft); } catch { return unavailable(); }
    this.cached = draft;
    try { this.seen = this.stamp() ?? ''; } catch { this.seen = ''; }
    return result;
  }
}
