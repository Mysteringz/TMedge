/**
 * Download keys: a machine fetches its owner's ML-data exports without a browser.
 *
 * The thermal detector is labelled and trained on the InnoWing cluster
 * (module 02's iw-g2). Its jobs can reach this edge but cannot sign in: the
 * console's login is a browser form behind a human check, and a copied
 * session cookie would hand a shared cluster account everything the person
 * can do. A download key lets a job list and download the exports its owner
 * made -- nothing else. It cannot query the database, start an export, read
 * anybody else's, or reach any other part of the console.
 *
 * Kept like TMflash's credentials (src/edge/adoption-credentials.ts): the key
 * is shown once and only its SHA-256 digest is stored (0600); it lasts 1 hour,
 * 24 hours or 7 days; it stops working the moment its owner's password
 * changes or the account is disabled or recreated; issue and revoke are
 * audited, never with the key or its digest. At most 8 per account.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataError } from './database.js';

export const KEY_HOURS = [1, 24, 168] as const;
const KEY = /^tmdata_[0-9a-f]{64}$/;
const PER_OWNER = 8;
const TOTAL = 64;

export interface DownloadKey { id: string; label: string; owner: string; createdAt: number; expiresAt: number }
interface StoredKey extends DownloadKey { digest: string; binding: string; epoch: string }

export class DownloadKeys {
  constructor(
    private readonly path: string,
    /** Changes when the account's password changes; null once it is disabled or gone. */
    private readonly subjectOf: (name: string) => string | null,
    /** Changes when an account of the same name is recreated. */
    private readonly epochOf: (name: string) => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  issue(owner: string, label: unknown, hours: unknown): DownloadKey & { key: string } {
    const binding = this.subjectOf(owner), epoch = this.epochOf(owner);
    if (!binding || !epoch) throw new DataError('Sign in with an active account to create a download key.', 401);
    if (typeof label !== 'string' || !/^[\w .()-]{1,60}$/.test(label.trim()) || typeof hours !== 'number' || !(KEY_HOURS as readonly number[]).includes(hours)) {
      throw new DataError('Give the key a label and choose 1 hour, 24 hours or 7 days.', 400);
    }
    const entries = this.read().filter(item => this.active(item));
    if (entries.filter(item => item.owner === owner).length >= PER_OWNER || entries.length >= TOTAL) {
      throw new DataError('Revoke an old download key before creating another.', 409);
    }
    const key = `tmdata_${randomBytes(32).toString('hex')}`;
    const item: DownloadKey = { id: randomUUID(), label: label.trim(), owner, createdAt: this.now(), expiresAt: this.now() + hours * 3600_000 };
    this.write([...entries, { ...item, digest: createHash('sha256').update(key).digest('hex'), binding, epoch }]);
    this.audit({ action: 'issue', ...item });
    return { ...item, key };
  }

  list(owner: string): DownloadKey[] {
    return this.read().filter(item => item.owner === owner && this.active(item))
      .map(({ id, label, owner: o, createdAt, expiresAt }) => ({ id, label, owner: o, createdAt, expiresAt }));
  }

  revoke(owner: string, id: string): void {
    const entries = this.read();
    if (!entries.some(item => item.id === id && item.owner === owner)) throw new DataError('No such download key.', 404);
    this.write(entries.filter(item => item.id !== id));
    this.audit({ action: 'revoke', id, owner, at: this.now() });
  }

  /** The owner and account epoch a key acts for, or null. Fails closed on any doubt. */
  authorize(key: string | null | undefined): { id: string; owner: string; epoch: string } | null {
    if (!key || !KEY.test(key)) return null;
    const digest = createHash('sha256').update(key).digest();
    try {
      const item = this.read().find(entry => timingSafeEqual(Buffer.from(entry.digest, 'hex'), digest));
      return item && this.active(item) ? { id: item.id, owner: item.owner, epoch: item.epoch } : null;
    } catch { return null; }
  }

  private active(item: StoredKey): boolean {
    return item.expiresAt > this.now() && this.subjectOf(item.owner) === item.binding && this.epochOf(item.owner) === item.epoch;
  }

  private read(): StoredKey[] {
    try {
      if (!existsSync(this.path)) return [];
      const file = statSync(this.path);
      if (!file.isFile() || file.size > 256 * 1024 || (file.mode & 0o077)) throw new Error('unsafe key file');
      const root = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: unknown; keys?: unknown };
      if (root.version !== 1 || Object.keys(root).some(k => !['version', 'keys'].includes(k)) || !Array.isArray(root.keys) || root.keys.length > TOTAL) throw new Error('invalid key file');
      return (root.keys as unknown[]).map((value) => {
        const item = value as Partial<StoredKey>;
        if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['id', 'label', 'owner', 'createdAt', 'expiresAt', 'digest', 'binding', 'epoch'].includes(k)) ||
            typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.label !== 'string' || item.label.length > 60 ||
            typeof item.owner !== 'string' || item.owner.length > 100 || typeof item.binding !== 'string' || item.binding.length > 200 ||
            typeof item.epoch !== 'string' || item.epoch.length > 200 || typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/.test(item.digest) ||
            typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt) || typeof item.expiresAt !== 'number' ||
            !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= item.createdAt) throw new Error('invalid key');
        return item as StoredKey;
      });
    } catch { throw new DataError('Download key storage is unavailable.', 503); }
  }

  private audit(event: Record<string, unknown>): void {
    // Never the key or its digest. A disk error here must not undo a revocation.
    try { appendFileSync(this.path + '.audit.jsonl', JSON.stringify(event) + '\n', { mode: 0o600 }); } catch { /* the key file stays authoritative */ }
  }

  private write(keys: StoredKey[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, keys }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch { throw new DataError('Download key storage is unavailable.', 503); }
  }
}
