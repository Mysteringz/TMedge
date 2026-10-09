import { Router, type Request, type RequestHandler } from 'express';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';
import type { ProvisioningService } from '../application/provisioning-service.js';
import { ApplicationError } from '../../shared/application/contracts.js';

export const pairingCode = (id: string): string => id.replaceAll('-', '').slice(0, 8).toUpperCase();

export async function confirmApproval(service: ProvisioningService, id: string, input: unknown): Promise<void> {
  const request = (await service.requests()).find(item => item.id === id);
  if (!request) throw new ApplicationError('not-found', 'no such request (it may have expired)');
  const body = input && typeof input === 'object' ? input as { uid?: unknown; pairingCode?: unknown } : {};
  if (body.uid !== request.uid || body.pairingCode !== pairingCode(id)) {
    throw new ApplicationError('validation', 'match the UID and request code shown by TMflash before approving');
  }
}

export interface ProvisioningRouterDependencies {
  service: ProvisioningService;
  broadcast(message: unknown): void;
}

export interface ProvisioningAdminRouterDependencies extends ProvisioningRouterDependencies {
  mutating: RequestHandler;
  actor?: (request: Request) => string;
}

/** Builds machine-facing routes that use the scoped provisioning token. */
export function createProvisioningToolRouter(dependencies: ProvisioningRouterDependencies): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/preflight', asyncHandler(async (req, res) => {
    if (!dependencies.service.authorize(bearer(req))) return res.status(401).json({ error: 'provisioning is not available with that token' });
    await dependencies.service.ready();
    return res.json({ protocol: 'tmflash.adoption.v1', ready: true, approval: 'human' });
  }));
  router.post('/request', asyncHandler(async (req, res) => {
    if (!dependencies.service.authorize(bearer(req))) {
      return res.status(401).json({ error: 'provisioning is not available with that token' });
    }
    const result = await dependencies.service.request(req.body, req.socket.remoteAddress ?? '?');
    if (result.status === 'already-registered') return res.json({ status: 'registered', uid: result.uid });
    dependencies.broadcast({ type: 'join_request', request: result.request });
    return res.status(202).json({ status: 'pending', id: result.request.id, uid: result.request.uid, pairingCode: pairingCode(result.request.id) });
  }));
  router.get('/status/:uid', asyncHandler(async (req, res) => {
    if (!dependencies.service.authorize(bearer(req))) {
      return res.status(401).json({ error: 'provisioning is not available with that token' });
    }
    const uid = routeParam(req.params, 'uid').toLowerCase();
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(uid)) return res.status(400).json({ error: 'uid must be a MAC' });
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
    if (verdict === 'approve') await confirmApproval(dependencies.service, id, req.body);
    const item = verdict === 'deny'
      ? await dependencies.service.deny(id, dependencies.actor?.(req) ?? 'console')
      : await dependencies.service.approve(id, dependencies.actor?.(req) ?? 'console');
    dependencies.broadcast({ type: 'join_resolved', id, uid: item.uid, verdict });
    if (verdict === 'deny') return res.json({ ok: true, uid: item.uid });
    return res.json({ ok: true, uid: item.uid, label: item.label, placed: false });
  }));
  return router;
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([^\s,]+)$/.exec(request.headers.authorization ?? '');
  return match?.[1] ?? null;
}
