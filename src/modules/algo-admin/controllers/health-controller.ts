import express, { type Router } from 'express';
import type { AdminPrincipal } from '../domain/permissions.js';
import type { ReadOperationalHealth } from '../use-cases/read-operational-health.js';

/** Current principal is supplied by the existing cookie authentication adapter. */
export function createHealthRouter(read: ReadOperationalHealth): Router {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    const principal: AdminPrincipal | undefined = res.locals.principal;
    if (!principal) return void res.status(401).json({ data: null, error: { code: 'unauthenticated', message: 'Sign in to view system status.' } });
    if (!principal.capabilities.includes('algo.read')) return void res.status(403).json({ data: null, error: { code: 'forbidden', message: 'System status access is unavailable.' } });
    const data = await read.execute(principal.name);
    res.set('Cache-Control', 'no-store').json({ data, error: null });
  });
  return router;
}
