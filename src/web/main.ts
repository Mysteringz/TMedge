/**
 * The student web app: `npm run web`.
 *
 * Stateless apart from the user file, so it runs the same on this Mac, the
 * NUC, or EC2 behind a load balancer (set TRUST_PROXY=1 and COOKIE_SECURE=1
 * there). It never talks to a node and never sees a thermal image: it
 * receives occupancy snapshots from edges and serves them to signed-in
 * students.
 *
 * Read-only for students: the only write is POST /api/edge/snapshot, which
 * needs the edge's bearer token. No endpoint lets a browser change what
 * other people see.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { searchSeats } from '../shared/seats.js';
import { AuthError, parseCookies, RateLimiter, Sessions, UserStore } from './auth.js';
import { isSnapshot, SnapshotStore } from './store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-web');
const COOKIE = 'tm_session';

export interface WebConfig {
  port: number;
  host: string;
  pushToken: string;
  sessionSecret: Buffer;
  usersPath: string;
  allowedDomains: string[];
  signupOpen: boolean;
  cookieSecure: boolean;
  /**
   * Which proxies may set X-Forwarded-*: false (none), true (loopback only --
   * cloudflared on the same host), or an Express trust-proxy string such as
   * "loopback, uniquelocal" when cloudflared runs in its own container.
   */
  trustProxy: boolean | string;
  staleMs: number;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const pushToken = env.WEB_PUSH_TOKEN ?? '';
  if (pushToken.length < 16) throw new Error('WEB_PUSH_TOKEN must be set (16+ chars): it is how edges authenticate their snapshots');
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars): it signs login sessions');
  return {
    port: Number(env.WEB_PORT || 8080),
    host: env.WEB_HOST || '0.0.0.0',
    pushToken,
    sessionSecret: Buffer.from(secret),
    usersPath: env.USERS_FILE || join(env.DATA_DIR || 'data', 'users.json'),
    allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    signupOpen: env.SIGNUP_OPEN !== '0',
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === '0' ? false : env.TRUST_PROXY === '1' ? true : env.TRUST_PROXY,
    staleMs: Number(env.STALE_MS || 30_000),
  };
}

/**
 * A stamp for the hand-written files that keep their names across deploys.
 * The app bundle needs no help -- Vite gives every build's chunks a content
 * hash -- but `/vendor/floor-viewer.js` and the three.js beside it would
 * otherwise sit in a browser, or in the CDN in front of us, for as long as it
 * pleased them. The shell carries the stamp in a meta tag and the app asks for
 * `/vendor/v<stamp>/...`, which is a new URL on every build.
 */
function assetVersion(): string {
  const files = ['vendor/floor-viewer.js'];
  const h = createHash('sha256');
  for (const f of files) {
    try {
      const st = statSync(join(PUBLIC, f));
      h.update(`${f}:${st.size}:${st.mtimeMs}`);
    } catch {
      h.update(`${f}:missing`);   // not built yet: still a stable stamp
    }
  }
  return h.digest('hex').slice(0, 10);
}

/**
 * Where to send a student after signing in. Only a path on this site: an
 * absolute URL, or the "//host" form a browser also reads as one, would turn
 * our sign-in page into somebody else's redirector.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard/';
  if (raw.startsWith('/login') || raw.startsWith('/signup')) return '/dashboard/';
  return raw;
}

/**
 * Students know themselves by HKU Portal UID, so the sign-in field takes one;
 * accounts are still keyed by email. A bare "u3587219" becomes
 * u3587219@<student domain>, and anyone typing a full address is untouched.
 * (UIDs are "u3" and six to eight digits, which covers every year group.)
 */
export function asEmail(raw: string, domains: string[]): string {
  const uid = raw.trim().toLowerCase();
  if (!/^u3\d{6,8}$/.test(uid)) return raw;
  return `${uid}@${domains.find((d) => d.startsWith('connect.')) ?? domains[0] ?? 'connect.hku.hk'}`;
}

