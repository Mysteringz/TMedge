import express, { type Request, type Response } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { AuthBusyError, RateLimiter } from '../../../web/auth.js';
import { AccountError, type AccountMutation } from '../domain/accounts.js';
import { ManageAccounts } from '../use-cases/manage-accounts.js';

export function accountRoutes(auth: AlgoAuth, accounts: ManageAccounts) {
  const router = express.Router();
  const hashing = new RateLimiter(10, 300_000), writes = new RateLimiter(60, 300_000);
  const fail = (res: Response, error: unknown) => {
    const known = error instanceof AccountError ? error : error instanceof AuthBusyError ? new AccountError('RATE_LIMITED', 429, 'Try again later.') : new AccountError('STORAGE_UNAVAILABLE', 503, 'Account storage is unavailable.');
    return res.status(known.status).json({ data: null, error: { code: known.code, message: known.message } });
  };
  router.use((req, res, next) => { try { accounts.authority(() => auth.principalOf(req))(); next(); } catch (error) { fail(res, error); } });
  router.use(express.json({ limit: '8kb' }));
  router.get('/', (req, res) => {
    try { res.json({ data: accounts.list(Number(req.query.offset ?? 0), Number(req.query.limit ?? 25), accounts.authority(() => auth.principalOf(req))), error: null }); }
    catch (error) { fail(res, error); }
  });
  const mutation = (kind: AccountMutation['kind'] | 'delete') => async (req: Request, res: Response) => {
    try {
      const authorize = accounts.authority(() => auth.principalOf(req)); authorize();
      const origin = req.get('origin');
      if (req.get('x-tm-algo') !== '1' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) throw new AccountError('FORBIDDEN', 403, 'Request origin is not permitted.');
      const actor = auth.principalOf(req)!;
      if (!(kind === 'create' || kind === 'password' ? hashing : writes).allow(actor.name)) throw new AccountError('RATE_LIMITED', 429, 'Try again later.');
      const result = kind === 'delete' ? await accounts.delete(String(req.params.name ?? ''), req.body, authorize) : await accounts.mutate(kind, String(req.params.name ?? ''), req.body, authorize);
      res.status(kind === 'create' ? 201 : 200).json({ data: result, error: null });
    } catch (error) { fail(res, error); }
  };
  router.post('/', mutation('create')); router.patch('/:name', mutation('update'));
  router.delete('/:name', mutation('delete'));
  router.post('/:name/password-resets', mutation('password')); router.post('/:name/session-revocations', mutation('revoke'));
  router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => { fail(res, new AccountError('VALIDATION', 400, 'Invalid or oversized JSON body.')); });
  return router;
}
