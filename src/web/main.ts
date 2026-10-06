/** The web composition root: configuration, dependencies, static files and server lifecycle. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createStudentAuthRouter, createRequireStudent } from '../modules/student-auth/routes/student-auth-router.js';
import { JsonStudentAccountRepository } from '../infrastructure/web/json-student-account-repository.js';
import { createOccupancyRouter } from '../modules/occupancy/routes/occupancy-router.js';
import { OccupancyWebSocketLifecycle } from '../modules/occupancy/application/occupancy-websocket-lifecycle.js';
import { parseCookies, Sessions, studentSessionVersion } from '../modules/student-auth/application/student-session-service.js';
import { SnapshotStore } from './store.js';
import type { IStudentAccountRepository } from '../modules/student-auth/repositories/student-account-repository.js';
import type { StudentActivityLog } from '../modules/student-auth/application/student-activity-log.js';
import { studentHttpErrorHandler } from '../infrastructure/web/student-http-errors.js';
import { loadPostgresConnectionConfig, type PostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { openStudentPostgresStorage } from '../infrastructure/web/student-postgres-storage.js';
import { StudentUsageActivity } from '../modules/student-auth/application/student-usage-activity.js';
import { createStudentUsageRouter } from '../modules/student-auth/routes/student-usage-router.js';
import { SnapshotPublishers } from './publishers.js';
import { GoogleError, googleFromEnv, GoogleLogin } from './google.js';
import { turnstileCheck, turnstileFromEnv, type HumanCheck } from './auth.js';
import { safeNext } from './navigation.js';
export { safeNext } from './navigation.js';

export { asEmail } from '../modules/student-auth/routes/student-auth-router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = join(ROOT, 'public-web');
const GOOGLE_COOKIE = 'tm_google_attempt';
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
  /** Which proxies may set X-Forwarded-* headers. */
  trustProxy: boolean | string;
  staleMs: number;
  turnstile?: { siteKey: string; secretKey: string; hostnames: string[]; check?: HumanCheck } | null;
  google?: ReturnType<typeof googleFromEnv>;
  studentPersistenceMode?: 'file' | 'postgres';
  studentPostgres?: PostgresConnectionConfig;
  activityRetentionDays?: number;}

/** Loads and validates environment-backed student web configuration. */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const publishers = env.WEB_EDGE_KEYS_FILE ? SnapshotPublishers.fromFile(env.WEB_EDGE_KEYS_FILE) : undefined;
  const pushToken = env.WEB_PUSH_TOKEN ?? '';
  if (!publishers && pushToken.length < 16) throw new Error('WEB_PUSH_TOKEN must be set (16+ chars): it is how edges authenticate their snapshots');
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars): it signs login sessions');
  // 8080: what the README, docker-compose, the edge's WEB_PUSH_URLS and the
  // production units all assume. An unset (or empty) WEB_PORT means that port.
  const port = Number(env.WEB_PORT || 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('WEB_PORT must be an integer 1..65535');
  const staleMs = Number(env.STALE_MS ?? 30_000);
  if (!Number.isSafeInteger(staleMs) || staleMs < 1000 || staleMs > 3_600_000) throw new Error('STALE_MS must be an integer 1000..3600000');
  if (env.SIGNUP_OPEN !== undefined && env.SIGNUP_OPEN !== '0' && env.SIGNUP_OPEN !== '1') throw new Error('SIGNUP_OPEN must be 0 or 1');
  const studentPersistenceMode = env.STUDENT_PERSISTENCE_MODE ?? 'file';
  if (studentPersistenceMode !== 'file' && studentPersistenceMode !== 'postgres') throw new Error('STUDENT_PERSISTENCE_MODE must be file or postgres');
  const activityRetentionDays = Number(env.STUDENT_ACTIVITY_RETENTION_DAYS ?? 90);
  if (!Number.isSafeInteger(activityRetentionDays) || activityRetentionDays < 1 || activityRetentionDays > 3650) {
    throw new Error('STUDENT_ACTIVITY_RETENTION_DAYS must be an integer 1..3650');
  }
  const turnstile = turnstileFromEnv(env);
  return {
    port,
    host: env.WEB_HOST || '0.0.0.0',
    pushToken, publishers,
    sessionSecret: Buffer.from(secret),
    usersPath: env.USERS_FILE || join(env.DATA_DIR || 'data', 'users.json'),
    allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean),
    signupOpen: env.SIGNUP_OPEN === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === '0' ? false : env.TRUST_PROXY === '1' ? true : env.TRUST_PROXY,
    staleMs,
    turnstile,
    google: googleFromEnv(env),
    studentPersistenceMode,
    studentPostgres: studentPersistenceMode === 'postgres' ? loadPostgresConnectionConfig('runtime', env) : undefined,
    activityRetentionDays,
  };
}

