import { randomUUID } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { RateLimiter } from '../application/student-session-service.js';
import type { StudentUsageActivity } from '../application/student-usage-activity.js';
import { sameOrigin } from './student-auth-router.js';

export function createStudentUsageRouter(deps: { requireStudent: RequestHandler; usage: StudentUsageActivity }): Router {
  const router = Router();
  const limiter = new RateLimiter(120, 60_000);
  router.post('/api/activity', deps.requireStudent, sameOrigin, (req, res, next) => {
    const site = req.get('sec-fetch-site');
    if (req.get('x-tm-student-activity') !== '1' || (site && site !== 'same-origin' && site !== 'none')) {
      return res.status(403).json({ error: 'same-origin activity request required' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'activity must be JSON' });
    const userId: unknown = res.locals.studentUserId;
    if (typeof userId === 'string' && !limiter.allow(userId)) return res.status(429).json({ error: 'too many activity requests' });
    return next();
  }, express.json({ limit: '2kb' }), asyncHandler(async (req, res) => {
    const userId: unknown = res.locals.studentUserId;
    deps.usage.record(typeof userId === 'string' ? userId : undefined, req.body, randomUUID());
    return res.status(202).json({ ok: true });
  }));
  return router;
}
