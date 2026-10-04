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

  /** How long a fresh cookie lasts, so callers can decide when to renew one. */
  get ttl(): number {
    return this.ttlMs;
  }

  /** The session's email, or null if missing, forged or expired. */
  read(token: string | undefined, now = Date.now()): string | null {
    return this.detail(token, now)?.email ?? null;
  }

  /**
   * The same check, but keeping the expiry: the web tier renews a cookie that
   * is past halfway so a daily user is never signed out mid-term, while an
   * abandoned one still dies on its own.
   */
  detail(token: string | undefined, now = Date.now()): { email: string; expiresAt: number } | null {
    if (!token) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { e, x } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number };
      if (typeof e !== 'string' || typeof x !== 'number' || x <= now) return null;
      return { email: e, expiresAt: x };
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
