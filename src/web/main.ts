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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { searchSeats } from '../shared/seats.js';
import { AuthBusyError, AuthError, parseCookies, RateLimiter, Sessions, turnstileCheck, turnstileFromEnv, UserStore, type HumanCheck } from './auth.js';
import { GoogleError, googleFromEnv, GoogleLogin, type GoogleConfig } from './google.js';
import { SnapshotPublishers } from './publishers.js';
import { isSnapshot, SnapshotStore } from './store.js';
import { safeNext } from './navigation.js';
export { safeNext } from './navigation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-web');
const COOKIE = 'tm_session';
/** One Google sign-in attempt in flight; see google.ts. */
const GOOGLE_COOKIE = 'tm_google';

export interface WebConfig {
  port: number;
  host: string;
  pushToken: string;
  publishers?: SnapshotPublishers;
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
  /**
   * Cloudflare Turnstile on sign-in and sign-up, or absent for none (the LAN,
   * tests). The site key is public and goes to the browser; the secret only
   * ever goes to siteverify. `check` replaces the call to Cloudflare in tests.
   */
  turnstile?: { siteKey: string; secretKey: string; hostnames: string[]; check?: HumanCheck } | null;
  /** "Continue with Google", or absent for none. */
  google?: GoogleConfig | null;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const publishers = env.WEB_EDGE_KEYS_FILE ? SnapshotPublishers.fromFile(env.WEB_EDGE_KEYS_FILE) : undefined;
  const pushToken = env.WEB_PUSH_TOKEN ?? '';
  if (!publishers && pushToken.length < 16) throw new Error('WEB_PUSH_TOKEN must be set (16+ chars): it is how edges authenticate their snapshots');
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars): it signs login sessions');
  const port = Number(env.WEB_PORT || 8080);
  const staleMs = Number(env.STALE_MS || 30_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT must be an integer 1..65535');
  if (!Number.isFinite(staleMs) || staleMs < 1000 || staleMs > 3600_000) throw new Error('STALE_MS must be 1000..3600000');
  if (env.SIGNUP_OPEN && env.SIGNUP_OPEN !== '0' && env.SIGNUP_OPEN !== '1') throw new Error('SIGNUP_OPEN must be 0 or 1');
  return {
    port,
    host: env.WEB_HOST || '0.0.0.0',
    pushToken, publishers,
    sessionSecret: Buffer.from(secret),
    usersPath: env.USERS_FILE || join(env.DATA_DIR || 'data', 'users.json'),
    allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    // An unverified email suffix does not establish university membership.
    signupOpen: env.SIGNUP_OPEN === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === '0' ? false : env.TRUST_PROXY === '1' ? true : env.TRUST_PROXY,
    staleMs,
    turnstile: turnstileFromEnv(env),
    google: googleFromEnv(env),
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
  const files = ['vendor/floor-viewer.js', 'vendor/three/three.module.js', 'vendor/three/GLTFLoader.js',
    'vendor/three/OrbitControls.js', 'vendor/three/BufferGeometryUtils.js'];
  const h = createHash('sha256');
  for (const f of files) {
    try {
      h.update(`${f}:`);
      h.update(readFileSync(join(PUBLIC, f)));
    } catch {
      h.update(`${f}:missing`);   // not built yet: still a stable stamp
    }
  }
  return h.digest('hex').slice(0, 10);
}

/**
 * Build output the shell asks for but this checkout does not have.
 *
 * `public-web/index.html` is tracked; the bundle it points at lives in
 * `public-web/app/`, which is build output and git-ignored. On a fresh clone
 * the page would load, 404 its module and sit there blank, so the entry point
 * asks this first and says what to run instead. Only `/app/` is checked: the
 * photographs, floor models and three.js under `/assets/` and `/vendor/` are
 * tracked, so they are always there.
 */
export function missingAppAssets(publicDir: string = PUBLIC): string[] {
  let shell: string;
  try {
    shell = readFileSync(join(publicDir, 'index.html'), 'utf8');
  } catch {
    return ['index.html'];
  }
  const missing: string[] = [];
  for (const m of shell.matchAll(/(?:src|href)=["'](\/app\/[^"'?#]+)/g)) {
    const asset = m[1];
    if (asset && !existsSync(join(publicDir, asset))) missing.push(asset);
  }
  return missing;
}

/**
 * Where to send a student after signing in. Only a path on this site: an
 * absolute URL, or the "//host" form a browser also reads as one, would turn
 * our sign-in page into somebody else's redirector.
 */
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

function sameWebOrigin(origin: string, protocol: string | undefined, host: string | undefined): boolean {
  try {
    const url = new URL(origin);
    return !!host && (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
      url.origin === new URL(`${protocol ?? 'http'}://${host}`).origin;
  } catch { return false; }
}

export function createWebApp(cfg: WebConfig) {
  const users = new UserStore(cfg.usersPath, cfg.allowedDomains);
  const sessions = new Sessions(cfg.sessionSecret, undefined, join(dirname(cfg.usersPath), 'session-revocations.json'), email => {
    const u = users.get(email);
    return u ? createHmac('sha256', cfg.sessionSecret).update(JSON.stringify([u.email, u.hash, u.salt, u.google ?? '', u.createdAt])).digest('base64url') : null;
  });
  const store = new SnapshotStore(cfg.staleMs);
  const loginLimiter = new RateLimiter(10, 5 * 60_000);
  const version = assetVersion();
  // One shell for every screen; the React app decides which one to draw.
  const turnstile = cfg.turnstile ?? null;
  const isHuman = turnstile ? turnstile.check ?? turnstileCheck(turnstile.secretKey, turnstile.hostnames) : null;
  // The shell tells the app whether to draw the widget: an empty key means off.
  const appPage = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
    .replaceAll('{{v}}', version)
    .replaceAll('{{turnstile}}', turnstile?.siteKey ?? '')
    .replaceAll('{{google}}', cfg.google ? 'on' : '');
  const google = cfg.google ? new GoogleLogin(cfg.google, cfg.sessionSecret) : null;
  // Turnstile is a script plus an iframe from Cloudflare. Allow exactly that
  // origin, and only when it is switched on.
  const cf = turnstile ? ' https://challenges.cloudflare.com' : '';
  const csp = `default-src 'self'; script-src 'self'${cf}; frame-src${cf || " 'none'"}; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

  const app = express();
  app.disable('x-powered-by');
  // Behind Cloudflare Tunnel the proxy is cloudflared on this machine: trust
  // X-Forwarded-* (client IP for the login limiter, https for the cookie)
  // only from loopback, never from anyone who can reach the port directly.
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy === true ? 'loopback' : cfg.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  const userOf = (req: IncomingMessage) => {
    const email = sessions.read(parseCookies(req.headers.cookie)[COOKIE]);
    return email && users.get(email) ? email : null;
  };
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
    // Compare scheme as well as host; Origin: null and malformed URLs fail
    // closed instead of throwing from request middleware.
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && !sameWebOrigin(origin, req.protocol, req.get('host')))) {
      return res.status(403).json({ error: 'cross-origin post refused' });
    }
    return next();
  };
  /**
   * Turnstile, after the limiter: the limiter costs nothing, so a flood is
   * turned away before it makes us call Cloudflare once per request. The
   * action ties the token to the form it was solved on.
   */
  const human = async (req: Request, action: string): Promise<boolean> => {
    if (!isHuman) return true;
    const token = (req.body as Record<string, unknown>)['cf-turnstile-response'];
    return typeof token === 'string' && isHuman(token, action, req.ip);
  };
  const notHuman = { error: 'Please complete the verification and try again.' };

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

  const body = [express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 20 })];
  // Express 4 does not forward rejected promises to its error middleware.
  const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => { void Promise.resolve().then(() => handler(req, res)).catch(next); };
  const credentials = (v: unknown): v is Record<string, string> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const b = v as Record<string, unknown>;
    return typeof b.email === 'string' && b.email.length <= 254 && typeof b.password === 'string' && b.password.length <= 1024 &&
      (b.name === undefined || (typeof b.name === 'string' && b.name.length <= 200));
  };
  app.post('/login', body, sameOrigin, asyncRoute(async (req: Request, res: Response) => {
    noStore(res);
    if (!credentials(req.body)) return res.status(400).json({ error: 'Enter a valid email and password.' });
    const { email: raw = '', password = '', next } = req.body;
    const email = asEmail(raw, cfg.allowedDomains);
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    if (!(await human(req, 'login'))) return res.status(403).json(notHuman);
    const user = await users.verify(email, password);
    if (!user) return res.status(401).json({ error: 'That UID and PIN do not match.' });
    setSession(req, res, user.email);
    return res.json({ redirect: safeNext(next) });
  }));
  app.post('/signup', body, sameOrigin, asyncRoute(async (req: Request, res: Response) => {
    noStore(res);
    if (!cfg.signupOpen) return res.status(403).json({ error: 'Sign-up is closed.' });
    if (!credentials(req.body)) return res.status(400).json({ error: 'Enter a valid email, name and password.' });
    const { email: raw = '', name = '', password = '', next } = req.body;
    const email = asEmail(raw, cfg.allowedDomains);
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    if (!(await human(req, 'signup'))) return res.status(403).json(notHuman);
    try {
      const user = await users.create(email, name, password);
      setSession(req, res, user.email);
      return res.json({ redirect: safeNext(next) });
    } catch (err) {
      if (err instanceof AuthBusyError) throw err;
      if (err instanceof AuthError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }));
  /**
   * Google sign-in. No Turnstile here: the button is a plain link, nothing is
   * posted, and Google runs its own checks on the person before we ever see
   * them. The limiter still guards the callback, which costs a call to Google.
   * The attempt cookie is scoped to /auth/google and SameSite=Lax, which a
   * top-level redirect back from accounts.google.com still carries.
   */
  app.get('/auth/google', (req, res) => {
    noStore(res);
    if (!google) return res.status(404).json({ error: 'Google sign-in is not enabled' });
    const { url, cookie } = google.begin(safeNext(req.query.next));
    res.cookie(GOOGLE_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure || req.secure, maxAge: 10 * 60_000, path: '/auth/google' });
    return res.redirect(url);
  });
  app.get('/auth/google/callback', asyncRoute(async (req, res) => {
    noStore(res);
    if (!google) return res.status(404).json({ error: 'Google sign-in is not enabled' });
    res.clearCookie(GOOGLE_COOKIE, { path: '/auth/google' });   // single use, whatever happens next
    const refused = (code: string) => res.redirect(`/login/?error=${code}`);
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return refused('google_busy');
    try {
      const id = await google.finish(req.query, parseCookies(req.headers.cookie)[GOOGLE_COOKIE]);
      const user = users.google(id, cfg.signupOpen);
      setSession(req, res, user.email);
      return res.redirect(safeNext(id.next));
    } catch (err) {
      if (err instanceof GoogleError) {
        // Say why in the log; the student just gets "try again".
        if (err.code !== 'cancelled') console.warn(`[web] google sign-in refused: ${err.reason}`);
        return refused(err.code === 'cancelled' ? 'google_cancelled' : 'google');
      }
      if (err instanceof AuthError) return refused(err.message.startsWith('Sign-up') ? 'google_closed' : 'google_taken');
      throw err;
    }
  }));

  app.post('/logout', body, sameOrigin, (_req: Request, res: Response) => {
    const token = parseCookies(_req.headers.cookie)[COOKIE];
    sessions.revoke(token);
    for (const [ws, client] of clients) if (client.token === token) ws.terminate();
    res.clearCookie(COOKIE, { path: '/' });
    noStore(res);
    res.json({ redirect: '/login/' });
  });

  // The edge's push. Bearer token, compared in constant time.
  app.post('/api/edge/snapshot', express.json({ limit: '2mb' }), (req, res) => {
    const got = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cfg.pushToken);
    const authenticated = cfg.publishers ? cfg.publishers.authenticate(req.body?.edgeId, got) : got.length === want.length && timingSafeEqual(got, want);
    if (!authenticated) return res.status(401).json({ error: 'bad edge token' });
    if (!isSnapshot(req.body)) return res.status(400).json({ error: 'not an occupancy snapshot' });
    if (cfg.publishers && !cfg.publishers.authorizes(req.body)) return res.status(403).json({ error: 'edge is not authorized for these floors' });
    if (!store.put(req.body)) return res.status(503).json({ error: 'snapshot store is full' });
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
  // Identity and occupancy must never be stored by a shared proxy.
  app.use('/api', (_req, res, next) => { noStore(res); next(); });
  app.get('/api/me', requireUser, (req, res) => {
    const u = users.get(userOf(req) ?? '');
    res.json({ email: u?.email, name: u?.name });
  });
  app.get('/api/occupancy', requireUser, (_req, res) => res.json(store.view()));
  /**
   * Seat-level suggestions, for API clients. The bundled student app does not
   * call this: it computes its own answer from the live snapshot with the
   * shared `allocate()` (table runs) so the list and the plan beside it cannot
   * disagree. Keep the two rules in step if either changes.
   */
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

  app.get('/index.html', (_req, res) => { noStore(res); res.redirect('/'); });

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

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof AuthBusyError) { noStore(res); return res.status(429).json({ error: err.message }); }
    const status = (err as { status?: number })?.status;
    const clientError = status === 400 || status === 413 || status === 415;
    if (!clientError) console.error(`[web] request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    noStore(res);
    return res.status(clientError ? status : 500).json({ error: clientError ? 'Invalid request body.' : 'Request failed. Try again.' });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map<WebSocket, { email: string; expiresAt: number; token: string; alive: boolean }>();
  const refuseUpgrade = (socket: import('node:stream').Duplex, status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (req, socket, head) => {
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { return refuseUpgrade(socket, 400, 'Bad Request'); }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const detail = sessions.detail(token);
    if (path !== '/ws' || !detail || !users.get(detail.email)) return refuseUpgrade(socket, 401, 'Unauthorized');
    // Mirror Express's request setup so its configured trusted-proxy protocol
    // calculation applies to an HTTPS tunnel's upgrade requests too.
    Object.setPrototypeOf(req, app.request);
    const protocol = (req as Request).protocol;
    if (req.headers.origin && !sameWebOrigin(req.headers.origin, protocol, req.headers.host)) return refuseUpgrade(socket, 403, 'Forbidden');
    if (clients.size >= 1000 || [...clients.values()].filter((c) => c.email === detail.email).length >= 10) return refuseUpgrade(socket, 429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, { ...detail, token: token!, alive: true });
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => ws.terminate());
      ws.on('pong', () => { const client = clients.get(ws); if (client) client.alive = true; });
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
      for (const [ws, client] of clients) {
        if (!sessions.read(client.token) || !users.get(client.email)) { ws.terminate(); continue; }
        // A stalled reader must not queue an unlimited campus history in RAM.
        if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); continue; }
        if (ws.readyState === ws.OPEN) ws.send(msg);
      }
    }, 100);
    pending.unref();
  }
  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  // Staleness is time-based, so re-send even without a push.
  const freshness = setInterval(broadcast, 10_000);
  freshness.unref();
  server.on('close', () => {
    clearInterval(freshness);
    clearInterval(heartbeat);
    if (pending) clearTimeout(pending);
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
  });

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
  // A tier that answers the API but serves a page that cannot load is worse
  // than one that says why it will not start: the failure is otherwise a blank
  // screen and a 404 in a browser console nobody is watching.
  const missing = missingAppAssets();
  if (missing.length > 0) {
    console.error(`[web] refusing to start: the student app is not built (missing ${missing.join(', ')}). Run \`npm run build\` first.`);
    process.exit(2);
  }
  const { server, users } = createWebApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[web] http://${cfg.host}:${cfg.port}  users=${users.size}  sign-up ${cfg.signupOpen ? `open to ${cfg.allowedDomains.join(', ')}` : 'closed'}  turnstile ${cfg.turnstile ? 'on' : 'off'}  google ${cfg.google ? 'on' : 'off'}`);
  });
}