export interface WebAppInstance<TAccounts extends IStudentAccountRepository> {
  app: express.Express;
  server: Server;
  store: SnapshotStore;
  users: TAccounts;
  sessions: Sessions;
  activity: StudentActivityLog | undefined;
  dispose(): Promise<void>;
}

/** Creates the student web app and its explicitly disposable server components. */
export function createWebApp(cfg: WebConfig, options?: {
  accounts?: JsonStudentAccountRepository;
  activity?: StudentActivityLog;
  closePersistence?: () => Promise<void>;
}): WebAppInstance<JsonStudentAccountRepository>;
export function createWebApp(cfg: WebConfig, options: {
  accounts?: IStudentAccountRepository;
  activity?: StudentActivityLog;
  closePersistence?: () => Promise<void>;
}): WebAppInstance<IStudentAccountRepository>;
export function createWebApp(cfg: WebConfig, options: {
  accounts?: IStudentAccountRepository;
  activity?: StudentActivityLog;
  closePersistence?: () => Promise<void>;
} = {}): WebAppInstance<IStudentAccountRepository> {
  if (cfg.studentPersistenceMode === 'postgres' && !options.accounts) throw new Error('PostgreSQL student accounts must be initialized before creating the web app');
  const accounts = options.accounts ?? new JsonStudentAccountRepository(cfg.usersPath, cfg.allowedDomains);
  const sessions = new Sessions(cfg.sessionSecret, undefined, join(dirname(cfg.usersPath), 'session-revocations.json'));
  let sockets!: OccupancyWebSocketLifecycle;
  // Google identities are intentionally unavailable with PostgreSQL-backed
  // student accounts until that storage path has its own verified rollout.
  const googleEnabled = cfg.studentPersistenceMode !== 'postgres' && !!cfg.google;
  const google = googleEnabled && cfg.google ? new GoogleLogin(cfg.google, cfg.sessionSecret) : null;
  const store = new SnapshotStore(cfg.staleMs);
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store').set('Vary', 'Cookie');
  const authDependencies = {
    accounts, sessions, allowedDomains: cfg.allowedDomains, signupOpen: cfg.signupOpen,
    cookieSecure: cfg.cookieSecure, noStore,
    humanCheck: cfg.turnstile ? cfg.turnstile.check ?? turnstileCheck(cfg.turnstile.secretKey, cfg.turnstile.hostnames) : null,
    onLogout: (token: string | undefined) => sockets?.closeSession(token),
    activity: options.activity,
  };
  const requireStudent = createRequireStudent(authDependencies);
  const usage = new StudentUsageActivity(() => store.view(), options.activity);
  const appPage = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
    .replaceAll('{{v}}', assetVersion())
    .replaceAll('{{turnstile}}', cfg.turnstile?.siteKey ?? '')
    .replaceAll('{{google}}', google ? 'on' : '');
  const app = createExpressApp(cfg);
  const cfSource = cfg.turnstile ? ' https://challenges.cloudflare.com' : '';
  const csp = `default-src 'self'; script-src 'self'${cfSource}; frame-src ${cfg.turnstile ? `'self'${cfSource}` : "'none'"}; img-src 'self' data:; ` +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });
  app.get('/index.html', (req, res) => redirectBySession(req, res, sessions, noStore));
  app.get('/healthz', (_req, res) => res.json({ ok: true, edges: store.edges() }));
  app.get('/readyz', async (_req, res) => {
    try {
      await accounts.count();
      res.json({ ready: true, accounts: cfg.studentPersistenceMode ?? 'file', activity: options.activity?.stats() ?? null });
    } catch {
      res.status(503).json({ ready: false, accounts: cfg.studentPersistenceMode ?? 'file', activity: options.activity?.stats() ?? null });
    }
  });
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
  app.get('/auth/google/callback', async (req, res) => {
    noStore(res);
    if (!google) return res.status(404).json({ error: 'Google sign-in is not enabled' });
    if (!accounts.google) return res.redirect('/login/?error=google');
    res.clearCookie(GOOGLE_COOKIE, { path: '/auth/google' });
    try {
      const identity = await google.finish(req.query, parseCookies(req.headers.cookie)[GOOGLE_COOKIE]);
      const user = await accounts.google(identity, cfg.signupOpen);
      options.activity?.record('login', 'succeeded', user.id ?? null, randomUUID());
      res.cookie('tm_session', sessions.issue(user.email, Date.now(), studentSessionVersion(user)), {
        httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure || req.secure, maxAge: sessions.ttl, path: '/',
      });
      return res.redirect(safeNext(identity.next));
    } catch (error) {
      if (error instanceof GoogleError) return res.redirect(`/login/?error=${error.code === 'cancelled' ? 'google_cancelled' : 'google'}`);
      return res.redirect(`/login/?error=${error instanceof Error && error.message.includes('closed') ? 'google_closed' : 'google_taken'}`);
    }
  });
  app.get('/', (req, res) => redirectBySession(req, res, sessions, noStore));
  app.get(['/login', '/login/', '/signup', '/signup/'], (req, res) => sendAuthPage(req, res, sessions, cfg.signupOpen, noStore, appPage));
  app.use(createStudentAuthRouter(authDependencies));
  app.use(createOccupancyRouter({ store, pushToken: cfg.pushToken, publishers: cfg.publishers, requireStudent, usage, onSnapshot: () => sockets.broadcast() }));
  app.use(createStudentUsageRouter({ requireStudent, usage }));
  app.use(createStudentPageRouter({ requireStudent, noStore, appPage }));
  app.use(createStaticAssetRouter());
  app.use(studentHttpErrorHandler(options.activity));
  const server = createServer(app);
  sockets = new OccupancyWebSocketLifecycle(server, store, sessions, accounts);
  options.activity?.start();
  let disposal: Promise<void> | null = null;
  const dispose = () => {
    disposal ??= (async () => {
      try { await sockets.dispose(); } finally {
        try { await options.activity?.dispose(); } finally { await options.closePersistence?.(); }
      }
    })();
    return disposal;  };
  return { app, server, store, users: accounts, sessions, activity: options.activity, dispose };
}

