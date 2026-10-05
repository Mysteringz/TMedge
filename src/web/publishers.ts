import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { OccupancySnapshot } from '../shared/types.js';

/** A bearer credential authorizes exactly one edge and an explicit floor set. */
export class SnapshotPublishers {
  private readonly entries = new Map<string, { token: Buffer; floors: Set<string>; revoked: boolean }>();
  constructor(value: unknown) {
    const root = value as { version?: number; edges?: Record<string, { token: string; floors: string[]; revoked?: boolean }> };
    if (!root || root.version !== 1 || !root.edges || typeof root.edges !== 'object' || Array.isArray(root.edges) || Object.keys(root).some(k => !['version', 'edges'].includes(k)) || Object.keys(root.edges).length > 5000) throw new Error('invalid snapshot publisher schema');
    const secrets = new Set<string>(), owners = new Set<string>();
    for (const [id, v] of Object.entries(root.edges)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['token', 'floors', 'revoked'].includes(k)) || typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token) || /^0+$/.test(v.token) || secrets.has(v.token) || !Array.isArray(v.floors) || v.floors.length > 100 || v.floors.some(f => typeof f !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(f)) || new Set(v.floors).size !== v.floors.length || (v.revoked !== undefined && typeof v.revoked !== 'boolean')) throw new Error('invalid snapshot publisher identity or credential');
      for (const floor of v.floors) { if (owners.has(floor)) throw new Error('snapshot floor must have one authorized publisher'); owners.add(floor); }
      secrets.add(v.token); this.entries.set(id, { token: Buffer.from(v.token), floors: new Set(v.floors), revoked: v.revoked === true });
    }
  }
  static fromFile(path: string): SnapshotPublishers {
    const s = statSync(path);
    if (!s.isFile() || s.size > 2 * 1024 * 1024 || (s.mode & 0o077)) throw new Error('snapshot publisher file must be a bounded mode-0600 file');
    return new SnapshotPublishers(JSON.parse(readFileSync(path, 'utf8')));
  }
  authenticate(edgeId: unknown, token: Buffer): boolean {
    const e = typeof edgeId === 'string' ? this.entries.get(edgeId) : undefined;
    return !!e && !e.revoked && token.length === e.token.length && timingSafeEqual(token, e.token);
  }
  authorizes(snapshot: OccupancySnapshot): boolean {
    const e = this.entries.get(snapshot.edgeId);
    return !!e && !e.revoked && snapshot.floors.every(f => e.floors.has(f.id));
  }
}
