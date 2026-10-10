/**
 * Sign-in for the algo console: a page, not the browser's password dialog.
 *
 * It used to be HTTP Basic with the shared ADMIN_PASSWORD. That gave every
 * engineer the same identity -- the audit log could only say "algo-dashboard"
 * changed a sensor -- and the browser's prompt could carry no human check. Now
 * each person has an account in a small file of scrypt hashes, the sign-in
 * form carries Cloudflare Turnstile, and a session cookie stands in for both.
 *
 * Auth is on whenever ADMIN_PASSWORD is set, because that is the edge's
 * existing signal that it listens beyond localhost (config.ts binds the
 * console and this port to 127.0.0.1 without one). The password itself is no
 * longer a way in here; it stays the console's.
 */
import { isAdminRole, principal, type AdminRole, type AdminPrincipal, type Capability } from '../modules/algo-admin/domain/permissions.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withPrivateFileLock, writePrivateJson } from '../shared/private-file.js';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { AuthBusyError, parseCookies, passwordHash, RateLimiter, Sessions, turnstileCheck, turnstileFromEnv, type HumanCheck } from '../web/auth.js';

export const ALGO_COOKIE = 'tm_algo';
/** The Turnstile action this form solves for; a student sign-in token is not one. */
export const ALGO_ACTION = 'algo-login';
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
export const MIN_PASSWORD = 12;

export interface AlgoUser { name: string; salt: string; hash: string; createdAt: number; role?: AdminRole; disabled?: boolean; sessionVersion?: number }

/**
 * The people who may sign in. Re-read when the file changes, so adding
 * somebody with `npm run algo-user` takes effect without restarting the edge
 * (a restart drops every live sensor session).
 */
export class AlgoUsers {
  private users = new Map<string, AlgoUser>();
  private seen = '';
  private invalid = false;

  constructor(readonly path: string) {
    this.refresh();
  }

  private refresh(): void {
    let stamp: string;
    try {
      const stat = statSync(this.path, { bigint: true });
      if (stat.size > 2_000_000n) throw new Error('account file too large');
      stamp = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    } catch (err) {
      this.users.clear();
      this.seen = '';
      this.invalid = (err as NodeJS.ErrnoException).code !== 'ENOENT';
      return;
    }
    if (stamp === this.seen) return;
    this.seen = stamp;
    try {
      const list = JSON.parse(readFileSync(this.path, 'utf8')) as AlgoUser[];
      if (!Array.isArray(list) || list.some((u) => !u || typeof u.name !== 'string' || !NAME.test(u.name) ||
          typeof u.salt !== 'string' || !/^[0-9a-f]{32}$/.test(u.salt) ||
          typeof u.hash !== 'string' || !/^[0-9a-f]{64}$/.test(u.hash) || !Number.isFinite(u.createdAt) || u.createdAt < 0 || (u.role !== undefined && !isAdminRole(u.role)) || (u.disabled !== undefined && typeof u.disabled !== 'boolean') || (u.sessionVersion !== undefined && (!Number.isSafeInteger(u.sessionVersion) || u.sessionVersion < 0))) ||
          new Set(list.map((u) => u.name)).size !== list.length) throw new Error('invalid account file');
      this.users = new Map(list.map((u) => [u.name, { ...u, role: u.role ?? 'engineer', disabled: u.disabled ?? false, sessionVersion: u.sessionVersion ?? 0 }]));
      this.invalid = false;
    } catch {
      // A half-written or hand-mangled file must not open the door; it closes it.
      this.users.clear();
      this.invalid = true;
    }
  }

  get size(): number {
    this.refresh();
    return this.users.size;
  }

  names(): string[] {
    this.refresh();
    return [...this.users.keys()].sort();
  }

  has(name: string): boolean {
    this.refresh();
    return this.users.has(name);
  }

  get(name: string): AlgoUser | undefined { this.refresh(); return this.users.get(name); }

  records(): AlgoUser[] { this.refresh(); if (this.invalid) throw new Error('invalid account file'); return [...this.users.values()].map((user) => ({ ...user })); }

  static normalise(name: string): string {
    return name.trim().toLowerCase();
  }