/** Async production composition; file-mode factories remain synchronous for existing callers. */
export async function createConfiguredWebApp(cfg: WebConfig) {
  if (cfg.studentPersistenceMode !== 'postgres') return createWebApp(cfg);
  if (!cfg.studentPostgres) throw new Error('PostgreSQL student configuration is missing');
  const storage = await openStudentPostgresStorage(cfg.studentPostgres, cfg.allowedDomains, cfg.activityRetentionDays);
  try { return createWebApp(cfg, storage); } catch (error) {
    await storage.activity.dispose();
    await storage.closePersistence();
    throw error;
  }
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
  router.get(['/dashboard', '/dashboard/', '/dashboard/{*splat}'], dependencies.requireStudent, (_req, res) => {
    dependencies.noStore(res);
    res.status(200).type('html').send(dependencies.appPage);  });
  return router;
}

function createStaticAssetRouter(): express.Router {
  const router = express.Router();
  router.use('/vendor/:stamp', express.static(join(PUBLIC, 'vendor'), {
    index: false,
    setHeaders: (res) => res.set('Cache-Control', 'public, max-age=31536000, immutable'),
  }));
  router.use(express.static(PUBLIC, {    index: false,
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
export function missingAppAssets(publicDir: string = PUBLIC): string[] {
  let shell: string;
  try { shell = readFileSync(join(publicDir, 'index.html'), 'utf8'); } catch { return ['index.html']; }
  const missing: string[] = [];
  for (const match of shell.matchAll(/(?:src|href)=["'](\/app\/[^"'?#]+)/g)) {
    const asset = match[1];
    if (asset && !existsSync(join(publicDir, asset))) missing.push(asset);
  }
  return missing;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const cfg = loadWebConfig();
    const web = await createConfiguredWebApp(cfg);
    let count: number;
    try {
      count = await web.users.count();
      await new Promise<void>((resolve, reject) => {
        web.server.once('error', reject);
        web.server.listen(cfg.port, cfg.host, resolve);
      });
    } catch (error) {
      await web.dispose();
      throw error;
    }
    process.stdout.write(`[web] http://${cfg.host}:${cfg.port} users=${count} student-storage=${cfg.studentPersistenceMode} sign-up=${cfg.signupOpen ? 'open' : 'closed'}\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      web.server.close();
      void web.dispose().catch(() => {
        process.stderr.write('[web] storage shutdown failed\n');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`[web] refusing to start: ${error instanceof Error ? error.message : 'configuration or storage failure'}\n`);
    process.exitCode = 2;
  }
}
