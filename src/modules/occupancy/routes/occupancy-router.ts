import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import { searchSeats } from '../../../shared/seats.js';
import { isSnapshot, SnapshotStore } from '../../../web/store.js';
import type { StudentUsageActivity } from '../../student-auth/application/student-usage-activity.js';

export interface OccupancyRouterDependencies {
  store: SnapshotStore;
  pushToken: string;
  requireStudent: RequestHandler;
  onSnapshot(): void;
  usage?: StudentUsageActivity;
}

/** Creates authenticated student reads and the edge-only snapshot push route. */
export function createOccupancyRouter(dependencies: OccupancyRouterDependencies): Router {
  const router = Router();
  router.post('/api/edge/snapshot', express.json({ limit: '2mb' }), (req, res) => {
    if (!hasEdgeToken(req.get('authorization'), dependencies.pushToken)) return res.status(401).json({ error: 'bad edge token' });
    if (!isSnapshot(req.body)) return res.status(400).json({ error: 'not an occupancy snapshot' });
    dependencies.store.put(req.body);
    dependencies.onSnapshot();
    return res.json({ ok: true });
  });
  router.get('/api/occupancy', dependencies.requireStudent, (_req, res) => res.json(dependencies.store.view()));
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