  async add(rawName: string, password: string, role: AdminRole = 'operator', authorize: () => void = () => {}): Promise<AlgoUser> {
    if (typeof rawName !== 'string' || typeof password !== 'string' || password.length > 1024) throw new Error('username and password required within the size limits');
    if (!isAdminRole(role)) throw new Error('invalid role');
    const name = AlgoUsers.normalise(rawName);
    if (!NAME.test(name)) throw new Error('a username is 2-32 of a-z, 0-9, _ . - and starts with a letter or digit');
    if (password.length < MIN_PASSWORD) throw new Error(`use at least ${MIN_PASSWORD} characters for the password`);
    this.refresh();
    const salt = randomBytes(16);
    if (this.invalid) throw new Error('refusing to replace an invalid account file');
    const user: AlgoUser = { name, salt: salt.toString('hex'), hash: (await passwordHash(password, salt)).toString('hex'), createdAt: Date.now(), role, disabled: false, sessionVersion: 0 };
    withPrivateFileLock(this.path, () => {
      this.seen = ''; this.refresh();
      authorize();
      if (this.invalid) throw new Error('refusing to replace an invalid account file');
      if (this.users.has(name)) throw new Error('account already exists');
      this.save(new Map(this.users).set(name, user));
    });
    return user;
  }

  remove(rawName: string, expected?: AlgoUser, authorize: () => void = () => {}): boolean {
    return withPrivateFileLock(this.path, () => {
      this.seen = ''; this.refresh();
      authorize();
      if (this.invalid) throw new Error('refusing to replace an invalid account file');
      const name = AlgoUsers.normalise(rawName), current = this.users.get(name);
      if (expected && !current) throw new Error('no such account');
      if (expected && current && JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('account changed; retry the operation');
      const next = new Map(this.users), ok = next.delete(name);
      if (ok) { this.protectLastAdmin(next); this.save(next); } return ok;
    });
  }

  async verify(rawName: string, password: string): Promise<string | null> { return (await this.verifyRecord(rawName, password))?.name ?? null; }

  async verifyRecord(rawName: string, password: string): Promise<AlgoUser | null> {
    if (typeof rawName !== 'string' || typeof password !== 'string' || rawName.length > 32 || password.length > 1024) return null;
    this.refresh();
    const name = AlgoUsers.normalise(rawName);
    const user = this.users.get(name);
    // Hash for unknown names too, so timing does not say which accounts exist.
    const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16);
    const hash = await passwordHash(password, salt);
    if (!user || user.disabled) return null;
    const current = this.get(name);
    if (!current || current.disabled || current.sessionVersion !== user.sessionVersion || current.hash !== user.hash || current.salt !== user.salt) return null;
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex')) ? current : null;
  }

  async resetPassword(rawName: string, password: string, expected?: AlgoUser, authorize: () => void = () => {}): Promise<AlgoUser> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1024) throw new Error('invalid password length');
    const snapshot = expected ?? this.get(AlgoUsers.normalise(rawName));
    if (!snapshot) throw new Error('no such account');
    const salt = randomBytes(16), hash = (await passwordHash(password, salt)).toString('hex');
    return this.update(rawName, { salt: salt.toString('hex'), hash }, snapshot, authorize);
  }

  /** Shared serialized primitive for CLI and downstream account management. */
  update(rawName: string, patch: { role?: AdminRole; disabled?: boolean; revoke?: boolean; salt?: string; hash?: string }, expected?: AlgoUser, authorize: () => void = () => {}): AlgoUser {
    return withPrivateFileLock(this.path, () => {
      this.seen = ''; this.refresh();
      authorize();
      if (this.invalid) throw new Error('invalid account file');
      const name = AlgoUsers.normalise(rawName), current = this.users.get(name);
      if (!current) throw new Error('no such account');
      if (expected && (current.hash !== expected.hash || current.salt !== expected.salt || current.sessionVersion !== expected.sessionVersion || current.createdAt !== expected.createdAt || current.role !== expected.role || current.disabled !== expected.disabled)) throw new Error('account changed; retry the operation');
      if (patch.role !== undefined && !isAdminRole(patch.role)) throw new Error('invalid role');
      if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') throw new Error('invalid disabled flag');
      if ((patch.salt !== undefined || patch.hash !== undefined) && (!/^[0-9a-f]{32}$/.test(patch.salt ?? '') || !/^[0-9a-f]{64}$/.test(patch.hash ?? ''))) throw new Error('invalid credentials');
      const changed = patch.revoke || (patch.role !== undefined && patch.role !== current.role) || (patch.disabled !== undefined && patch.disabled !== current.disabled) || patch.hash !== undefined;
      const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== 'revoke' && value !== undefined));
      const user = { ...current, ...fields, sessionVersion: (current.sessionVersion ?? 0) + (changed ? 1 : 0) };
      if (!Number.isSafeInteger(user.sessionVersion)) throw new Error('session version exhausted');
      const next = new Map(this.users).set(name, user);
      this.protectLastAdmin(next); this.save(next); return user;
    });
  }

  private protectLastAdmin(next: Map<string, AlgoUser>): void {
    const enabledAdmin = (u: AlgoUser) => u.role === 'admin' && !u.disabled;
    if ([...this.users.values()].some(enabledAdmin) && ![...next.values()].some(enabledAdmin)) throw new Error('cannot remove, disable or demote the final enabled admin');
  }

  private save(users: Map<string, AlgoUser>): void {
    writePrivateJson(this.path, [...users.values()]);
    this.users = users; this.seen = '';
  }
}

