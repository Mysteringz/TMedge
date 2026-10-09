import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { parseCookies, studentSessionVersion } from '../application/student-session-service.js';
import type { StudentAuthRouterDependencies } from './student-auth-router.js';

export type StudentCredential =
  | { kind: 'cookie' | 'bearer'; token: string | undefined }
  | { kind: 'invalid'; token?: undefined };

/** A supplied Authorization header never falls back to a browser session. */
export function studentCredential(req: Request): StudentCredential {
  const cookie = parseCookies(req.headers.cookie).tm_session;
  const authorization = req.get('authorization');
  if (!req.path.startsWith('/api/') || authorization === undefined) return { kind: 'cookie', token: cookie };
  const hasCookie = /(?:^|;)\s*tm_session\s*=/.test(req.headers.cookie ?? '');
  const match = authorization.length <= 2055 ? /^Bearer +([A-Za-z0-9._~-]+)$/i.exec(authorization) : null;
  return hasCookie || !match ? { kind: 'invalid' } : { kind: 'bearer', token: match[1] };
}

/** Both transports validate the current account; only cookies renew automatically. */
export function createRequireStudent(deps: StudentAuthRouterDependencies): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    deps.noStore(res);
    const credential = studentCredential(req);
    if (credential.kind === 'invalid') {
      return res.status(400).set('WWW-Authenticate', 'Bearer error="invalid_request"')
        .json({ error: 'use either a student cookie or a Bearer token' });
    }
    const sessions = credential.kind === 'bearer' ? deps.accessTokens : deps.sessions;
    const detail = sessions?.detail(credential.token);
    const user = detail ? await deps.accounts.get(detail.email) : undefined;
    // Storage reads may yield while logout revokes the credential or its expiry passes.
    if (!detail || !user || detail.version !== studentSessionVersion(user) || !sessions?.detail(credential.token)) {
      if (req.path.startsWith('/api/')) return res.status(401)
        .set('WWW-Authenticate', credential.kind === 'bearer' ? 'Bearer error="invalid_token"' : 'Bearer')
        .json({ error: 'sign in first' });
      return res.redirect(`/login/?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.locals.studentUserId = user.id;
    res.locals.studentEmail = user.email;
    res.locals.studentName = user.name;
    if (credential.kind === 'cookie' && detail.expiresAt - Date.now() < deps.sessions.ttl / 2) {
      res.cookie('tm_session', deps.sessions.issue(user.email, Date.now(), studentSessionVersion(user)), {
        httpOnly: true, sameSite: 'lax', secure: deps.cookieSecure || req.secure, maxAge: deps.sessions.ttl, path: '/',
      });
    }
    return next();
  });
}
