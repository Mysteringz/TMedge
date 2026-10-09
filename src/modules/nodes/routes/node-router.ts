import { nodeCommandCapability as importCommandCapability } from '../../algo-admin/domain/permissions.js';
import { Router, type RequestHandler } from 'express';
import type { ExecuteNodeCommand } from '../application/execute-node-command.js';
import type { ResetNodeCursor } from '../application/reset-node-cursor.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';

export interface NodeReadQueries {
  rgb(uid: string): { jpeg: Buffer } | null;
  raw(uid: string): unknown;
}

export function createNodeRouter(dependencies: {
  reads: NodeReadQueries;
  executeCommand: ExecuteNodeCommand;
  resetCursor: ResetNodeCursor;
  mutating: RequestHandler;
}): Router {
  const router = Router();
  router.get('/:uid/rgb.jpg', (req, res) => {
    const frame = dependencies.reads.rgb((routeParam(req.params, 'uid')).toLowerCase());
    if (!frame) return res.status(404).end();
    return res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).send(frame.jpeg);
  });
  router.get('/:uid/raw', (req, res) => {
    const raw = dependencies.reads.raw(routeParam(req.params, 'uid'));
    if (!raw) return res.status(404).json({ error: 'no raw frame from this node yet (is raw_every 0?)' });
    return res.json(raw);
  });
  router.post('/:uid/command', dependencies.mutating, asyncHandler(async (req, res) => {
    await dependencies.executeCommand.execute(routeParam(req.params, 'uid'), req.body, () => res.locals.permits?.(importCommandCapability(req.body)) ?? true);
    return res.json({ sent: true, note: 'applied when the node acknowledges in its next STATUS (last_cmd)' });
  }));
  router.post('/:uid/reset-cursor', dependencies.mutating, (req, res) => {
    return res.json(dependencies.resetCursor.execute(routeParam(req.params, 'uid')));
  });
  return router;
}