export interface AlgoAuthConfig {
  /** False only for a localhost-only edge with no ADMIN_PASSWORD. */
  enabled: boolean;
  usersPath: string;
  sessionSecret: Buffer;
  turnstile: { siteKey: string; secretKey: string; hostnames: string[]; check?: HumanCheck } | null;
  /** Express trust-proxy setting; see the web tier's WebConfig.trustProxy. */
  trustProxy: boolean | string;
}

export function algoUsersPath(env: NodeJS.ProcessEnv): string {
  return env.ALGO_USERS_FILE || join(env.DATA_DIR || 'data', 'algo', 'users.json');
}

export function loadAlgoAuthConfig(env: NodeJS.ProcessEnv, adminPassword: string | null): AlgoAuthConfig {
  const enabled = adminPassword !== null;
  const secret = env.ALGO_SESSION_SECRET || env.SESSION_SECRET || '';
  if (enabled && secret.length < 32) {
    throw new Error('the algo console needs SESSION_SECRET (or ALGO_SESSION_SECRET), 32+ chars, to sign its sessions');
  }
  return {
    enabled,
    usersPath: algoUsersPath(env),
    // Derived, never the raw secret: the student tier signs its cookies with
    // SESSION_SECRET too, and a student's session must not be a valid
    // engineer's session here just because the token shapes happen to match.
    sessionSecret: createHmac('sha256', secret || randomBytes(32)).update('tmedge-algo-session-v1').digest(),
    turnstile: enabled ? turnstileFromEnv(env) : null,
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === '0' ? false : env.TRUST_PROXY === '1' ? true : env.TRUST_PROXY,
  };
}

