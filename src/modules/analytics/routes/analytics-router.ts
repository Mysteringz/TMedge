/** `GET /api/analytics?range=…` on the algo console: read-only, for anyone who may read the console. */
import { gzip } from 'node:zlib';
import express, { type Router } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { isAnalyticsRange } from '../../../shared/analytics.js';
import type { ReadAnalytics } from '../application/read-analytics.js';

export function createAnalyticsRouter(auth: Pick<AlgoAuth, 'principalOf' | 'accountEpoch'>, read: Pick<ReadAnalytics, 'execute'>): Router {
  const router = express.Router();
  const refuse = (res: express.Response, status: 401 | 403) => void res.status(status).json({
    data: null,
    error: status === 401 ? { code: 'unauthenticated', message: 'Sign in to view analytics.' } : { code: 'forbidden', message: 'Analytics access is unavailable.' },
  });
  router.get('/', async (req, res) => {
    const principal = auth.principalOf(req);
    if (!principal) return refuse(res, 401);
    if (!principal.capabilities.includes('algo.read')) return refuse(res, 403);
    const range = req.query.range ?? '24h';
    if (!isAnalyticsRange(range)) return void res.status(400).json({ data: null, error: { code: 'validation', message: 'Range must be 1h, 24h, 7d or 30d.' } });
    const epoch = auth.accountEpoch(principal.name);
    let data;
    try { data = await read.execute(range); } catch {
      // Whatever went wrong inside, its text is not for a browser.
      return void res.status(503).json({ data: null, error: { code: 'unavailable', message: 'Analytics are unavailable right now.' } });
    }
    // Assembling the page waits on other processes. The account may have been
    // disabled or demoted in that time, and the answer must not outlive it.
    const current = auth.principalOf(req);
    if (!current || auth.accountEpoch(principal.name) !== epoch) return refuse(res, 401);
    if (current.name !== principal.name || !current.capabilities.includes('algo.read')) return refuse(res, 403);
    res.set('Cache-Control', 'no-store');
    // A page of charts is a few hundred series points of repetitive JSON, and
    // an open tab asks for it again every few seconds. Compressed here, at the
    // origin, it is about a tenth of the bytes this box pays to send.
    const body = Buffer.from(JSON.stringify({ data, error: null }));
    if (!/\bgzip\b/.test(req.get('accept-encoding') ?? '')) return void res.type('json').send(body);
    gzip(body, { level: 6 }, (error, packed) => {
      if (error) return void res.type('json').send(body);
      res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).type('json').send(packed);
    });
  });
  return router;
}
