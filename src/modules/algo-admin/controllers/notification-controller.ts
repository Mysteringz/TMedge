import express, { type Router } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import type { ReadNotifications } from '../use-cases/read-notifications.js';

export function createNotificationRouter(auth: AlgoAuth, read: ReadNotifications): Router {
  const router = express.Router();
  router.get('/', async (req, res) => {
    const actor = auth.principalOf(req);
    const denied = (status: number) => res.status(status).json({ data: null, error: { code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', message: status === 401 ? 'Sign in to view notifications.' : 'Notification access is unavailable.' } });
    if (!actor) return void denied(401);
    if (!actor.capabilities.includes('algo.read')) return void denied(403);
    try {
      const data = await read.execute(actor), current = auth.principalOf(req);
      if (!current) return void denied(401);
      if (current.name !== actor.name || (['algo.read', 'training.read', 'firmware.read'] as const).some((capability) => current.capabilities.includes(capability) !== actor.capabilities.includes(capability))) return void denied(403);
      res.set('Cache-Control', 'no-store').json({ data, error: null });
    } catch { res.status(503).json({ data: null, error: { code: 'UNAVAILABLE', message: 'Could not refresh notifications.' } }); }
  });
  return router;
}