/** Where to go after signing in: a path on this site, never somewhere else. */
export function safeAlgoNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) return '/';
  try {
    const url = new URL(raw, 'https://navigation.invalid');
    if (url.origin !== 'https://navigation.invalid' || url.pathname.startsWith('//') || /^\/(?:login|api|auth)(?:\/|$)/.test(url.pathname)) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

export interface AlgoAuth {
  /** The signed-in user, or null. With auth off, everyone is "local". */
  accountEpoch(name: string): string | null;
  principalOf(req: { headers: { cookie?: string } }): AdminPrincipal | null;
  requireCapability(capability: Capability): (req: Request, res: Response, next: NextFunction) => void;
  userOf(req: { headers: { cookie?: string } }): string | null;
  /** 401 for /api/*, a redirect to /login for pages. */
  requireUser: (req: Request, res: Response, next: NextFunction) => void;
  /** POST /auth/login, POST /auth/logout. */
  router: Router;
  users: AlgoUsers;
  sessionToken(req: { headers: { cookie?: string } }): string;
  onLogout(listener: (token: string) => void): void;
  /** A native credential stops working when its account or password changes. */
  accountSubject(name: string): string | null;
}

export function createAlgoAuth(cfg: AlgoAuthConfig): AlgoAuth {
  const users = new AlgoUsers(cfg.usersPath);
  const sessions = new Sessions(cfg.sessionSecret, 12 * 3600 * 1000, join(dirname(cfg.usersPath), 'session-revocations.json'));
  const logoutListeners = new Set<(token: string) => void>();
  const sessionToken: AlgoAuth['sessionToken'] = (req) => cfg.enabled ? parseCookies(req.headers.cookie)[ALGO_COOKIE] ?? '' : 'local';
  const subjectFor = (user: AlgoUser) => `${user.name}:${createHmac('sha256', cfg.sessionSecret).update(`${user.salt}:${user.hash}${user.sessionVersion ? `:${user.sessionVersion}` : ''}`).digest('base64url')}`;
  const subject = (name: string) => {
    const user = users.get(name);
    return user && !user.disabled ? subjectFor(user) : null;
  };
  const limiter = new RateLimiter(10, 5 * 60_000);
  const isHuman = cfg.turnstile ? cfg.turnstile.check ?? turnstileCheck(cfg.turnstile.secretKey, cfg.turnstile.hostnames) : null;

  const principalOf: AlgoAuth['principalOf'] = (req) => {
    if (!cfg.enabled) return principal('local', 'admin', false);
    const identity = sessions.read(sessionToken(req)), name = identity?.split(':')[0];
    const current = name ? users.get(name) : undefined;
    if (!current || current.disabled || identity !== subjectFor(current)) return null;
    return principal(current.name, current.role ?? 'engineer');
  };
  const userOf: AlgoAuth['userOf'] = (req) => principalOf(req)?.name ?? null;

  const requireCapability: AlgoAuth['requireCapability'] = (capability) => (req, res, next) => {
    const current = principalOf(req);
    if (!current) return void res.status(401).json({ error: 'sign in first' });
    if (!current.capabilities.includes(capability)) return void res.status(403).json({ error: 'Your access has changed. This action is unavailable.' });
    return next();
  };

  const requireUser: AlgoAuth['requireUser'] = (req, res, next) => {
    const user = userOf(req);
    if (user) {
      res.locals.user = user;
      res.locals.principal = principalOf(req);
      return next();
    }
    // Deliberately no WWW-Authenticate header: that is what made the browser
    // draw its own password dialog. The deploy health check only needs a 401.
    if (req.path.startsWith('/api/') || req.path.startsWith('/console-app/api/')) return void res.status(401).json({ error: 'sign in first' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  };

  /**
   * The session cookie is SameSite=Lax, so a cross-site form can still reach
   * a POST here. These endpoints refuse any Origin that is not this host; a
   * malformed one ("null" from a sandboxed frame) is refused, not a crash.
   */
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin) {
      let same = false;
      try { const url = new URL(origin); same = url.origin === new URL(`${req.protocol}://${req.get('host')}`).origin && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { /* refused below */ }
      if (!same) return void res.status(403).json({ error: 'cross-origin post refused' });
    }
    return next();
  };

  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  router.post('/auth/login', sameOrigin, async (req, res) => {
    if (!cfg.enabled) return res.json({ ok: true, user: 'local', redirect: '/' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || !password || name.length > 32 || password.length > 1024) return res.status(400).json({ error: 'username and password required within the size limits' });
    // The limiter first: it costs nothing, so a flood never becomes a flood
    // of calls to Cloudflare or of scrypt hashes.
    if (!limiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'too many attempts; wait a few minutes' });
    try {
    if (isHuman) {
      const token = body['cf-turnstile-response'];
      if (typeof token !== 'string' || !(await isHuman(token, ALGO_ACTION, req.ip))) {
        return res.status(403).json({ error: 'complete the verification and try again' });
      }
    }
    const verified = await users.verifyRecord(name, password);
    if (!verified) return res.status(401).json({ error: 'wrong username or password' });
    // Lax, not Strict: algo.hkumyseat.com is reached through Cloudflare
    // Access's login on another site, and a Strict cookie would be withheld
    // from that first navigation -- the server would see a stranger while the
    // page's own requests saw an engineer. Writes are guarded separately by
    // the x-tm-algo header, which no cross-site form can send.
    const user = verified.name, issuedSubject = subjectFor(verified);
    if (subject(user) !== issuedSubject) return res.status(401).json({ error: 'wrong username or password' });
    res.cookie(ALGO_COOKIE, sessions.issue(issuedSubject), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: sessions.ttl, path: '/',
    });
    return res.json({ ok: true, user, redirect: safeAlgoNext(body.next) });
    } catch (err) {
      if (err instanceof AuthBusyError) return res.status(429).json({ error: err.message });
      return res.status(503).json({ error: 'sign-in is temporarily unavailable' });
    }
  });

  router.post('/auth/logout', sameOrigin, (req, res) => {
    const token = sessionToken(req);
    sessions.revoke(token);
    for (const listener of logoutListeners) listener(token);
    res.clearCookie(ALGO_COOKIE, { path: '/' });
    res.json({ ok: true, redirect: '/login' });
  });

  const accountSubject = (name: string): string | null => {
    const current = cfg.enabled ? users.get(name) : undefined;
    return current && principal(name, current.role ?? 'engineer').capabilities.includes('nodes.admin') ? subject(name) : null;
  };
  return { userOf, accountEpoch: subject, accountSubject, principalOf, requireCapability, requireUser, router, users, sessionToken, onLogout: (listener) => { logoutListeners.add(listener); } };
}
