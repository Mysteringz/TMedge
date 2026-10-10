import express, { type Router } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import type { ReadOperationalHealth } from '../use-cases/read-operational-health.js';

/** Current principal is supplied by the existing cookie authentication adapter. */
export function createHealthRouter(auth: Pick<AlgoAuth, 'principalOf' | 'accountEpoch'>, read: ReadOperationalHealth): Router {
  const router = express.Router();
  router.get('/', async (req, res) => {
    const principal = auth.principalOf(req);
    if (!principal) return void res.status(401).json({ data: null, error: { code: 'unauthenticated', message: 'Sign in to view system status.' } });
    if (!principal.capabilities.includes('algo.read')) return void res.status(403).json({ data: null, error: { code: 'forbidden', message: 'System status access is unavailable.' } });
    const epoch = auth.accountEpoch(principal.name);
    const data = await read.execute(principal.name), current = auth.principalOf(req);
    if (!current || auth.accountEpoch(principal.name) !== epoch) return void res.status(401).json({ data: null, error: { code: 'unauthenticated', message: 'Sign in to view system status.' } });
    if (current.name !== principal.name || (['algo.read', 'training.read', 'firmware.read'] as const).some((capability) => current.capabilities.includes(capability) !== principal.capabilities.includes(capability))) return void res.status(403).json({ data: null, error: { code: 'forbidden', message: 'System status access is unavailable.' } });
    res.set('Cache-Control', 'no-store').json({ data, error: null });
  });
  return router;
}
