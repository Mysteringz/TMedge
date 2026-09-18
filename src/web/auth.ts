/**
 * Student accounts and sessions, with no dependencies beyond node:crypto.
 *
 * - Passwords: scrypt with a per-user salt.
 * - Sessions: a stateless signed cookie (email + expiry, HMAC-SHA256), so the
 *   web tier can run as several instances behind a load balancer with no
 *   shared session store. Revocation is by rotating SESSION_SECRET.
 * - Sign-up is limited to university email domains.
 *
 * This is the local stand-in for HKU single sign-on. In production, swap
 * `UserStore` + the login form for an OIDC login against the university's
 * identity provider; the session cookie and everything behind it stay as is.
 * Until then there is no email verification, so anyone who knows a
 * @connect.hku.hk address can register it -- acceptable for a pilot, not for
 * launch.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface User {
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: number;
}

export class AuthError extends Error {}

export class UserStore {
  private users = new Map<string, User>();

  constructor(private readonly path: string, private readonly allowedDomains: string[]) {
    try {
      const list = JSON.parse(readFileSync(path, 'utf8')) as User[];
      for (const u of list) this.users.set(u.email, u);
    } catch {
      /* no users yet */
    }
  }

  get size(): number {
    return this.users.size;
  }

  normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  domainAllowed(email: string): boolean {
    const domain = email.split('@')[1] ?? '';
    return this.allowedDomains.length === 0 || this.allowedDomains.includes(domain);
  }

  async create(emailRaw: string, name: string, password: string): Promise<User> {
    const email = this.normalise(emailRaw);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
    if (!this.domainAllowed(email)) throw new AuthError(`Use your university email (${this.allowedDomains.map((d) => '@' + d).join(' or ')}).`);
    if (password.length < 10) throw new AuthError('Use at least 10 characters for your password.');
    if (this.users.has(email)) throw new AuthError('An account with that email already exists. Sign in instead.');
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    const user: User = { email, name: name.trim().slice(0, 60) || email.split('@')[0] || email, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: Date.now() };
    this.users.set(email, user);
    this.save();
    return user;
  }

  async verify(emailRaw: string, password: string): Promise<User | null> {
    const user = this.users.get(this.normalise(emailRaw));
    // Hash even for unknown emails so response time does not reveal which exist.
    const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    if (!user) return null;
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex')) ? user : null;
  }

  get(email: string): User | undefined {
    return this.users.get(email);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.users.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);   // atomic: a crash mid-write never leaves a truncated user file
  }
}

export class Sessions {
  constructor(private readonly secret: Buffer, private readonly ttlMs = 14 * 24 * 3600 * 1000) {}

  issue(email: string, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ e: email, x: now + this.ttlMs })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** The session's email, or null if missing, forged or expired. */
  read(token: string | undefined, now = Date.now()): string | null {
    if (!token) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { e, x } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number };
      return typeof e === 'string' && typeof x === 'number' && x > now ? e : null;
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

/** Fixed-window limiter for login attempts, per client address. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();   // bound memory under a spray of addresses
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
