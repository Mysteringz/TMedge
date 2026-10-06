import { Router, type Request, type RequestHandler } from 'express';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';
import type { ProvisioningService } from '../application/provisioning-service.js';

export interface ProvisioningRouterDependencies {
  service: ProvisioningService;
  broadcast(message: unknown): void;
}

export interface ProvisioningAdminRouterDependencies extends ProvisioningRouterDependencies {
  mutating: RequestHandler;
}

/** Builds machine-facing routes that use the scoped provisioning token. */
export function createProvisioningToolRouter(dependencies: ProvisioningRouterDependencies): Router {
  const router = Router();
  router.post('/request', asyncHandler(async (req, res) => {
    if (!dependencies.service.authorize(bearer(req))) {
      return res.status(401).json({ error: 'provisioning is not available with that token' });
    }
    const result = await dependencies.service.request(req.body, req.socket.remoteAddress ?? '?');
    if (result.status === 'already-registered') return res.json({ status: 'registered', uid: result.uid });
    dependencies.broadcast({ type: 'join_request', request: result.request });
    return res.status(202).json({ status: 'pending', id: result.request.id, uid: result.request.uid });
  }));
  router.get('/status/:uid', asyncHandler(async (req, res) => {
    if (!dependencies.service.authorize(bearer(req))) {
      return res.status(401).json({ error: 'provisioning is not available with that token' });
    }
    const uid = routeParam(req.params, 'uid').toLowerCase();
    return res.json({ uid, status: await dependencies.service.statusOf(uid) });
  }));
  return router;
}

/** Builds admin-facing routes; the parent mounts it after Basic auth. */
export function createProvisioningAdminRouter(dependencies: ProvisioningAdminRouterDependencies): Router {
  const router = Router();
  router.get('/requests', asyncHandler(async (_req, res) => {
    return res.json({ enabled: dependencies.service.enabled, requests: await dependencies.service.requests() });
  }));
  router.post('/requests/:id/:verdict', dependencies.mutating, asyncHandler(async (req, res) => {
    const id = routeParam(req.params, 'id');
    const verdict = routeParam(req.params, 'verdict');
    if (verdict !== 'approve' && verdict !== 'deny') return res.status(400).json({ error: 'verdict must be approve or deny' });
    const item = verdict === 'deny'
      ? await dependencies.service.deny(id, 'console')
      : await dependencies.service.approve(id, 'console');
    dependencies.broadcast({ type: 'join_resolved', id, uid: item.uid, verdict });
    if (verdict === 'deny') return res.json({ ok: true, uid: item.uid });
    return res.json({ ok: true, uid: item.uid, label: item.label, placed: false });
  }));
  return router;
}

function bearer(request: Request): string | null {
  const [scheme, value] = (request.headers.authorization ?? '').split(' ');
  return scheme === 'Bearer' && value ? value : null;
}
