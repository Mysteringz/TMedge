import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { AlgoAuth } from './auth.js';
import type { ConsoleCore } from '../edge/console.js';
import { asyncHandler } from '../infrastructure/http/errors.js';
import { RateLimiter } from '../web/auth.js';

interface Grant { challenge: string; user: string; subject: string; expiresAt: number }
const CALLBACK = 'hk.hkumyseat.tmflash://login';

/** Browser sign-in proves the account. PKCE binds its one-use code to the
 * Mac that initiated it, even if another app intercepts the URL callback. */
export function flasherLogin(auth: AlgoAuth, core: ConsoleCore, now: () => number = Date.now) {
  const codes = new Map<string, Grant>();
  const machine = Router(), browser = Router();
  const limiter = new RateLimiter(30, 60_000);
  core.flasherCredentials.bindAccounts(name => auth.accountSubject(name));
  const mutating: RequestHandler = (req, res, next) => req.get('x-tm-algo') === '1'
    ? next() : res.status(403).json({ error: 'missing x-tm-algo header' });
  const expire = () => { for (const [code, grant] of codes) if (grant.expiresAt <= now()) codes.delete(code); };
  browser.post('/authorize', mutating, asyncHandler(async (req, res) => {
    const user = auth.userOf(req), subject = user ? auth.accountSubject(user) : null;
    if (!user || !subject) return res.status(401).json({ error: 'sign in with an algo account first' });
    const { challenge, state } = (req.body ?? {}) as { challenge?: unknown; state?: unknown };
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      return res.status(400).json({ error: 'invalid TMflash sign-in request' });
    }
    expire();
    if (codes.size >= 128) return res.status(429).json({ error: 'too many sign-ins in progress; try again shortly' });
    await core.provisioningService.ready();
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { user, subject, challenge, expiresAt: now() + 60_000 });
    const callback = new URL(CALLBACK); callback.searchParams.set('code', code); callback.searchParams.set('state', state);
    return res.json({ redirect: callback.toString() });
  }));
  machine.post('/exchange', asyncHandler(async (req, res) => {
    if (!limiter.allow(req.ip ?? 'unknown')) return res.status(429).json({ error: 'too many sign-in attempts; try again shortly' });
    expire();
    const { code, verifier } = (req.body ?? {}) as { code?: unknown; verifier?: unknown };
    const grant = typeof code === 'string' ? codes.get(code) : undefined;
    if (!grant || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || auth.accountSubject(grant.user) !== grant.subject) {
      return res.status(401).json({ error: 'sign-in expired or invalid; sign in again from TMflash' });
    }
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(grant.challenge))) return res.status(401).json({ error: 'sign-in could not be verified' });
    codes.delete(String(code));
    const session = core.flasherCredentials.issue('TMflash on Mac', 24, `algo:${grant.user}`, grant.subject);
    return res.status(201).json({ id: session.id, token: session.token, user: grant.user, expiresAt: session.expiresAt });
  }));
  machine.post('/logout', (req, res) => {
    const match = /^Bearer ([^\s,]+)$/.exec(req.headers.authorization ?? '');
    core.flasherCredentials.signOut(match?.[1] ?? null);
    return res.status(204).end();
  });
  return { machine, browser };
}
