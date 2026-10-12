import { Router } from 'express';
import type { PublishedReleaseSource } from '../../../infrastructure/firmware-release/github-release-source.js';
import { ReleaseUnavailable } from '../../../shared/flasher/release.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';

/**
 * `/api/flash` on the algo console: the TMsense release module 07 writes to a
 * board, as the edge fetched and checked it (docs/WEB_FLASHER.md).
 *
 * Read-only, for signed-in members. Nothing is accepted here: there is no
 * route by which a person or a page can hand this console firmware to offer.
 */
export function createPublishedReleaseRouter(source: PublishedReleaseSource): Router {
  const router = Router();
  router.get('/firmware', asyncHandler(async (_req, res) => {
    try {
      return res.json(await source.latest());
    } catch (error) {
      const known = error instanceof ReleaseUnavailable ? error : new ReleaseUnavailable('unreachable', 'the TMsense release could not be read');
      // No release is an answer about the repository; the rest are about the fetch.
      return res.status(known.reason === 'none' ? 404 : 502).json({ error: known.message, reason: known.reason });
    }
  }));
  router.get('/firmware/:tag/:name', (req, res) => {
    const bytes = source.bytes(routeParam(req.params, 'tag'), routeParam(req.params, 'name'));
    if (!bytes) return res.status(404).json({ error: 'that file is not part of the release on offer' });
    return res.set({ 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }).end(bytes);
  });
  return router;
}
