import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { ApplicationError } from '../modules/shared/application/contracts.js';

export interface FlasherCredential {
  id: string; label: string; createdAt: number; expiresAt: number; by: string;
}
interface StoredCredential extends FlasherCredential { digest: string; binding?: string }

/** Native credentials are returned once. Only digests survive a restart. */
export class AdoptionCredentials {
  private accountSubject: (name: string) => string | null = () => null;
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  bindAccounts(subject: (name: string) => string | null): void { this.accountSubject = subject; }
  issueForAccount(label: unknown, hours: unknown, user: string): FlasherCredential & { token: string } {
    const binding = this.accountSubject(user);
    if (!binding) throw new ApplicationError('validation', 'sign in with an active algo account first');
    return this.issue(label, hours, `algo:${user}`, binding);
  }

  list(): FlasherCredential[] {
    return this.read().filter(item => this.active(item)).map(({ digest: _digest, binding: _binding, ...item }) => item);
  }

  authorize(token: string | null): boolean {
    if (!token || !/^tmflash_[0-9a-f]{64}$/.test(token)) return false;
    const digest = createHash('sha256').update(token).digest();
    try {
      return this.read().some(item => this.active(item) && timingSafeEqual(Buffer.from(item.digest, 'hex'), digest));
    } catch { return false; } // A broken credential file must fail closed.
  }

  issue(label: unknown, hours: unknown, by: string, binding?: string): FlasherCredential & { token: string } {
    if (typeof label !== 'string' || !/^[\w .()-]{1,60}$/.test(label.trim()) || typeof hours !== 'number' || ![1, 24, 168].includes(hours)) {
      throw new ApplicationError('validation', 'give the flasher a label and choose 1 hour, 24 hours or 7 days');
    }
    const entries = this.read().filter(item => this.active(item));
    if (entries.length >= 32) throw new ApplicationError('conflict', 'revoke an old flasher token before creating another');
    const token = `tmflash_${randomBytes(32).toString('hex')}`;
    const item: FlasherCredential = { id: randomUUID(), label: label.trim(), createdAt: this.now(), expiresAt: this.now() + Number(hours) * 3600_000, by };
    this.write([...entries, { ...item, digest: createHash('sha256').update(token).digest('hex'), ...(binding ? { binding } : {}) }]);
    this.audit({ action: 'issue', ...item });
    return { ...item, token };
  }

  signOut(token: string | null): void {
    if (!token || !/^tmflash_[0-9a-f]{64}$/.test(token)) return;
    const digest = createHash('sha256').update(token).digest('hex');
    const item = this.read().find(entry => entry.digest === digest);
    if (item) this.revoke(item.id, item.by);
  }

  revoke(id: string, by = 'console'): void {
    const entries = this.read();
    if (!entries.some(item => item.id === id)) throw new ApplicationError('not-found', 'no such flasher token');
    this.write(entries.filter(item => item.id !== id));
    this.audit({ action: 'revoke', id, by, at: this.now() });
  }

  private read(): StoredCredential[] {
    try {
      if (!existsSync(this.path)) return [];
      const file = statSync(this.path);
      if (!file.isFile() || file.size > 64 * 1024 || (file.mode & 0o077)) throw new Error('unsafe credential file');
      const root = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: unknown; tokens?: unknown };
      if (root.version !== 1 || Object.keys(root).some(key => !['version', 'tokens'].includes(key)) || !Array.isArray(root.tokens) || root.tokens.length > 32) throw new Error('invalid credential file');
      const entries: StoredCredential[] = [];
      for (const value of root.tokens as unknown[]) {
        if (!value || typeof value !== 'object') throw new Error('invalid credential');
        const item = value as Partial<StoredCredential>;
        if (Object.keys(item).some(key => !['id', 'label', 'createdAt', 'expiresAt', 'by', 'digest', 'binding'].includes(key)) ||
            (item.binding !== undefined && (typeof item.binding !== 'string' || item.binding.length > 100 || !item.by?.startsWith('algo:')))) throw new Error('invalid credential field');
        if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.label !== 'string' || item.label.length > 60 ||
            typeof item.by !== 'string' || item.by.length > 100 || typeof item.createdAt !== 'number' || !Number.isSafeInteger(item.createdAt) ||
            typeof item.expiresAt !== 'number' || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= item.createdAt ||
            typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/.test(item.digest)) throw new Error('invalid credential');
        entries.push(item as StoredCredential);
      }
      return entries;
    } catch { throw new ApplicationError('unavailable', 'flasher credential storage is unavailable'); }
  }

  private active(item: StoredCredential): boolean {
    return item.expiresAt > this.now() && (!item.binding || this.accountSubject(item.by.slice(5)) === item.binding);
  }

  private audit(event: Record<string, unknown>): void {
    // A disk error must not undo revocation. This log never contains the
    // token or its digest; the authoritative credential file is separate.
    try { appendFileSync(this.path + '.audit.jsonl', JSON.stringify(event) + '\n', { mode: 0o600 }); } catch { /* credential state remains authoritative */ }
  }

  private write(tokens: StoredCredential[]): void {
    try {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, tokens }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch { throw new ApplicationError('unavailable', 'flasher credential storage is unavailable'); }
  }
}
