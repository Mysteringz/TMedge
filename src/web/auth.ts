/**
 * Student accounts and sessions, with no dependencies beyond node:crypto.
 *
 * - Passwords: scrypt with a per-user salt.
 * - Sessions: a stateless signed cookie (email + expiry, HMAC-SHA256), so the
 *   web tier can run as several instances behind a load balancer with no
 *   shared session store. Logout revocations persist when configured; rotate
 *   SESSION_SECRET to revoke sessions across every instance.
 * - Sign-up is limited to university email domains.
 *
 * Students may also sign in with Google (google.ts); such an account has
 * no password, and is found again by Google's `sub`.
 *
 * This is the local stand-in for HKU single sign-on. In production, swap
 * `UserStore` + the login form for an OIDC login against the university's
 * identity provider; the session cookie and everything behind it stay as is.
 * Until then there is no email verification, so anyone who knows a
 * @connect.hku.hk address can register it -- acceptable for a pilot, not for
 * launch.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface User {
  email: string;
  name: string;
  /** Both empty for an account made with Google: it has no password to check. */
  salt: string;
  hash: string;
  createdAt: number;
  /** Google's `sub` for this person, once they have signed in with Google. */
  google?: string;
}

export class AuthError extends Error {}
export class AuthBusyError extends AuthError {}

let activeHashes = 0;
export async function passwordHash(password: string, salt: Buffer): Promise<Buffer> {
  // Scrypt is deliberately costly. A distributed login flood must not queue
  // unlimited work or consume the whole process's memory in parallel.
  if (activeHashes >= 8) throw new AuthBusyError('Sign-in is busy. Try again shortly.');
  activeHashes++;
  try { return await scrypt(password, salt, 32); } finally { activeHashes--; }
}

import { withPrivateFileLock, writePrivateJson, FileBusyError } from '../shared/private-file.js';

export class UserStore {
  private users = new Map<string, User>();
  private seen = '';

  constructor(private readonly path: string, private readonly allowedDomains: string[]) { this.refresh(); }

