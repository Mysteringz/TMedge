import { readFileSync, statSync } from 'node:fs';
import { withPrivateFileLock, writePrivateJson } from '../shared/private-file.js';

export interface HelloReplayPersistence {
  accept(id: string, nonce: string, expires: number, now: number): boolean | Promise<boolean>;
}

export interface HelloReplaySnapshot {
  highWater: number;
  nonces: Array<[string, number]>;
}

/** Strict, read-only view used by the controlled PostgreSQL cutover import. */
export function readHelloReplaySnapshot(path: string): HelloReplaySnapshot {
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('HELLO journal too large');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<HelloReplaySnapshot> & { version?: unknown };
  if (value.version !== 1 || !Number.isSafeInteger(value.highWater) || (value.highWater ?? -1) < 0 ||
    !Array.isArray(value.nonces) || value.nonces.length > 4096 ||
    value.nonces.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
      !/^[A-Za-z0-9._-]{1,64}\|[A-Za-z0-9._-]{1,128}$/.test(entry[0]) ||
      !Number.isSafeInteger(entry[1]) || entry[1] < 0) ||
    new Set(value.nonces.map(entry => entry[0])).size !== value.nonces.length) {
    throw new Error('invalid HELLO journal');
  }
  return { highWater: value.highWater as number, nonces: value.nonces };
}

/** Persist the short HELLO window before establishing a gateway session. */
export class HelloReplayStore implements HelloReplayPersistence {
  constructor(private readonly path: string) { this.read(); }
  private read(): HelloReplaySnapshot {
    try {
      return readHelloReplaySnapshot(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { highWater: 0, nonces: [] };
      throw err;
    }
  }
  accept(id: string, nonce: string, expires: number, now: number): boolean {
    return withPrivateFileLock(this.path, () => {
      const v = this.read();
      if (now < v.highWater) return false; // clock rollback cannot revive expired proofs
      const entries = new Map(v.nonces.filter(([, expiry]) => expiry >= now)), key = `${id}|${nonce}`;
      if (entries.has(key) || entries.size >= 4096) return false;
      entries.set(key, expires);
      writePrivateJson(this.path, { version: 1, highWater: now, nonces: [...entries] });
      return true;
    });
  }
}
