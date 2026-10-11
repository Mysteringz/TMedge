/**
 * `/api/workspace` on the algo console: the mailbox and the board behind the
 * landing page. Everything here needs a signed-in account; nothing here is
 * mounted on the student web tier.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { routeParam } from '../../../shared/http.js';
import { RateLimiter } from '../../../web/auth.js';
import type { Board } from '../application/board.js';
import type { Mailbox } from '../application/mailbox.js';
import { WorkspaceError, type Actor, type Member } from '../domain/workspace.js';

export interface WorkspaceServices { mailbox: Mailbox; board: Board; members(): Member[]; now?: () => number }

export function createWorkspaceRouter(auth: Pick<AlgoAuth, 'principalOf'>, services: WorkspaceServices): Router {
  const { mailbox, board } = services;
  const now = services.now ?? Date.now;
  const router = express.Router();
  // Sending is the one write that lands in front of other people unasked, so
  // it has the tighter budget.
  const sends = new RateLimiter(30, 300_000), writes = new RateLimiter(240, 300_000);

  const fail = (res: Response, error: unknown) => {
    const known = error instanceof WorkspaceError ? error : new WorkspaceError('STORAGE_UNAVAILABLE', 503, 'Team storage is unavailable.');
    return void res.status(known.status).json({ data: null, error: { code: known.code, message: known.message } });
  };

  const actorOf = (req: Request): Actor => {
    const principal = auth.principalOf(req);
    if (!principal) throw new WorkspaceError('UNAUTHENTICATED', 401, 'Sign in again.');
    if (!principal.capabilities.includes('algo.read')) throw new WorkspaceError('FORBIDDEN', 403, 'Team features are unavailable to this account.');
    const self = services.members().find((member) => member.name === principal.name);
    if (!self) throw new WorkspaceError('UNAUTHENTICATED', 401, 'Sign in again.');
    return { ...self, canTriage: principal.capabilities.includes('algo.write'), isAdmin: principal.role === 'admin' };
  };

  type Handler = (actor: Actor, req: Request) => unknown;
  const reply = (status: number, handler: Handler) => (req: Request, res: Response) => {
    try { res.status(status).json({ data: handler(actorOf(req), req), error: null }); } catch (error) { fail(res, error); }
  };
  /**
   * The session cookie is SameSite=Lax, so another site can still make this
   * browser POST here. A write needs the header a cross-site form cannot set
   * and, when the browser names an origin, for it to be this one.
   */
  const write = (status: number, handler: Handler, budget: RateLimiter = writes) => (req: Request, res: Response) => {
    try {
      const actor = actorOf(req);
      const origin = req.get('origin');
      if (req.get('x-tm-algo') !== '1' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) throw new WorkspaceError('FORBIDDEN', 403, 'Request origin is not permitted.');
      if (!budget.allow(actor.name, now())) throw new WorkspaceError('RATE_LIMITED', 429, 'Too many changes at once. Try again in a few minutes.');
      res.status(status).json({ data: handler(actor, req), error: null });
    } catch (error) { fail(res, error); }
  };
  const id = (req: Request) => routeParam(req.params, 'id');

  // Nobody without a session learns anything from the shape of a body.
  router.use((req, res, next) => { try { actorOf(req); next(); } catch (error) { fail(res, error); } });
  router.use(express.json({ limit: '16kb' }));

  router.get('/', reply(200, (actor) => ({
    generatedAt: now(),
    me: { name: actor.name, canTriage: actor.canTriage, isAdmin: actor.isAdmin },
    // Names only. What role a colleague holds is the Accounts page's to show, to admins.
    members: services.members().map((member) => member.name).sort(),
    mail: mailbox.list(actor),
    board: board.view(actor),
  })));

  router.get('/messages/:id', reply(200, (actor, req) => mailbox.open(actor, id(req))));
  router.post('/messages', write(201, (actor, req) => mailbox.send(actor, req.body), sends));
  router.post('/messages/:id/read', write(200, (actor, req) => mailbox.mark(actor, id(req), req.body)));
  router.delete('/messages/:id', write(200, (actor, req) => mailbox.remove(actor, id(req))));

  router.post('/requests', write(201, (actor, req) => board.createRequest(actor, req.body)));
  router.patch('/requests/:id', write(200, (actor, req) => board.updateRequest(actor, id(req), req.body)));
  router.post('/requests/:id/vote', write(200, (actor, req) => board.vote(actor, id(req), req.body)));
  router.delete('/requests/:id', write(200, (actor, req) => board.removeRequest(actor, id(req), req.body)));

  router.post('/tasks', write(201, (actor, req) => board.createTask(actor, req.body)));
  router.patch('/tasks/:id', write(200, (actor, req) => board.updateTask(actor, id(req), req.body)));
  router.delete('/tasks/:id', write(200, (actor, req) => board.removeTask(actor, id(req), req.body)));

  router.use((_req, res) => fail(res, new WorkspaceError('NOT_FOUND', 404, 'No such endpoint.')));
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => fail(res, new WorkspaceError('VALIDATION', 400, 'Invalid or oversized JSON body.')));
  return router;
}