  private refresh(): void {
    const fresh = new Map<string, User>();
    let stamp = '';
    try {
      const stat = statSync(this.path, { bigint: true });
      if (stat.size > 2_000_000n) throw new Error('user store too large');
      stamp = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
      if (stamp === this.seen) return;
      const list = JSON.parse(readFileSync(this.path, 'utf8')) as User[];
      if (!Array.isArray(list)) throw new Error('invalid user store');
      const subjects = new Set<string>();
      for (const u of list) {
        if (!validUser(u) || fresh.has(u.email) || (u.google && subjects.has(u.google))) {
          throw new Error('invalid or duplicate user in user store');
        }
        fresh.set(u.email, u);
        if (u.google) subjects.add(u.google);
      }
    } catch (err) {
      // Only a missing file is an empty store. Corruption or unreadable data
      // must never be silently replaced by the next registration.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.users = fresh;
    this.seen = stamp;
  }

  get size(): number {
    this.refresh(); return this.users.size;
  }

  normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  domainAllowed(email: string): boolean {
    const domain = email.split('@')[1] ?? '';
    return this.allowedDomains.length === 0 || this.allowedDomains.includes(domain);
  }

  async create(emailRaw: string, name: string, password: string): Promise<User> {
    if (typeof emailRaw !== 'string' || typeof name !== 'string' || typeof password !== 'string') throw new AuthError('Enter text for your email, name and password.');
    const email = this.normalise(emailRaw);
    if (!validEmail(email)) throw new AuthError('Enter a valid email address.');
    if (!this.domainAllowed(email)) throw new AuthError(`Use your university email (${this.allowedDomains.map((d) => '@' + d).join(' or ')}).`);
    if (password.length > 1024) throw new AuthError('Use at most 1024 characters for your password.');
    if (password.length < 10) throw new AuthError('Use at least 10 characters for your password.');
    this.refresh();
    if (this.users.has(email)) throw new AuthError('An account with that email already exists. Sign in instead.');
    const salt = randomBytes(16);
    const hash = await passwordHash(password, salt);
    const user: User = { email, name: name.trim().slice(0, 60) || email.split('@')[0] || email, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: Date.now() };
    // scrypt yields: a simultaneous signup or Google callback may have
    // claimed the address while it ran. Recheck before committing.
    try {
      return withPrivateFileLock(this.path, () => {
        this.seen = ''; this.refresh();
        if (this.users.has(email)) throw new AuthError('An account with that email already exists. Sign in instead.');
        this.save(new Map(this.users).set(email, user)); return user;
      });
    } catch (err) { if (err instanceof FileBusyError) throw new AuthBusyError(err.message); throw err; }
  }

  async verify(emailRaw: string, password: string): Promise<User | null> {
    if (typeof emailRaw !== 'string' || typeof password !== 'string' || emailRaw.length > 254 || password.length > 1024) return null;
    try { this.refresh(); } catch { return null; }
    const user = this.users.get(this.normalise(emailRaw));
    // Hash even for unknown emails so response time does not reveal which exist.
    const salt = user?.salt ? Buffer.from(user.salt, 'hex') : randomBytes(16);
    const hash = await passwordHash(password, salt);
    try { this.refresh(); } catch { return null; }
    if (!user || user.google || !user.hash || this.users.get(user.email)?.hash !== user.hash) return null;   // a Google-only account has no password that could match
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex')) ? user : null;
  }

  get(email: string): User | undefined {
    try { this.refresh(); return this.users.get(email); } catch { return undefined; }
  }

  /**
   * The account for someone Google has vouched for. The `sub` is who they
   * are: a known one is that account even if their Gmail address changed
   * since. A new `sub` gets a fresh password-less account when sign-up is
   * open. Never auto-link by email: local sign-up does not verify ownership,
   * and a third-party Google email may have changed owners since verification.
   * No domain rule: any Google account may sign in.
   */
  google(id: { sub: string; email: string; name: string }, signupOpen: boolean): User {
    try { return withPrivateFileLock(this.path, () => { this.seen = ''; this.refresh(); return this.googleUnlocked(id, signupOpen); }); }
    catch (err) { if (err instanceof FileBusyError) throw new AuthBusyError(err.message); throw err; }
  }
  private googleUnlocked(id: { sub: string; email: string; name: string }, signupOpen: boolean): User {
    for (const u of this.users.values()) if (u.google === id.sub) return u;
    const email = this.normalise(id.email);
    if (!validEmail(email) || !id.sub || id.sub.length > 255) throw new AuthError('Invalid Google identity.');
    if (this.users.has(email)) throw new AuthError('That email already belongs to an account. Sign in with its original method.');
    if (!signupOpen) throw new AuthError('Sign-up is closed.');
    const user: User = {
      email, name: id.name.trim().slice(0, 60) || email.split('@')[0] || email,
      salt: '', hash: '', createdAt: Date.now(), google: id.sub,
    };
    this.save(new Map(this.users).set(email, user));
    return user;
  }

  private save(users: Map<string, User>): void {
    writePrivateJson(this.path, [...users.values()]);
    this.users = users; this.seen = '';
  }
}

function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function validUser(v: unknown): v is User {
  if (!v || typeof v !== 'object') return false;
  const u = v as User;
  return typeof u.email === 'string' && validEmail(u.email) && u.email === u.email.trim().toLowerCase() &&
    typeof u.name === 'string' && u.name.length <= 60 && Number.isFinite(u.createdAt) && u.createdAt >= 0 &&
    (u.google === undefined || (typeof u.google === 'string' && u.google.length > 0 && u.google.length <= 255)) &&
    typeof u.salt === 'string' && typeof u.hash === 'string' &&
    ((/^[0-9a-f]{32}$/.test(u.salt) && /^[0-9a-f]{64}$/.test(u.hash)) || (!!u.google && u.salt === '' && u.hash === ''));
}

export class Sessions {
  private readonly revoked = new Map<string, number>();
  private validAfter = -Infinity;
  private revocationStamp: string | null = null;
  constructor(private readonly secret: Buffer, private readonly ttlMs = 14 * 24 * 3600 * 1000, private readonly revocationsPath?: string, private readonly accountVersion?: (email: string) => string | null) {
    this.reloadRevocations(Date.now());
  }

