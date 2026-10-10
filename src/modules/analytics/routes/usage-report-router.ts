/**
 * The web tier's usage report, for the edge.
 *
 * It answers to the same credential that authorises a snapshot push and to
 * nothing else: no student session reaches it, and nothing a student sends
 * can change what it says. The body is counts (shared/analytics.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { isAnalyticsRange, type AnalyticsRangeId, type StudentUsageReport } from '../../../shared/analytics.js';
import type { SnapshotPublishers } from '../../../web/publishers.js';

export interface UsageReportRouterDependencies {
  pushToken: string;
  publishers?: SnapshotPublishers;
  report(range: AnalyticsRangeId): Promise<StudentUsageReport>;
}

export function createUsageReportRouter(deps: UsageReportRouterDependencies): Router {
  const router = Router();
  router.get('/api/edge/usage', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    const authenticated = deps.publishers
      ? deps.publishers.authenticate(req.query.edgeId, token)
      : hasEdgeToken(token, deps.pushToken);
    if (!authenticated) return res.status(401).json({ error: 'bad edge token' });
    if (!isAnalyticsRange(req.query.range)) return res.status(400).json({ error: 'range must be 1h, 24h, 7d or 30d' });
    return res.json(await deps.report(req.query.range));
  }));
  return router;
}

function hasEdgeToken(actual: Buffer, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  // An unset token must never match an absent header.
  return expected.length >= 16 && actual.length === expected.length && timingSafeEqual(actual, expected);
}
