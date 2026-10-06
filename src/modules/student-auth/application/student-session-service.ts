import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { withPrivateFileLock, writePrivateJson } from '../../../shared/private-file.js';
import type { User } from '../domain/user.js';

export function studentSessionVersion(user: User): string {
  return createHash('sha256').update(JSON.stringify([user.id ?? '', user.email, user.salt, user.hash, user.google ?? '', user.createdAt])).digest('hex');
}

/** Indicates a student account input or credential rule failure. */
export class AuthError extends Error {}
export type HumanCheck = (token: string, action: string, ip: string | undefined) => Promise<boolean>;

/** Issues and validates the stateless signed cookie used by student sessions. */
export class Sessions {
  private readonly revoked = new Map<string, number>();
  private validAfter = -Infinity;
  private stamp = '';
  constructor(private readonly secret: Buffer, private readonly ttlMs = 14 * 24 * 3600 * 1000, private readonly revocationsPath?: string) {}

  issue(email: string, now = Date.now(), accountVersion?: string): string {
    const body = Buffer.from(JSON.stringify({ e: email, x: now + this.ttlMs, n: randomBytes(16).toString('base64url'), ...(accountVersion ? { v: accountVersion } : {}) })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  get ttl(): number {
    return this.ttlMs;
  }

  read(token: string | undefined, now = Date.now()): string | null {
    return this.detail(token, now)?.email ?? null;
  }

  detail(token: string | undefined, now = Date.now()): { email: string; expiresAt: number; version?: string } | null {
    if (!token || token.length > 2048) return null;
    try { this.reloadRevocations(now); } catch { return null; }
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, mac] = parts;
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || this.revoked.has(this.mac(token))) return null;
    try {
      const { e, x, v } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number; v?: string };
      if (typeof e !== 'string' || typeof x !== 'number' || !Number.isFinite(x) || x <= now || x > now + this.ttlMs ||
          x - this.ttlMs <= this.validAfter || this.revoked.has(this.mac(token))) return null;
      return { email: e, expiresAt: x, ...(typeof v === 'string' ? { version: v } : {}) };
    } catch {
      return null;
    }
  }

  revoke(token: string | undefined, now = Date.now()): void {
    if (!token || !this.detail(token, now)) return;
    const commit = () => {
      if (this.stamp) this.stamp = '';
      this.reloadRevocations(now);
      for (const [key, expiry] of this.revoked) if (expiry <= now) this.revoked.delete(key);
      if (this.revoked.size >= 10_000) { this.validAfter = now; this.revoked.clear(); }
      const detail = this.detailWithoutReload(token, now);
      if (detail) this.revoked.set(this.mac(token), detail.expiresAt);
      this.saveRevocations();
    };
    if (this.revocationsPath) withPrivateFileLock(this.revocationsPath, commit); else commit();
  }

  private reloadRevocations(now: number): void {
    if (!this.revocationsPath) return;
    let stamp: string;
    try {
      const s = statSync(this.revocationsPath, { bigint: true });
      if (s.size > 2_000_000n) throw new Error('session revocation file too large');
      stamp = `${s.ino}:${s.mtimeNs}:${s.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.stamp) return;
      throw error;
    }
    if (stamp === this.stamp) return;
    const value = JSON.parse(readFileSync(this.revocationsPath, 'utf8')) as { validAfter?: unknown; revoked?: unknown };
    if (!value || !Array.isArray(value.revoked) || value.revoked.length > 10_000) throw new Error('invalid session revocation file');
    this.revoked.clear();
    for (const entry of value.revoked) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') throw new Error('invalid session revocation entry');
      if (entry[1] > now) this.revoked.set(entry[0], entry[1]);
    }
    this.validAfter = typeof value.validAfter === 'number' ? value.validAfter : -Infinity;
    this.stamp = stamp;
  }

  private saveRevocations(): void {
    if (!this.revocationsPath) return;
    writePrivateJson(this.revocationsPath, { validAfter: Number.isFinite(this.validAfter) ? this.validAfter : null, revoked: [...this.revoked] });
    this.stamp = '';
  }

  private detailWithoutReload(token: string, now: number): { email: string; expiresAt: number } | null {
    const [body, mac] = token.split('.');
    if (!body || !mac || !timingSafeEqual(Buffer.from(this.mac(body)), Buffer.from(mac))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number };
      return payload.e && payload.x > now ? { email: payload.e, expiresAt: payload.x } : null;
    } catch { return null; }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

/** Fixed-window limiter for login attempts, keyed by client address. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const hit = this.hits.get(key);
    if (!hit || hit.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    hit.n += 1;
    return hit.n <= this.max;
  }
}

/** Parses a Cookie header without introducing a framework dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* Ignore malformed untrusted cookies. */ }
    }
  }
  return cookies;
}
