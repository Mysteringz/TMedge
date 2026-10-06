import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { IStudentAccountRepository } from '../repositories/student-account-repository.js';
import { AuthError, parseCookies, RateLimiter, Sessions, studentSessionVersion, type HumanCheck } from '../application/student-session-service.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import type { StudentActivityLog } from '../application/student-activity-log.js';
import type { StudentActivityAction, StudentActivityOutcome } from '../repositories/student-activity-repository.js';

const COOKIE = 'tm_session';

export interface StudentAuthRouterDependencies {
  accounts: IStudentAccountRepository;
  sessions: Sessions;
  allowedDomains: readonly string[];
  signupOpen: boolean;
  cookieSecure: boolean;
  noStore(res: Response): void;
  activity?: StudentActivityLog;
  humanCheck?: HumanCheck | null;
  onLogout?: (token: string | undefined) => void;
}

/** Creates the existing student session and account HTTP endpoints. */
export function createStudentAuthRouter(dependencies: StudentAuthRouterDependencies): Router {
  const router = Router();
  const limiter = new RateLimiter(10, 5 * 60_000);
  const body = [express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb' })];
  const requireUser = createRequireStudent(dependencies);
  router.post('/login', body, sameOrigin, createLoginHandler(dependencies, limiter));
  router.post('/signup', body, sameOrigin, createSignupHandler(dependencies, limiter));
  router.post('/logout', body, sameOrigin, asyncHandler(async (req: Request, res: Response) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const email = userOf(req, dependencies.sessions);
    dependencies.sessions.revoke(token);
    dependencies.onLogout?.(token);
    res.clearCookie(COOKIE, { path: '/' });
    dependencies.noStore(res);
    const user = email ? await findActivityUser(dependencies, email) : undefined;
    recordActivity(dependencies, 'logout', 'succeeded', user?.id);
    res.json({ redirect: '/login/' });
  }));
  router.get('/api/me', requireUser, asyncHandler(async (req, res) => {
    const user = await dependencies.accounts.get(userOf(req, dependencies.sessions) ?? '');
    res.json({ email: user?.email, name: user?.name });
  }));
  return router;
}

/** Builds the shared browser/API session guard while preserving cookie renewal. */
export function createRequireStudent(dependencies: StudentAuthRouterDependencies): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    dependencies.noStore(res);
    const detail = dependencies.sessions.detail(parseCookies(req.headers.cookie)[COOKIE]);
    const user = detail ? await dependencies.accounts.get(detail.email) : undefined;
    if (detail && user && detail.version === studentSessionVersion(user)) {
      res.locals.studentUserId = user.id;
      if (detail.expiresAt - Date.now() < dependencies.sessions.ttl / 2) await setSession(req, res, detail.email, dependencies);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'sign in first' });
    dependencies.noStore(res);
    return res.redirect(`/login/?next=${encodeURIComponent(req.originalUrl)}`);
  });
}

/** Resolves a session cookie to its account email. */
export function userOf(req: Request, sessions: Sessions): string | null {
  return sessions.read(parseCookies(req.headers.cookie)[COOKIE]);
}

