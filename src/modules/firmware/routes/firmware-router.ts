import express, { Router, type RequestHandler } from 'express';
import type { FirmwareBuildJobService } from '../application/firmware-build-job-service.js';
import { StartFirmwareRollout } from '../application/start-firmware-rollout.js';
import type { FirmwareArtifactFiles, ImageInUseQuery } from '../repositories/firmware-repository.js';
import type { RolloutService } from '../../rollouts/application/rollout-service.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';

export interface FirmwareRouterDependencies {
  firmware: FirmwareArtifactFiles;
  buildJobs: FirmwareBuildJobService;
  rollouts: RolloutService;
  imageInUse: ImageInUseQuery;
  mutating: RequestHandler;
  buildWorkerConfigured(): boolean;
}

/** Creates the legacy firmware HTTP routes with injected application dependencies. */
export function createFirmwareRouter(dependencies: FirmwareRouterDependencies): Router {
  const router = Router();
  router.get('/firmware', asyncHandler(getFirmwareStatus(dependencies)));
  router.post('/firmware/cleanup', dependencies.mutating, cleanupFirmware(dependencies));
  router.post('/firmware/uploads', dependencies.mutating, startFirmwareUpload(dependencies));
  router.post('/firmware/uploads/:id/files', dependencies.mutating, express.raw({ type: '*/*', limit: '8mb' }), addFirmwareFile(dependencies));
  router.post('/firmware/uploads/:id/build', dependencies.mutating, asyncHandler(startFirmwareBuild(dependencies)));
  router.delete('/firmware/:id', dependencies.mutating, deleteFirmwareImage(dependencies));
  router.post('/firmware/rollout', dependencies.mutating, asyncHandler(startFirmwareRollout(dependencies)));
  router.post('/firmware/rollout/cancel', dependencies.mutating, asyncHandler(cancelFirmwareRollout(dependencies)));
  return router;
}

function getFirmwareStatus(dependencies: FirmwareRouterDependencies): RequestHandler {
  return async (_req, res) => res.json({
    pio: dependencies.buildWorkerConfigured(),
    builds: dependencies.firmware.list(),
    building: await dependencies.buildJobs.status(),
    rollout: dependencies.rollouts.current(),
    history: dependencies.rollouts.history(),
    diskBytes: dependencies.firmware.diskBytes(),
    retention: dependencies.firmware.retentionReport(),
  });
}

function cleanupFirmware(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (_req, res) => res.json({ ok: true, retention: dependencies.firmware.cleanup(dependencies.imageInUse) });
}

function startFirmwareUpload(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (_req, res) => {
    const retention = dependencies.firmware.cleanup(dependencies.imageInUse);
    return res.json({ uploadId: dependencies.firmware.startUpload('console'), retention });
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
  return async (req, res) => await dependencies.buildJobs.start(req.params.id ?? '', { id: 'console', kind: 'console' })
    ? res.status(202).json({ ok: true })
    : res.status(409).json({ error: 'a build is already running' });
}

function deleteFirmwareImage(dependencies: FirmwareRouterDependencies): RequestHandler {
  return (req, res) => {
    const id = req.params.id ?? '';
    if (dependencies.imageInUse.isImageInUse(id)) return res.status(409).json({ error: 'that image is rolling out right now' });
    return res.json({ ok: dependencies.firmware.remove(id, dependencies.imageInUse) });
  };
}

function startFirmwareRollout(dependencies: FirmwareRouterDependencies): RequestHandler {
  const useCase = new StartFirmwareRollout(dependencies.rollouts);
  return async (req, res) => {
    try {
      return res.json(await useCase.execute(req.body, 'console'));
    } catch (error: unknown) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  };
}

function cancelFirmwareRollout(dependencies: FirmwareRouterDependencies): RequestHandler {
  return async (_req, res) => {
    await dependencies.rollouts.cancel('console');
    return res.json({ ok: true });
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