  issue(email: string, now = Date.now()): string {
    const version = this.accountVersion?.(email);
    if (this.accountVersion && !version) throw new AuthError('Unknown account.');
    const body = Buffer.from(JSON.stringify({ e: email, x: now + this.ttlMs, n: randomBytes(16).toString('base64url'), ...(this.accountVersion ? { v: version } : {}) })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** How long a fresh cookie lasts, so callers can decide when to renew one. */
  get ttl(): number {
    return this.ttlMs;
  }

  /** The session's email, or null if missing, forged or expired. */
  read(token: string | undefined, now = Date.now()): string | null {
    return this.detail(token, now)?.email ?? null;
  }

  /** Stop replay of a logged-out cookie, persisting it when configured. */
  revoke(token: string | undefined, now = Date.now()): void {
    if (this.revocationsPath) {
      withPrivateFileLock(this.revocationsPath, () => {
        if (this.revocationStamp !== null) this.revocationStamp = '';
        this.revokeUnlocked(token, now);
      });
    } else this.revokeUnlocked(token, now);
  }
  private revokeUnlocked(token: string | undefined, now: number): void {
    const detail = this.detail(token, now);
    if (!token || !detail) return;
    for (const [key, expiry] of this.revoked) if (expiry <= now) this.revoked.delete(key);
    // Bound memory without resurrecting earlier revoked cookies. Overflow
    // invalidates all sessions issued by this process before this instant.
    if (this.revoked.size >= 10_000) { this.validAfter = now; this.revoked.clear(); }
    this.revoked.set(this.mac(token), detail.expiresAt);
    this.saveRevocations();
  }

  /**
   * The same check, but keeping the expiry: the web tier renews a cookie that
   * is past halfway so a daily user is never signed out mid-term, while an
   * abandoned one still dies on its own.
   */
  detail(token: string | undefined, now = Date.now()): { email: string; expiresAt: number } | null {
    if (!token || token.length > 2048) return null;
    // An unreadable revocation file must deny access, never undo a logout.
    try { this.reloadRevocations(now); } catch { return null; }
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, mac] = parts;
    if (!body || !mac) return null;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { e, x, v } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number; v?: string };
      if (typeof e !== 'string' || typeof x !== 'number' || !Number.isFinite(x) || x <= now || x > now + this.ttlMs || e.length === 0 || e.length > 254 ||
          x - this.ttlMs <= this.validAfter || this.revoked.has(this.mac(token))) return null;
      if (this.accountVersion && (typeof v !== 'string' || v !== this.accountVersion(e))) return null;
      return { email: e, expiresAt: x };
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private reloadRevocations(now: number): void {
    if (!this.revocationsPath) return;
    let stamp: string;
    try {
      const st = statSync(this.revocationsPath, { bigint: true });
      if (st.size > 2_000_000n) throw new Error('session revocation file is too large');
      stamp = `${st.ino}:${st.mtimeNs}:${st.size}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && this.revocationStamp === null) return;
      throw err;
    }
    if (stamp === this.revocationStamp) return;
    const data = JSON.parse(readFileSync(this.revocationsPath, 'utf8')) as { validAfter?: unknown; revoked?: unknown };
    if (!data || (data.validAfter !== null && (typeof data.validAfter !== 'number' || !Number.isFinite(data.validAfter))) ||
        !Array.isArray(data.revoked) || data.revoked.length > 10_000 || data.revoked.some((entry: unknown) =>
          !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry[0]) ||
          typeof entry[1] !== 'number' || !Number.isFinite(entry[1]))) throw new Error('invalid session revocation file');
    this.revoked.clear();
    for (const [key, expiry] of data.revoked as [string, number][]) if (expiry > now) this.revoked.set(key, expiry);
    this.validAfter = data.validAfter === null ? -Infinity : data.validAfter as number;
    this.revocationStamp = stamp;
  }

  private saveRevocations(): void {
    if (!this.revocationsPath) return;
    writePrivateJson(this.revocationsPath, { validAfter: Number.isFinite(this.validAfter) ? this.validAfter : null, revoked: [...this.revoked] });
    this.revocationStamp = '';
  }
}

/** Fixed-window limiter for login attempts, per client address. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      if (!h && this.hits.size >= 10_000) {
        for (const [k, entry] of this.hits) if (entry.reset <= now) this.hits.delete(k);
        // A spray of new addresses must not erase blocked addresses.
        if (this.hits.size >= 10_000) return false;
      }
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    if (h.n >= this.max) return false;
    h.n += 1;
    return true;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (Object.hasOwn(out, key)) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie is unauthenticated */ }
  }
  return out;
}

/**
 * Asks Cloudflare whether a Turnstile token came from a person. Returns true
 * only for a token that siteverify accepts *for this form on this site*: a
 * token solved on the sign-up page is not reusable for a sign-in, one solved
 * on another hostname is refused (the site key is public, so anyone can embed
 * it), and a token is single-use, so a replay fails on Cloudflare's side.
 *
 * Fails closed. The site is served through a Cloudflare Tunnel, so when
 * siteverify is unreachable students cannot reach us anyway; an attacker who
 * can make the check time out must not get a free pass for it.
 */
export type HumanCheck = (token: string, action: string, ip: string | undefined) => Promise<boolean>;

/**
 * Every refusal says why, in the server log. A student only sees "complete
 * the verification", which is right for a bot and useless for an operator:
 * the first production refusals came from TURNSTILE_HOSTNAMES naming the
 * wrong host, and nothing anywhere said so. The token itself is never logged.
 */
export function turnstileCheck(
  secret: string, hostnames: string[], fetchImpl: typeof fetch = fetch,
  log: (msg: string) => void = (msg) => console.warn(`[web] turnstile refused: ${msg}`),
): HumanCheck {
  const allowed = new Set(hostnames);
  const refuse = (action: string, why: string) => {
    log(`${action}: ${why}`);
    return false;
  };
  return async (token, action, ip) => {
    // Cloudflare's own limit; anything longer is not a token.
    if (!token || token.length > 2048) return refuse(action, 'no token, or not a token');
    if (allowed.size === 0) return refuse(action, 'TURNSTILE_HOSTNAMES is empty');
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    try {
      const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: form, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return refuse(action, `siteverify answered HTTP ${res.status}`);
      const out = (await res.json()) as {
        success?: unknown; action?: unknown; hostname?: unknown; 'error-codes'?: unknown;
        metadata?: { result_with_testing_key?: unknown };
      };
      // Cloudflare's codes (invalid-input-secret, timeout-or-duplicate, ...) name the cause.
      if (out.success !== true) return refuse(action, `siteverify said no (${JSON.stringify(out['error-codes'] ?? [])})`);
      // Cloudflare's published test keys (for running this locally) echo no
      // action and the hostname "example.com"; only a dummy secret produces
      // this flag, so it never relaxes production.
      if (out.metadata?.result_with_testing_key === true) return true;
      if (out.action !== action) return refuse(action, `token was solved for action ${JSON.stringify(out.action)}`);
      if (typeof out.hostname !== 'string' || !allowed.has(out.hostname)) {
        return refuse(action, `token was solved on ${JSON.stringify(out.hostname)}, TURNSTILE_HOSTNAMES allows ${[...allowed].join(', ')}`);
      }
      return true;
    } catch (err) {
      return refuse(action, `siteverify unreachable (${(err as Error).message})`);
    }
  };
}

export interface TurnstileConfig { siteKey: string; secretKey: string; hostnames: string[] }

/**
 * Both keys or neither. One without the other is a half-made setup: a site key
 * alone would draw a widget nobody checks, and a secret alone would refuse
 * every student because the page has no widget to solve.
 *
 * Shared by the web tier and the edge's algo console: both processes read the
 * same .env, so one widget and one rule set covers both sign-in pages.
 */
export function turnstileFromEnv(env: NodeJS.ProcessEnv): TurnstileConfig | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? '';
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? '';
  if (!siteKey && !secretKey) return null;
  if (!siteKey || !secretKey) throw new Error('set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY together, or neither');
  // The site key lands in an HTML attribute; keep it to what Cloudflare issues.
  if (!/^[\w-]{8,100}$/.test(siteKey)) throw new Error('TURNSTILE_SITE_KEY does not look like a Turnstile site key');
  // The pages a token may have been solved on. Without it every token would
  // fail siteverify's hostname check, i.e. nobody could sign in: refuse now.
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hostnames.length === 0) throw new Error('TURNSTILE_HOSTNAMES must list the site\'s hostnames, e.g. hkumyseat.com');
  return { siteKey, secretKey, hostnames };
}
