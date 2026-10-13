import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import { searchSeats } from '../../../shared/seats.js';
import { isSnapshot, SnapshotStore } from '../../../web/store.js';
import type { StudentUsageActivity } from '../../student-auth/application/student-usage-activity.js';
import type { SnapshotPublishers } from '../../../web/publishers.js';
import { ImmutablePublishedModelConflictError, FilePublishedModelStore } from '../../../web/published-model-store.js';

export interface OccupancyRouterDependencies {
  store: SnapshotStore;
  pushToken: string;
  publishers?: SnapshotPublishers;
  requireStudent: RequestHandler;
  onSnapshot(): void;
  usage?: StudentUsageActivity;
  models?: FilePublishedModelStore;
}

/** Creates authenticated student reads and the edge-only snapshot push route. */
export function createOccupancyRouter(dependencies: OccupancyRouterDependencies): Router {
  const router = Router();
  router.post('/api/edge/snapshot', express.json({ limit: '2mb' }), (req, res) => {
    const token = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    const authenticated = dependencies.publishers
      ? dependencies.publishers.authenticate(req.body?.edgeId, token)
      : hasEdgeToken(req.get('authorization'), dependencies.pushToken);
    if (!authenticated) return res.status(401).json({ error: 'bad edge token' });
    if (!isSnapshot(req.body)) return res.status(400).json({ error: 'not an occupancy snapshot' });
    if (dependencies.publishers && !dependencies.publishers.authorizes(req.body)) return res.status(403).json({ error: 'edge is not authorized for these floors' });
    if (!dependencies.store.put(req.body)) return res.status(503).json({ error: 'snapshot store is full' });
    dependencies.onSnapshot();
    return res.json({ ok: true });
  });
  router.put('/api/edge/location-assets/:locationId/:assetId', (req, res, next) => {
    const edgeId = req.get('x-tm-edge-id') ?? '';
    const authorization = req.get('authorization');
    const token = Buffer.from((authorization ?? '').replace(/^Bearer /, ''));
    const authenticated = dependencies.publishers
      ? dependencies.publishers.authenticate(edgeId, token)
      : hasEdgeToken(authorization, dependencies.pushToken);
    if (!authenticated) return res.status(401).json({ error: 'bad edge token' });
    if (dependencies.publishers && !dependencies.publishers.authorizesFloor(edgeId, req.params.locationId ?? '')) {
      return res.status(403).json({ error: 'edge is not authorized for this location' });
    }
    const models = dependencies.models;
    if (!models) return res.status(503).json({ error: 'model store is unavailable' });
    res.locals.publishedModelStore = models;
    return next();
  }, express.raw({ type: 'model/gltf-binary', limit: '128mb' }), async (req, res) => {
    const assetId = typeof req.params.assetId === 'string' ? req.params.assetId : '';
    const locationId = typeof req.params.locationId === 'string' ? req.params.locationId : '';
    const digest = req.get('x-tm-sha256') ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(locationId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)
      || !/^[0-9a-f]{64}$/.test(digest) || req.get('content-type')?.split(';', 1)[0]?.trim() !== 'model/gltf-binary'
      || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'invalid model transfer' });
    try {
      const models = res.locals.publishedModelStore as FilePublishedModelStore;
      const result = await models.put(assetId, digest, req.body);
      return res.status(result === 'stored' ? 201 : 200).json({ ok: true, assetId: assetId.toLowerCase(), sha256: digest });
    } catch (error) {
      if (error instanceof ImmutablePublishedModelConflictError) return res.status(409).json({ error: 'immutable asset conflict' });
      if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: 'invalid model bytes or digest' });
      return res.status(503).json({ error: 'model storage is unavailable' });
    }
  });
  router.get('/api/occupancy', dependencies.requireStudent, (_req, res) => res.json(dependencies.store.view()));
  router.get('/api/models/:assetId', dependencies.requireStudent, async (req, res) => {
    const assetId = typeof req.params.assetId === 'string' ? req.params.assetId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)
      || !dependencies.store.referencesUploadedModel(assetId.toLowerCase())) return res.status(404).end();
    if (!dependencies.models) return res.status(503).end();
    try {
      const model = await dependencies.models.read(assetId);
      if (!model) return res.status(404).end();
      return res.status(200).type('model/gltf-binary').set({
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
        'Content-Length': String(model.bytes.byteLength), 'ETag': `"${model.sha256}"`,
      }).send(model.bytes);
    } catch { return res.status(503).end(); }
  });
  router.get('/api/search', dependencies.requireStudent, (req, res) => {
    const seats = Number(req.query.seats);
    if (!Number.isInteger(seats) || seats < 1 || seats > 30) {
      return res.status(400).json({ error: 'seats must be a whole number 1..30' });
    }
    const floor = typeof req.query.floor === 'string' ? req.query.floor : undefined;
    const results = searchSeats(dependencies.store.view().floors, seats, floor).slice(0, 20);
    const userId: unknown = res.locals.studentUserId;
    dependencies.usage?.recordApiSearch(typeof userId === 'string' ? userId : undefined, seats, floor, results.length, randomUUID());
    return res.json({ seats, results });
  });
  return router;
}

function hasEdgeToken(header: string | undefined, expectedToken: string): boolean {
  const actual = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
