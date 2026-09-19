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
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createWebApp(cfg: WebConfig) {
  const users = new UserStore(cfg.usersPath, cfg.allowedDomains);
  const sessions = new Sessions(cfg.sessionSecret);
  const store = new SnapshotStore(cfg.staleMs);
  const loginLimiter = new RateLimiter(10, 5 * 60_000);
  const loginPage = readFileSync(join(PUBLIC, 'login.html'), 'utf8');

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
    res.cookie(COOKIE, sessions.issue(email), { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure || req.secure, maxAge: 14 * 24 * 3600 * 1000, path: '/' });
  };
  const renderLogin = (res: Response, opts: { error?: string; email?: string; mode?: 'signin' | 'signup' } = {}, status = 200) => {
    res.status(status).type('html').send(loginPage
      .replaceAll('{{error}}', opts.error ? `<p class="form-error" role="alert">${escapeHtml(opts.error)}</p>` : '')
      .replaceAll('{{email}}', escapeHtml(opts.email ?? ''))
      .replaceAll('{{mode}}', opts.mode ?? 'signin')
      .replaceAll('{{domains}}', escapeHtml(cfg.allowedDomains.map((d) => '@' + d).join(' or ')))
      .replaceAll('{{signup}}', cfg.signupOpen ? '' : 'hidden'));
  };
  // Cross-site form posts: the session cookie is SameSite=Lax, and the auth
  // forms additionally require a same-origin Origin header when one is sent.
  const sameOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).send('cross-origin form post refused');
    return next();
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true, edges: store.edges() }));

  app.get('/login', (req, res) => (userOf(req) ? res.redirect('/') : renderLogin(res)));
  app.get('/signup', (req, res) => (userOf(req) ? res.redirect('/') : renderLogin(res, { mode: 'signup' })));

  const form = express.urlencoded({ extended: false, limit: '4kb' });
  app.post('/login', form, sameOrigin, async (req, res) => {
    const { email = '', password = '' } = req.body as Record<string, string>;
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return renderLogin(res, { error: 'Too many attempts. Wait a few minutes and try again.', email }, 429);
    const user = await users.verify(email, password);
    if (!user) return renderLogin(res, { error: 'That email and password do not match.', email }, 401);
    setSession(req, res, user.email);
    return res.redirect('/');
  });
  app.post('/signup', form, sameOrigin, async (req, res) => {
    if (!cfg.signupOpen) return res.status(403).send('sign-up is closed');
    const { email = '', name = '', password = '' } = req.body as Record<string, string>;
    if (!loginLimiter.allow(req.ip ?? 'unknown')) return renderLogin(res, { error: 'Too many attempts. Wait a few minutes and try again.', email, mode: 'signup' }, 429);
    try {
      const user = await users.create(email, name, password);
      setSession(req, res, user.email);
      return res.redirect('/');
    } catch (err) {
      if (err instanceof AuthError) return renderLogin(res, { error: err.message, email, mode: 'signup' }, 400);
      throw err;
    }
  });
  app.post('/logout', sameOrigin, (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/login');
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
    const email = userOf(req);
    if (email && users.get(email)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'sign in first' });
    return res.redirect('/login');
  };

  app.get('/', requireUser, (_req, res) => res.sendFile(join(PUBLIC, 'index.html')));
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

  // Static assets (css, js, icons) are public; the data is not.
  app.use(express.static(PUBLIC, { index: false }));

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
