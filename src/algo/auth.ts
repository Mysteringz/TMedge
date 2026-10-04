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
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { parseCookies, RateLimiter, Sessions, turnstileCheck, turnstileFromEnv, type HumanCheck } from '../web/auth.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const ALGO_COOKIE = 'tm_algo';
/** The Turnstile action this form solves for; a student sign-in token is not one. */
export const ALGO_ACTION = 'algo-login';
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
export const MIN_PASSWORD = 12;

export interface AlgoUser { name: string; salt: string; hash: string; createdAt: number }

/**
 * The people who may sign in. Re-read when the file changes, so adding
 * somebody with `npm run algo-user` takes effect without restarting the edge
 * (a restart drops every live sensor session).
 */
export class AlgoUsers {
  private users = new Map<string, AlgoUser>();
  private seen = -1;

  constructor(readonly path: string) {
    this.refresh();
  }

  private refresh(): void {
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      this.users.clear();
      this.seen = -1;
      return;
    }
    if (mtime === this.seen) return;
    this.seen = mtime;
    try {
      const list = JSON.parse(readFileSync(this.path, 'utf8')) as AlgoUser[];
      this.users = new Map(list.filter((u) => typeof u?.name === 'string').map((u) => [u.name, u]));
    } catch {
      // A half-written or hand-mangled file must not open the door; it closes it.
      this.users.clear();
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

  static normalise(name: string): string {
    return name.trim().toLowerCase();
  }

  async add(rawName: string, password: string): Promise<AlgoUser> {
    const name = AlgoUsers.normalise(rawName);
    if (!NAME.test(name)) throw new Error('a username is 2-32 of a-z, 0-9, _ . - and starts with a letter or digit');
    if (password.length < MIN_PASSWORD) throw new Error(`use at least ${MIN_PASSWORD} characters for the password`);
    this.refresh();
    const salt = randomBytes(16);
    const user: AlgoUser = { name, salt: salt.toString('hex'), hash: (await scrypt(password, salt, 32)).toString('hex'), createdAt: Date.now() };
    this.users.set(name, user);
    this.save();
    return user;
  }

  remove(rawName: string): boolean {
    this.refresh();
    const ok = this.users.delete(AlgoUsers.normalise(rawName));
    if (ok) this.save();
    return ok;
  }

  async verify(rawName: string, password: string): Promise<string | null> {
    this.refresh();
    const name = AlgoUsers.normalise(rawName);
    const user = this.users.get(name);
    // Hash for unknown names too, so timing does not say which accounts exist.
    const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    if (!user) return null;
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex')) ? name : null;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.users.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.seen = statSync(this.path).mtimeMs;
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
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/api/') || raw.startsWith('/auth/')) return '/';
  return raw;
}

export interface AlgoAuth {
  /** The signed-in user, or null. With auth off, everyone is "local". */
  userOf(req: { headers: { cookie?: string } }): string | null;
  /** 401 for /api/*, a redirect to /login for pages. */
  requireUser: (req: Request, res: Response, next: NextFunction) => void;
  /** POST /auth/login, POST /auth/logout. */
  router: Router;
  users: AlgoUsers;
}

export function createAlgoAuth(cfg: AlgoAuthConfig): AlgoAuth {
  const users = new AlgoUsers(cfg.usersPath);
  const sessions = new Sessions(cfg.sessionSecret, 12 * 3600 * 1000);
  const limiter = new RateLimiter(10, 5 * 60_000);
  const isHuman = cfg.turnstile ? cfg.turnstile.check ?? turnstileCheck(cfg.turnstile.secretKey, cfg.turnstile.hostnames) : null;

  const userOf: AlgoAuth['userOf'] = (req) => {
    if (!cfg.enabled) return 'local';
    const name = sessions.read(parseCookies(req.headers.cookie)[ALGO_COOKIE]);
    // A removed account is signed out at once, not when its cookie expires.
    return name && users.has(name) ? name : null;
  };

  const requireUser: AlgoAuth['requireUser'] = (req, res, next) => {
    const user = userOf(req);
    if (user) {
      res.locals.user = user;
      return next();
    }
    // Deliberately no WWW-Authenticate header: that is what made the browser
    // draw its own password dialog. The deploy health check only needs a 401.
    if (req.path.startsWith('/api/')) return void res.status(401).json({ error: 'sign in first' });
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
      let host: string | null = null;
      try { host = new URL(origin).host; } catch { /* refused below */ }
      if (host !== req.get('host')) return void res.status(403).json({ error: 'cross-origin post refused' });
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
    if (!name || !password) return res.status(400).json({ error: 'username and password required' });
    // The limiter first: it costs nothing, so a flood never becomes a flood
    // of calls to Cloudflare or of scrypt hashes.
    if (!limiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'too many attempts; wait a few minutes' });
    if (isHuman) {
      const token = body['cf-turnstile-response'];
      if (typeof token !== 'string' || !(await isHuman(token, ALGO_ACTION, req.ip))) {
        return res.status(403).json({ error: 'complete the verification and try again' });
      }
    }
    const user = await users.verify(name, password);
    if (!user) return res.status(401).json({ error: 'wrong username or password' });
    // Lax, not Strict: algo.hkumyseat.com is reached through Cloudflare
    // Access's login on another site, and a Strict cookie would be withheld
    // from that first navigation -- the server would see a stranger while the
    // page's own requests saw an engineer. Writes are guarded separately by
    // the x-tm-algo header, which no cross-site form can send.
    res.cookie(ALGO_COOKIE, sessions.issue(user), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: sessions.ttl, path: '/',
    });
    return res.json({ ok: true, user, redirect: safeAlgoNext(body.next) });
  });

  router.post('/auth/logout', sameOrigin, (_req, res) => {
    res.clearCookie(ALGO_COOKIE, { path: '/' });
    res.json({ ok: true, redirect: '/login' });
  });

  return { userOf, requireUser, router, users };
}
