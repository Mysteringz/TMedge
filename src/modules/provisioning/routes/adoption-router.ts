import { Router, type RequestHandler } from 'express';
import type { EdgeRuntime } from '../../../edge/runtime.js';
import type { AdoptionCredentials } from '../../../edge/adoption-credentials.js';
import type { ProvisioningService } from '../application/provisioning-service.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { pairingCode, confirmApproval } from './provisioning-routers.js';
import { routeParam } from '../../../shared/http.js';

/** Mounted only behind algo's per-person sign-in. Never on a machine port. */
export function createAdoptionRouter(rt: EdgeRuntime, service: ProvisioningService, credentials: AdoptionCredentials): Router {
  const router = Router();
  const mutating: RequestHandler = (req, res, next) => req.get('x-tm-algo') === '1'
    ? next() : res.status(403).json({ error: 'missing x-tm-algo header' });
  router.get('/', asyncHandler(async (_req, res) => {
    let ready = true;
    try { await service.ready(); } catch { ready = false; }
    const requests = await service.requests();
    const nodes = rt.nodes().filter(node => node.registered && !rt.reg.nodes.get(node.uid)?.simulated).map(node => ({
      uid: node.uid, label: node.label, placed: node.floorId !== null && node.pose !== null,
      online: node.online, verified: node.online && node.signed && node.reports > 0 && rt.lastReport(node.uid)?.boot === node.boot,
      lastSeen: node.lastSeen, reports: node.reports, fps: node.fps, firmware: node.status?.fw ?? null,
    }));
    return res.json({ ready, enabled: service.enabled, legacyToken: rt.cfg.flashToken !== null,
      requests: requests.map(request => ({ ...request, pairingCode: pairingCode(request.id) })),
      tokens: credentials.list(), nodes });
  }));
  router.post('/tokens', mutating, asyncHandler(async (req, res) => {
    await service.ready();
    return res.status(201).json(credentials.issueForAccount(req.body?.label, req.body?.hours, String(res.locals.user)));
  }));
  router.post('/tokens/:id/revoke', mutating, (req, res) => {
    credentials.revoke(routeParam(req.params, 'id'), `algo:${String(res.locals.user)}`);
    return res.json({ ok: true });
  });
  router.post('/requests/:id/:verdict', mutating, asyncHandler(async (req, res) => {
    const id = routeParam(req.params, 'id'), verdict = routeParam(req.params, 'verdict');
    if (!['approve', 'deny'].includes(verdict)) return res.status(400).json({ error: 'verdict must be approve or deny' });
    const request = (await service.requests()).find(item => item.id === id);
    if (!request) return res.status(404).json({ error: 'no such request (it may have expired)' });
    // A token authorises a question. The operator must match this physical
    // board's identity and request to TMflash before answering it.
    if (verdict === 'approve') await confirmApproval(service, id, req.body);
    const actor = `algo:${String(res.locals.user)}`;
    const result = verdict === 'approve' ? await service.approve(id, actor) : await service.deny(id, actor);
    return res.json({ ok: true, uid: result.uid, placed: false });
  }));
  return router;
}
