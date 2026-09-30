/** The web composition root: configuration, dependencies, static files and server lifecycle. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createStudentAuthRouter, createRequireStudent } from '../modules/student-auth/routes/student-auth-router.js';
import { JsonStudentAccountRepository } from '../infrastructure/web/json-student-account-repository.js';
import { createOccupancyRouter } from '../modules/occupancy/routes/occupancy-router.js';
import { OccupancyWebSocketLifecycle } from '../modules/occupancy/application/occupancy-websocket-lifecycle.js';
import { parseCookies, Sessions } from '../modules/student-auth/application/student-session-service.js';
import { SnapshotStore } from './store.js';

export { asEmail } from '../modules/student-auth/routes/student-auth-router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-web');

export interface WebConfig {
  port: number;
  host: string;
  pushToken: string;
  sessionSecret: Buffer;
  usersPath: string;
  allowedDomains: string[];
  signupOpen: boolean;
  cookieSecure: boolean;
  /** Which proxies may set X-Forwarded-* headers. */
  trustProxy: boolean | string;
  staleMs: number;
}

/** Loads and validates environment-backed student web configuration. */
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
    allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean),
    signupOpen: env.SIGNUP_OPEN !== '0',
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === '0' ? false : env.TRUST_PROXY === '1' ? true : env.TRUST_PROXY,
    staleMs: Number(env.STALE_MS || 30_000),
  };
}

/** Creates the student web app and its explicitly disposable server components. */
export function createWebApp(cfg: WebConfig) {
  const accounts = new JsonStudentAccountRepository(cfg.usersPath, cfg.allowedDomains);
  const sessions = new Sessions(cfg.sessionSecret);
  const store = new SnapshotStore(cfg.staleMs);
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store').set('Vary', 'Cookie');
  const authDependencies = {
    accounts, sessions, allowedDomains: cfg.allowedDomains, signupOpen: cfg.signupOpen,
    cookieSecure: cfg.cookieSecure, noStore,
  };
  const requireStudent = createRequireStudent(authDependencies);
  const appPage = readFileSync(join(PUBLIC, 'index.html'), 'utf8').replaceAll('{{v}}', assetVersion());
  const app = createExpressApp(cfg);
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, edges: store.edges() }));
  app.get('/', (req, res) => redirectBySession(req, res, sessions, noStore));
  app.get(['/login', '/login/', '/signup', '/signup/'], (req, res) => sendAuthPage(req, res, sessions, cfg.signupOpen, noStore, appPage));
  app.use(createStudentAuthRouter(authDependencies));
  app.use(createOccupancyRouter({ store, pushToken: cfg.pushToken, requireStudent, onSnapshot: () => sockets.broadcast() }));
  app.use(createStudentPageRouter({ requireStudent, noStore, appPage }));
  app.use(createStaticAssetRouter());
  const server = createServer(app);
  const sockets = new OccupancyWebSocketLifecycle(server, store, sessions, accounts);
  return { app, server, store, users: accounts, sessions, dispose: () => sockets.dispose() };
}

function createExpressApp(cfg: WebConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy === true ? 'loopback' : cfg.trustProxy);
  return app;
}

function redirectBySession(req: Request, res: Response, sessions: Sessions, noStore: (res: Response) => void): void {
  noStore(res);
  const email = sessions.read(parseCookies(req.headers.cookie).tm_session);
  res.redirect(email ? '/dashboard/' : '/login/');
}

function sendAuthPage(req: Request, res: Response, sessions: Sessions, signupOpen: boolean, noStore: (res: Response) => void, page: string): void {
  if (sessions.read(parseCookies(req.headers.cookie).tm_session)) {
    noStore(res);
    res.redirect(safeNext(req.query.next));
    return;
  }
  if (req.path.startsWith('/signup') && !signupOpen) {
    noStore(res);
    res.redirect('/login/');
    return;
  }
  noStore(res);
  res.status(200).type('html').send(page);
}

function createStudentPageRouter(dependencies: {
  requireStudent: express.RequestHandler;
  noStore(res: Response): void;
  appPage: string;
}): express.Router {
  const router = express.Router();
  router.get('/search', (req, res) => res.redirect(301, `/dashboard/${req.url.slice('/search'.length)}`));
  router.get('/spaces', (_req, res) => res.redirect(301, '/dashboard/spaces/'));
  router.get('/spaces/:floorId', (req, res) => res.redirect(301, `/dashboard/spaces/${encodeURIComponent(req.params.floorId)}`));
  router.get(['/dashboard', '/dashboard/', '/dashboard/*'], dependencies.requireStudent, (_req, res) => {
    dependencies.noStore(res);
    res.status(200).type('html').send(dependencies.appPage);
  });
  return router;
}

function createStaticAssetRouter(): express.Router {
  const router = express.Router();
  router.use('/vendor/:stamp', express.static(join(PUBLIC, 'vendor'), {
    index: false,
    setHeaders: (res) => res.set('Cache-Control', 'public, max-age=31536000, immutable'),
  }));
  router.use(express.static(PUBLIC, {
    index: false,
    setHeaders: (res, path) => {
      const immutable = /\/(app|assets)\//.test(path);
      res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  return router;
}

function assetVersion(): string {
  const hash = createHash('sha256');
  for (const file of ['vendor/floor-viewer.js']) {
    try {
      const stats = statSync(join(PUBLIC, file));
      hash.update(`${file}:${stats.size}:${stats.mtimeMs}`);
    } catch {
      hash.update(`${file}:missing`);
    }
  }
  return hash.digest('hex').slice(0, 10);
}

function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard/';
  if (raw.startsWith('/login') || raw.startsWith('/signup')) return '/dashboard/';
  return raw;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let cfg: WebConfig;
  try {
    cfg = loadWebConfig();
  } catch (error) {
    console.error(`[web] refusing to start: ${(error as Error).message}`);
    process.exit(2);
  }
  const web = createWebApp(cfg);
  web.server.listen(cfg.port, cfg.host, () => {
    console.log(`[web] http://${cfg.host}:${cfg.port}  users=${web.users.size}  sign-up ${cfg.signupOpen ? `open to ${cfg.allowedDomains.join(', ')}` : 'closed'}`);
  });
  const stop = () => {
    void web.dispose().finally(() => web.server.close());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
