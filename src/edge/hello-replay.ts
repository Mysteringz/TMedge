import { readFileSync, statSync } from 'node:fs';
import { withPrivateFileLock, writePrivateJson } from '../shared/private-file.js';

/** Persist the short HELLO window before establishing a gateway session. */
export class HelloReplayStore {
  constructor(private readonly path: string) { this.read(); }
  private read(): { highWater: number; nonces: [string, number][] } {
    try {
      if (statSync(this.path).size > 2 * 1024 * 1024) throw new Error('HELLO journal too large');
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as { version: number; highWater: number; nonces: [string, number][] };
      if (v.version !== 1 || !Number.isSafeInteger(v.highWater) || v.highWater < 0 || !Array.isArray(v.nonces) || v.nonces.length > 4096 ||
        v.nonces.some(e => !Array.isArray(e) || e.length !== 2 || !/^[A-Za-z0-9._-]{1,64}\|[A-Za-z0-9._-]{1,128}$/.test(e[0]) || !Number.isSafeInteger(e[1]) || e[1] < 0) ||
        new Set(v.nonces.map(e => e[0])).size !== v.nonces.length) throw new Error('invalid HELLO journal');
      return v;
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
