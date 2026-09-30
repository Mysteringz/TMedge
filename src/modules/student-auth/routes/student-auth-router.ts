import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { IStudentAccountRepository } from '../repositories/student-account-repository.js';
import { AuthError, parseCookies, RateLimiter, Sessions } from '../application/student-session-service.js';

const COOKIE = 'tm_session';

export interface StudentAuthRouterDependencies {
  accounts: IStudentAccountRepository;
  sessions: Sessions;
  allowedDomains: readonly string[];
  signupOpen: boolean;
  cookieSecure: boolean;
  noStore(res: Response): void;
}

/** Creates the existing student session and account HTTP endpoints. */
export function createStudentAuthRouter(dependencies: StudentAuthRouterDependencies): Router {
  const router = Router();
  const limiter = new RateLimiter(10, 5 * 60_000);
  const body = [express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb' })];
  const requireUser = createRequireStudent(dependencies);
  router.post('/login', body, sameOrigin, createLoginHandler(dependencies, limiter));
  router.post('/signup', body, sameOrigin, createSignupHandler(dependencies, limiter));
  router.post('/logout', body, sameOrigin, (_req: Request, res: Response) => {
    res.clearCookie(COOKIE, { path: '/' });
    dependencies.noStore(res);
    res.json({ redirect: '/login/' });
  });
  router.get('/api/me', requireUser, (req, res) => {
    const user = dependencies.accounts.get(userOf(req, dependencies.sessions) ?? '');
    res.json({ email: user?.email, name: user?.name });
  });
  return router;
}

/** Builds the shared browser/API session guard while preserving cookie renewal. */
export function createRequireStudent(dependencies: StudentAuthRouterDependencies): RequestHandler {
  return (req, res, next) => {
    const detail = dependencies.sessions.detail(parseCookies(req.headers.cookie)[COOKIE]);
    if (detail && dependencies.accounts.get(detail.email)) {
      if (detail.expiresAt - Date.now() < dependencies.sessions.ttl / 2) setSession(req, res, detail.email, dependencies);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'sign in first' });
    dependencies.noStore(res);
    return res.redirect(`/login/?next=${encodeURIComponent(req.originalUrl)}`);
  };
}

/** Resolves a session cookie to its account email. */
export function userOf(req: Request, sessions: Sessions): string | null {
  return sessions.read(parseCookies(req.headers.cookie)[COOKIE]);
}

function createLoginHandler(deps: StudentAuthRouterDependencies, limiter: RateLimiter): RequestHandler {
  return async (req, res) => {
    deps.noStore(res);
    const { email: raw = '', password = '', next } = req.body as Record<string, string>;
    if (!limiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    const user = await deps.accounts.verify(asEmail(raw, deps.allowedDomains), password);
    if (!user) return res.status(401).json({ error: 'That UID and PIN do not match.' });
    setSession(req, res, user.email, deps);
    return res.json({ redirect: safeNext(next) });
  };
}

function createSignupHandler(deps: StudentAuthRouterDependencies, limiter: RateLimiter): RequestHandler {
  return async (req, res) => {
    deps.noStore(res);
    if (!deps.signupOpen) return res.status(403).json({ error: 'Sign-up is closed.' });
    const { email: raw = '', name = '', password = '', next } = req.body as Record<string, string>;
    if (!limiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    try {
      const user = await deps.accounts.create(asEmail(raw, deps.allowedDomains), name, password);
      setSession(req, res, user.email, deps);
      return res.json({ redirect: safeNext(next) });
    } catch (error) {
      if (error instanceof AuthError) return res.status(400).json({ error: error.message });
      throw error;
    }
  };
}

function setSession(req: Request, res: Response, email: string, deps: StudentAuthRouterDependencies): void {
  res.cookie(COOKIE, deps.sessions.issue(email), {
    httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure || req.secure,
    maxAge: deps.sessions.ttl, path: '/',
  });
}

function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) {
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
