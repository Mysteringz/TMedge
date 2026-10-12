import { Router } from 'express';
import type { TMflashReleaseSource } from '../../../infrastructure/tmflash-release/github-tmflash-source.js';
import { asyncHandler } from '../../../infrastructure/http/errors.js';
import { routeParam } from '../../../shared/http.js';
import { TMflashUnavailable } from '../../../shared/tmflash-release.js';

/** Mounted after human sign-in. Only verified GitHub release files leave it. */
export function createTMflashDownloadRouter(source: TMflashReleaseSource): Router {
  const router = Router();
  const failure = (error: unknown) => error instanceof TMflashUnavailable ? error :
    new TMflashUnavailable('unreachable', 'The TMflash download is temporarily unavailable.');
  router.get('/release', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await source.latest()); }
    catch (error) { const known = failure(error); return res.status(known.reason === 'none' ? 404 : 502).json({ error: known.message, reason: known.reason }); }
  }));
  router.get('/files/:tag/:filename', asyncHandler(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try { await source.latest(); }
    catch (error) { const known = failure(error); return res.status(known.reason === 'none' ? 404 : 502).json({ error: known.message, reason: known.reason }); }
    const filename = routeParam(req.params, 'filename');
    const file = source.file(routeParam(req.params, 'tag'), filename);
    if (!file) return res.status(404).json({ error: 'That TMflash build is no longer available. Refresh the download page.' });
    res.type('application/x-apple-diskimage');
    return res.download(file, filename, { cacheControl: false, dotfiles: 'deny' }, error => { if (error) next(error); });
  }));
  return router;
}