export function createWebApp(cfg: WebConfig) {
  const users = new UserStore(cfg.usersPath, cfg.allowedDomains);
  const sessions = new Sessions(cfg.sessionSecret);
  const store = new SnapshotStore(cfg.staleMs);
  const loginLimiter = new RateLimiter(10, 5 * 60_000);
  const version = assetVersion();
  // One shell for every screen; the React app decides which one to draw.
  const appPage = readFileSync(join(PUBLIC, 'index.html'), 'utf8').replaceAll('{{v}}', version);

  const app = express();
  app.disable('x-powered-by');
  // Behind Cloudflare Tunnel the proxy is cloudflared on this machine: trust
  // X-Forwarded-* (client IP for the login limiter, https for the cookie)
  // only from loopback, never from anyone who can reach the port directly.
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy === true ? 'loopback' : cfg.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  const userOf = (req: IncomingMessage) => sessions.read(parseCookies(req.headers.cookie)[COOKIE]);
  const setSession = (req: Request, res: Response, email: string) => {
    // Secure whenever the student reached us over HTTPS (the public site), so
    // the cookie never travels in clear; plain http still works on the LAN.
    res.cookie(COOKIE, sessions.issue(email), { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure || req.secure, maxAge: sessions.ttl, path: '/' });
  };
  /**
   * Which page a browser gets depends on a cookie, so no page and no redirect
   * on this site may be stored anywhere: a cached "/ -> /login/" would send a
   * signed-in student to sign in again, and a cached "/ -> /dashboard/" would
   * bounce a stranger between the two until they gave up. The assets have
   * their own stamped URLs and are cached hard; the decisions never are.
   */
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store').set('Vary', 'Cookie');
  const sendApp = (res: Response, status = 200) => {
    noStore(res);
    res.status(status).type('html').send(appPage);
  };
  // Cross-site posts: the session cookie is SameSite=Lax, and the auth
  // endpoints additionally require a same-origin Origin header when one is sent.
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'cross-origin post refused' });
    return next();
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true, edges: store.edges() }));

  // hkumyseat.com is a gateway, not a screen: it decides where you belong and
  // sends you there, which leaves the bare domain free for a public homepage.
  app.get('/', (req, res) => {
    noStore(res);
    res.redirect(userOf(req) ? '/dashboard/' : '/login/');
  });

  // Sign-in and sign-up are the app too; a student who already has a session
  // is sent on rather than shown a form they do not need.
  app.get(['/login', '/login/', '/signup', '/signup/'], (req, res) => {
    if (userOf(req)) {
      noStore(res);
      return res.redirect(safeNext(req.query.next));
    }
    if (req.path.startsWith('/signup') && !cfg.signupOpen) {
      noStore(res);
      return res.redirect('/login/');
    }
    return sendApp(res);
  });

  const body = [express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb' })];
  app.post('/login', body, sameOrigin, async (req: Request, res: Response) => {
    noStore(res);
    const { email: raw = '', password = '', next } = req.body as Record<string, string>;
    const email = asEmail(raw, cfg.allowedDomains);
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    const user = await users.verify(email, password);
    if (!user) return res.status(401).json({ error: 'That UID and PIN do not match.' });
    setSession(req, res, user.email);
    return res.json({ redirect: safeNext(next) });
  });
  app.post('/signup', body, sameOrigin, async (req: Request, res: Response) => {
    noStore(res);
    if (!cfg.signupOpen) return res.status(403).json({ error: 'Sign-up is closed.' });
    const { email: raw = '', name = '', password = '', next } = req.body as Record<string, string>;
    const email = asEmail(raw, cfg.allowedDomains);
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    try {
      const user = await users.create(email, name, password);
      setSession(req, res, user.email);
      return res.json({ redirect: safeNext(next) });
    } catch (err) {
      if (err instanceof AuthError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
  app.post('/logout', body, sameOrigin, (_req: Request, res: Response) => {
    res.clearCookie(COOKIE, { path: '/' });
    noStore(res);
    res.json({ redirect: '/login/' });
  });

  // The edge's push. Bearer token, compared in constant time.
  app.post('/api/edge/snapshot', express.json({ limit: '2mb' }), (req, res) => {
    const got = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cfg.pushToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'bad edge token' });
    if (!isSnapshot(req.body)) return res.status(400).json({ error: 'not an occupancy snapshot' });
    store.put(req.body);
    broadcast();
    return res.json({ ok: true });
  });

  // Everything below needs a signed-in student.
  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    const detail = sessions.detail(parseCookies(req.headers.cookie)[COOKIE]);
    if (detail && users.get(detail.email)) {
      // Renew a cookie past halfway, so a student who uses the site every week
      // is never signed out on the walk to the library -- and one who stops
      // still expires on schedule rather than staying signed in for ever.
      if (detail.expiresAt - Date.now() < sessions.ttl / 2) setSession(req, res, detail.email);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'sign in first' });
    noStore(res);
    // Come back to the page they asked for, not to a generic landing.
    return res.redirect(`/login/?next=${encodeURIComponent(req.originalUrl)}`);
  };

  // The old shapes, from before the dashboard moved under its own prefix.
  app.get('/search', (req, res) => res.redirect(301, `/dashboard/${req.url.slice('/search'.length)}`));
  app.get('/spaces', (_req, res) => res.redirect(301, '/dashboard/spaces/'));
  app.get('/spaces/:floorId', (req, res) => res.redirect(301, `/dashboard/spaces/${encodeURIComponent(req.params.floorId)}`));

  // Every screen under /dashboard/ is routed in the browser, so each of them
  // must serve the shell: a student may open, reload or share any of them.
  app.get(['/dashboard', '/dashboard/', '/dashboard/*'], requireUser, (_req, res) => sendApp(res));
  app.get('/api/me', requireUser, (req, res) => {
    const u = users.get(userOf(req) ?? '');
    res.json({ email: u?.email, name: u?.name });
  });
  app.get('/api/occupancy', requireUser, (_req, res) => res.json(store.view()));
  app.get('/api/search', requireUser, (req, res) => {
    const n = Number(req.query.seats);
    if (!Number.isInteger(n) || n < 1 || n > 30) return res.status(400).json({ error: 'seats must be a whole number 1..30' });
    const floor = typeof req.query.floor === 'string' ? req.query.floor : undefined;
    return res.json({ seats: n, results: searchSeats(store.view().floors, n, floor).slice(0, 20) });
  });

  // The 3D viewer is a tree of ES modules that import each other by relative
  // path, so a query string on the entry point would leave every module it
  // imports on the old copy -- which is exactly how half a deploy reaches a
  // student. The stamp goes in the path instead: /vendor/v<stamp>/... covers
  // the whole tree, and each build is a URL no cache has seen before.
  app.use('/vendor/:stamp', express.static(join(PUBLIC, 'vendor'), {
    index: false,
    setHeaders: (res) => res.set('Cache-Control', 'public, max-age=31536000, immutable'),
  }));

  // Static assets (bundle, photographs, models, icons) are public; the data is not.
  app.use(express.static(PUBLIC, {
    index: false,
    setHeaders: (res, path) => {
      // The bundle's file names carry a content hash and the photographs and
      // floor models never change without their name changing. Anything else
      // must be revalidated, or a student can end up running one half of a
      // deploy against the other.
      const immutable = /\/(app|assets)\//.test(path);
      res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const email = userOf(req);
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !email || !users.get(email)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify(store.view()));
    });
  });

  let pending: NodeJS.Timeout | null = null;
  function broadcast(): void {
    // Several edges pushing at once coalesce into one update.
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const msg = JSON.stringify(store.view());
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
    }, 100);
  }
  // Staleness is time-based, so re-send even without a push.
  setInterval(broadcast, 10_000).unref();

  return { app, server, store, users, sessions };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let cfg: WebConfig;
  try {
    cfg = loadWebConfig();
  } catch (err) {
    console.error(`[web] refusing to start: ${(err as Error).message}`);
    process.exit(2);
  }
  const { server, users } = createWebApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[web] http://${cfg.host}:${cfg.port}  users=${users.size}  sign-up ${cfg.signupOpen ? `open to ${cfg.allowedDomains.join(', ')}` : 'closed'}`);
  });
}
