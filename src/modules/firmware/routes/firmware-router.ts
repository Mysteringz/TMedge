import express, { Router, type RequestHandler } from 'express';
import type { FirmwareBuildJobs } from '../application/firmware-build-jobs.js';
import type { FirmwareArtifactFiles, ImageInUseQuery } from '../repositories/firmware-repository.js';
import type { RolloutTarget, Rollouts } from '../../../edge/rollout.js';

export interface FirmwareRouterDependencies {
  firmware: FirmwareArtifactFiles;
  buildJobs: FirmwareBuildJobs;
  rollouts: Rollouts;
  imageInUse: ImageInUseQuery;
  mutating: RequestHandler;
  pioInstalled(): boolean;
}

/** Creates the legacy firmware HTTP routes with injected application dependencies. */
export function createFirmwareRouter(dependencies: FirmwareRouterDependencies): Router {
  const router = Router();
  router.get('/firmware', getFirmwareStatus(dependencies));
  router.post('/firmware/uploads', dependencies.mutating, startFirmwareUpload(dependencies));
  router.post('/firmware/uploads/:id/files', dependencies.mutating, express.raw({ type: '*/*', limit: '8mb' }), addFirmwareFile(dependencies));
  router.post('/firmware/uploads/:id/build', dependencies.mutating, startFirmwareBuild(dependencies));
  router.delete('/firmware/:id', dependencies.mutating, deleteFirmwareImage(dependencies));
  router.post('/firmware/rollout', dependencies.mutating, startFirmwareRollout(dependencies));
  router.post('/firmware/rollout/cancel', dependencies.mutating, cancelFirmwareRollout(dependencies));
  return router;
}

function getFirmwareStatus(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (_req, res) => res.json({
    pio: dependencies.pioInstalled(),
    builds: dependencies.firmware.list(),
    building: dependencies.buildJobs.status(),
    rollout: dependencies.rollouts.current(),
    history: dependencies.rollouts.history(),
    diskBytes: dependencies.firmware.diskBytes(),
  });
}

function startFirmwareUpload(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (_req, res) => {
    dependencies.firmware.sweep();
    return res.json({ uploadId: dependencies.firmware.startUpload('console') });
  };
}

function addFirmwareFile(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (req, res) => {
    try {
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      dependencies.firmware.addFile(req.params.id ?? '', path, body);
      return res.json({ ok: true });
    } catch (error: unknown) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  };
}

function startFirmwareBuild(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (req, res) => dependencies.buildJobs.start(req.params.id ?? '', { id: 'console', kind: 'console' })
    ? res.status(202).json({ ok: true })
    : res.status(409).json({ error: 'a build is already running' });
}

function deleteFirmwareImage(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (req, res) => {
    const id = req.params.id ?? '';
    if (dependencies.imageInUse.isImageInUse(id)) return res.status(409).json({ error: 'that image is rolling out right now' });
    return res.json({ ok: dependencies.firmware.remove(id) });
  };
}

function startFirmwareRollout(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (req, res) => {
    const body = (req.body ?? {}) as { buildId?: string; target?: RolloutTarget };
    if (!body.buildId || !body.target) return res.status(400).json({ error: 'buildId and target are required' });
    try {
      return res.json(dependencies.rollouts.start(body.buildId, body.target, 'console'));
    } catch (error: unknown) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  };
}

function cancelFirmwareRollout(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (_req, res) => {
    dependencies.rollouts.cancel('console');
    return res.json({ ok: true });
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