function createLoginHandler(deps: StudentAuthRouterDependencies, limiter: RateLimiter): RequestHandler {
  return asyncHandler(async (req, res) => {
    deps.noStore(res);
    const input = authInput(req.body);
    if (!input) {
      recordActivity(deps, 'login', 'failed');
      return res.status(400).json({ error: 'email and password must be strings' });
    }
    if (!limiter.allow(req.ip ?? 'unknown')) {
      recordActivity(deps, 'login', 'rate-limited');
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const { email: raw, password, next } = input;
    if (deps.humanCheck && !await deps.humanCheck(String((req.body as Record<string, unknown>)['cf-turnstile-response'] ?? ''), 'login', req.ip)) {
      recordActivity(deps, 'login', 'failed');
      return res.status(403).json({ error: 'Please complete the verification challenge.' });
    }
    const user = await deps.accounts.verify(asEmail(raw, deps.allowedDomains), password);
    if (!user) {
      const known = await findActivityUser(deps, asEmail(raw, deps.allowedDomains));
      recordActivity(deps, 'login', 'failed', known?.id);
      return res.status(401).json({ error: 'That UID and PIN do not match.' });
    }
    recordActivity(deps, 'login', 'succeeded', user.id);
    await setSession(req, res, user.email, deps);
    return res.json({ redirect: safeNext(next) });
  });
}

function createSignupHandler(deps: StudentAuthRouterDependencies, limiter: RateLimiter): RequestHandler {
  return asyncHandler(async (req, res) => {
    deps.noStore(res);
    if (!deps.signupOpen) return res.status(403).json({ error: 'Sign-up is closed.' });
    const input = authInput(req.body);
    if (!input) {
      recordActivity(deps, 'signup', 'failed');
      return res.status(400).json({ error: 'email, password and name must be strings' });
    }
    if (!limiter.allow(req.ip ?? 'unknown')) {
      recordActivity(deps, 'signup', 'rate-limited');
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const { email: raw, name, password, next } = input;
    if (deps.humanCheck && !await deps.humanCheck(String((req.body as Record<string, unknown>)['cf-turnstile-response'] ?? ''), 'signup', req.ip)) {
      recordActivity(deps, 'signup', 'failed');
      return res.status(403).json({ error: 'Please complete the verification challenge.' });
    }
    try {
      const user = await deps.accounts.create(asEmail(raw, deps.allowedDomains), name, password);
      recordActivity(deps, 'signup', 'succeeded', user.id);
      await setSession(req, res, user.email, deps);
      return res.json({ redirect: safeNext(next) });
    } catch (error) {
      if (error instanceof AuthError) {
        recordActivity(deps, 'signup', 'failed');
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  });
}

function recordActivity(deps: StudentAuthRouterDependencies, action: StudentActivityAction, outcome: StudentActivityOutcome, userId?: string): void {
  deps.activity?.record(action, outcome, userId ?? null, randomUUID());
}

async function findActivityUser(deps: StudentAuthRouterDependencies, email: string) {
  try { return await deps.accounts.get(email); } catch { return undefined; }
}

function authInput(body: unknown): { email: string; password: string; name: string; next: unknown } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  if ((fields.email !== undefined && typeof fields.email !== 'string') ||
      (fields.password !== undefined && typeof fields.password !== 'string') ||
      (fields.name !== undefined && typeof fields.name !== 'string') ||
      (typeof fields.password === 'string' && fields.password.length > 1024)) return null;
  return { email: typeof fields.email === 'string' ? fields.email : '',
    password: typeof fields.password === 'string' ? fields.password : '',
    name: typeof fields.name === 'string' ? fields.name : '', next: fields.next };
}

async function setSession(req: Request, res: Response, email: string, deps: StudentAuthRouterDependencies): Promise<void> {
  const user = await deps.accounts.get(email);
  if (user) res.cookie(COOKIE, deps.sessions.issue(email, Date.now(), studentSessionVersion(user)), {
    httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure || req.secure,
    maxAge: deps.sessions.ttl, path: '/',
  });
}

export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  let allowed = true;
  try { allowed = !origin || (new URL(origin).host === req.get('host') && new URL(origin).protocol === `${req.protocol}:`); } catch { allowed = false; }
  if (!allowed) {
    res.status(403).json({ error: 'cross-origin post refused' });
    return;
  }
  next();
}

function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard/';
  if (raw.startsWith('/login') || raw.startsWith('/signup')) return '/dashboard/';
  return raw;
}

export function asEmail(raw: string, domains: readonly string[]): string {
  const uid = raw.trim().toLowerCase();
  if (!/^u3\d{6,8}$/.test(uid)) return raw;
  return `${uid}@${domains.find((domain) => domain.startsWith('connect.')) ?? domains[0] ?? 'connect.hku.hk'}`;
}
