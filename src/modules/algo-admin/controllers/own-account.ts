import express, { type Request, type Response } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { AuthBusyError, RateLimiter } from '../../../web/auth.js';
import { AccountError } from '../domain/accounts.js';
import type { AdminPrincipal } from '../domain/permissions.js';
import type { ManageOwnAccount } from '../use-cases/manage-own-account.js';

/**
 * `/api/account`: the signed-in person's own account. Every role may use it,
 * and no route takes a username -- it acts on whoever the session belongs to.
 */
export function ownAccountRoutes(auth: AlgoAuth, account: ManageOwnAccount) {
  const router = express.Router();
  // Trying a current password costs a scrypt hash and is a guess at it, so tries are few and per account.
  const passwords = new RateLimiter(5, 300_000), writes = new RateLimiter(30, 300_000);
  // Each code is a message to an address the console has only been told about. Few per person, and few
  // altogether: a mail service judges its sender by what is sent to addresses that never asked.
  const codes = new RateLimiter(3, 900_000), allCodes = new RateLimiter(30, 3_600_000);
  const fail = (res: Response, error: unknown) => {
    const known = error instanceof AccountError ? error : error instanceof AuthBusyError ? new AccountError('RATE_LIMITED', 429, 'Try again later.') : new AccountError('STORAGE_UNAVAILABLE', 503, 'Account storage is unavailable.');
    return res.status(known.status).json({ data: null, error: { code: known.code, message: known.message } });
  };
  const actorOf = (req: Request): AdminPrincipal => {
    const actor = auth.principalOf(req);
    if (!actor) throw new AccountError('UNAUTHENTICATED', 401, 'Sign in again.');
    return actor;
  };
  /** The cookie is SameSite=Lax, so the header and the origin are what stop another site acting as this person. */
  const writer = (req: Request, limiter: RateLimiter): AdminPrincipal => {
    const actor = actorOf(req), origin = req.get('origin');
    if (req.get('x-tm-algo') !== '1' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) throw new AccountError('FORBIDDEN', 403, 'Request origin is not permitted.');
    if (!limiter.allow(actor.name)) throw new AccountError('RATE_LIMITED', 429, 'Try again later.');
    return actor;
  };
  router.use((req, res, next) => { try { actorOf(req); next(); } catch (error) { fail(res, error); } });
  router.use(express.json({ limit: '8kb' }));

  router.get('/', (req, res) => {
    try { res.json({ data: account.read(actorOf(req)), error: null }); } catch (error) { fail(res, error); }
  });
  router.put('/settings', (req, res) => {
    try { res.json({ data: account.saveSettings(writer(req, writes), req.body), error: null }); } catch (error) { fail(res, error); }
  });
  router.post('/email-codes', async (req, res) => {
    try {
      const actor = writer(req, writes);
      if (!codes.allow(actor.name) || !allCodes.allow('all')) throw new AccountError('RATE_LIMITED', 429, 'Too many codes sent. Wait a few minutes.');
      res.json({ data: await account.sendCode(actor), error: null });
    } catch (error) { fail(res, error); }
  });
  router.post('/email-confirmations', (req, res) => {
    try { res.json({ data: account.confirmEmail(writer(req, writes), req.body), error: null }); } catch (error) { fail(res, error); }
  });
  router.post('/password', async (req, res) => {
    try {
      const actor = writer(req, writes);
      await account.changePassword(actor, req.body, () => { if (!passwords.allow(actor.name)) throw new AccountError('RATE_LIMITED', 429, 'Too many tries. Wait a few minutes.'); });
      // The change ended every session of the account. The one it was made
      // from is given a new one, so the person is not thrown out of the page
      // for having done the careful thing; every other device signs in again.
      auth.renewSession(req, res, actor.name);
      res.json({ data: { changed: true }, error: null });
    } catch (error) { fail(res, error); }
  });
  router.post('/session-revocations', (req, res) => {
    try {
      account.endSessions(writer(req, writes));
      auth.forgetSession(req, res);
      res.json({ data: { ended: true }, error: null });
    } catch (error) { fail(res, error); }
  });
  router.use((_error: unknown, _req: Request, res: Response, _next: express.NextFunction) => { fail(res, new AccountError('VALIDATION', 400, 'Invalid or oversized JSON body.')); });
  return router;
}
