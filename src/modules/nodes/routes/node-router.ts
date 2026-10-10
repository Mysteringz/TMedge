import { nodeCommandCapability as importCommandCapability } from '../../algo-admin/domain/permissions.js';
import { Router, type RequestHandler } from 'express';
import type { ExecuteNodeCommand } from '../application/execute-node-command.js';
import { ReceiptDispatchError } from '../application/live-command-receipts.js';
import type { CommandReceipt } from '../domain/command-receipt.js';
import type { Response } from 'express';
import type { ResetNodeCursor } from '../application/reset-node-cursor.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';

export interface NodeReadQueries {
  rgb(uid: string): { jpeg: Buffer } | null;
  raw(uid: string): unknown;
  receipt?(issuer: string, uid: string, id: string): CommandReceipt | null;
}

/** Embedded algo and standalone legacy identities cannot share receipt access. */
function issuer(res: Response): string { return res.locals.embeddedConsole ? `algo:${String(res.locals.principal?.name ?? '')}` : 'legacy:console'; }

export function createNodeRouter(dependencies: {
  reads: NodeReadQueries;
  executeCommand: ExecuteNodeCommand;
  resetCursor: ResetNodeCursor;
  mutating: RequestHandler;
}): Router {
  const router = Router();
  router.get('/:uid/commands/:id', (req, res) => {
    const current = res.locals.principal;
    if (current && !current.capabilities.includes('algo.read')) return res.status(403).json({ data: null, error: { code: 'forbidden', message: 'Command status access is unavailable.' } });
    const data = dependencies.reads.receipt?.(issuer(res), routeParam(req.params, 'uid').toLowerCase(), routeParam(req.params, 'id')) ?? null;
    return res.set('Cache-Control', 'no-store').status(data ? 200 : 404).json({ data, error: data ? null : { code: 'not-found', message: 'Command status is no longer available.' } });
  });
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
    try {
      const receipt = await dependencies.executeCommand.execute(routeParam(req.params, 'uid').toLowerCase(), req.body, {
        issuer: issuer(res), authorized: () => res.locals.permits?.(importCommandCapability(req.body)) ?? true,
      });
      return res.json({ sent: receipt ? ['sent', 'acknowledged'].includes(receipt.state) : true,
        note: receipt?.message ?? 'Sent — waiting for device. Acknowledgement does not confirm execution or persistence.', ...(receipt ? { receipt } : {}) });
    } catch (error) {
      if (error instanceof ReceiptDispatchError) return res.status(error.kind === 'unavailable' ? 503 : 409).json({ sent: false, error: error.message, receipt: error.receipt });
      throw error;
    }
  }));
  router.post('/:uid/reset-cursor', dependencies.mutating, (req, res) => {
    return res.json(dependencies.resetCursor.execute(routeParam(req.params, 'uid')));
  });
  return router;
}
