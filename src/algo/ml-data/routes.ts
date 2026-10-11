import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AlgoAuth } from '../auth.js';
import { DataError, PostgresTrainingDatabase, readerUrl, type TrainingDatabase } from './database.js';
import { DIAGRAM_FILE, schemaDiagram, schemaHtml } from './schema-report.js';
import { Exports, nativeDump, type ExportJob } from './exports.js';

const summary = ({ id, state, tables, createdAt, expiresAt, bytes, sha256, error }: ExportJob) => ({ id, state, tables, createdAt, expiresAt, bytes, sha256, error });
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  if (!env[name]) return fallback;
  const value = Number(env[name]);
  if (!/^\d+$/.test(env[name] ?? '') || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export interface MlDataOptions { env: NodeJS.ProcessEnv; dataDir: string; db?: TrainingDatabase; exports?: Exports }
export function createMlData(auth: Pick<AlgoAuth, 'principalOf' | 'accountEpoch'>, options: MlDataOptions) {
  const url = readerUrl(options.env);
  const db = options.db ?? (url ? new PostgresTrainingDatabase(url) : null);
  const exports = options.exports ?? (db && url ? new Exports(join(options.dataDir, 'algo', 'ml-exports'), db,
    nativeDump(url, options.env.ML_PG_DUMP || 'pg_dump'), positive(options.env, 'ML_EXPORT_MAX_BYTES', 8 * 1024 ** 3),
    positive(options.env, 'ML_EXPORT_RESERVE_BYTES', 1024 ** 3)) : null);
  const schemaDir = options.env.ML_SCHEMA_DIR || join(options.dataDir, 'algo', 'ml-schema');
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store, no-transform', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' });
    const user = auth.principalOf(req);
    if (!user) return void res.status(401).json({ error: 'Sign in to use ML data.' });
    if (!user.capabilities.includes('training.read')) return void res.status(403).json({ error: 'Training access is unavailable.' });
    if (req.method === 'POST' && req.get('x-tm-algo') !== '1') return void res.status(403).json({ error: 'missing x-tm-algo header' });
    next();
  });
  const current = (req: Request, owner: string, epoch: string | null, res: Response): boolean => {
    const user = auth.principalOf(req);
    if (!user || user.name !== owner || auth.accountEpoch(owner) !== epoch || !user.capabilities.includes('training.read')) {
      res.status(401).json({ error: 'Your session changed. Sign in again.' }); return false;
    }
    return true;
  };
  router.get('/schema', async (req, res) => {
    if (!db) return void res.json({ available: false, tables: [], report: false, error: 'The training database connection is not configured.' });
    const user = auth.principalOf(req); if (!user) return;
    const epoch = auth.accountEpoch(user.name);
    try {
      const tables = await db.schema();
      if (!current(req, user.name, epoch, res)) return;
      res.json({ available: true, tables, report: existsSync(join(schemaDir, 'index.html')), error: null });
    } catch { res.status(503).json({ available: false, tables: [], report: false, error: 'The training database is unavailable. Try again later.' }); }
  });
  router.get('/schema/diagram', (_req, res) => { res.json(schemaDiagram(schemaDir)); });
  router.get('/schema/diagram/image', (_req, res) => {
    if (!schemaDiagram(schemaDir).available) return void res.status(404).json({ error: 'Graphviz diagram unavailable.' });
    res.type('png').sendFile(resolve(schemaDir, DIAGRAM_FILE));
  });
  router.use('/schema/report', (req, res, next) => {
    // SchemaSpy writes trusted static HTML with inline scripts/styles. Its
    // separate framed document never relaxes the console's own CSP.
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'; connect-src 'none'; base-uri 'self'; form-action 'none'");
    const name = req.path === '/' ? '/index.html' : req.path;
    const root = resolve(schemaDir), file = resolve(root, '.' + name);
    if (name.endsWith('.html') && !name.split('/').some(part => part.startsWith('.')) && file.startsWith(root + sep) && existsSync(file)) {
      return void res.type('html').send(schemaHtml(root, file));
    }
    next();
  }, express.static(schemaDir, { dotfiles: 'deny', redirect: true, fallthrough: false, maxAge: 0 }));
  router.post('/query', async (req, res) => {
    if (!db) return void res.status(503).json({ error: 'The training database connection is not configured.' });
    if (typeof req.body?.sql !== 'string') return void res.status(400).json({ error: 'Enter a SELECT or WITH query.' });
    const user = auth.principalOf(req); if (!user) return;
    const epoch = auth.accountEpoch(user.name);
    try {
      const result = await db.query(req.body.sql);
      if (current(req, user.name, epoch, res)) res.json(result);
    } catch (error) { res.status(error instanceof DataError ? error.status : 503).json({ error: error instanceof DataError ? error.message : 'The training database is unavailable.' }); }
  });
  router.get('/exports', (req, res) => {
    const user = auth.principalOf(req); if (!user) return;
    res.json({ jobs: exports?.list(user.name, auth.accountEpoch(user.name)).map(summary) ?? [] });
  });
  router.post('/exports', (req, res) => {
    const user = auth.principalOf(req); if (!user) return;
    if (!user.capabilities.includes('training.write')) return void res.status(403).json({ error: 'Operator, Engineer or Admin access is required to generate an export.' });
    if (!exports) return void res.status(503).json({ error: 'The training database export service is not configured.' });
    try {
      const job = exports.start(user.name, auth.accountEpoch(user.name), req.body?.tables);
      res.status(202).location(`/api/ml-data/exports/${job.id}`).json(summary(job));
    } catch (error) { res.status(error instanceof DataError ? error.status : 503).json({ error: error instanceof DataError ? error.message : 'Could not start the export.' }); }
  });
  router.get('/exports/:id', (req, res) => {
    const user = auth.principalOf(req); if (!user) return;
    try {
      if (!exports) throw new DataError('Export not found.', 404);
      res.json(summary(exports.get(String(req.params.id), user.name, auth.accountEpoch(user.name))));
    } catch (error) { res.status(error instanceof DataError ? error.status : 503).json({ error: error instanceof DataError ? error.message : 'Export unavailable.' }); }
  });
  router.get('/exports/:id/download', (req, res) => {
    const user = auth.principalOf(req); if (!user) return;
    const epoch = auth.accountEpoch(user.name);
    try {
      if (!exports) throw new DataError('Export not found.', 404);
      const job = exports.get(String(req.params.id), user.name, epoch);
      if (job.state !== 'completed') throw new DataError('This export is not ready to download.', 409);
      const release = exports.lease(job.id);
      const check = setInterval(() => {
        const principal = auth.principalOf(req);
        if (!principal || principal.name !== user.name || auth.accountEpoch(user.name) !== epoch || !principal.capabilities.includes('training.read')) res.destroy();
      }, 5000).unref();
      res.once('close', () => { clearInterval(check); release(); });
      // sendFile streams, supports byte ranges for resumed downloads, and
      // sends headers before copying the file; no whole-file Buffer/blob.
      res.type('application/zip').download(exports.path(job.id), `ml-data-${job.id}.zip`, error => {
        clearInterval(check); release();
        if (error && !res.headersSent) res.status(404).json({ error: 'Export file is unavailable. Generate it again.' });
        else if (error) res.destroy();
      });
    } catch (error) { res.status(error instanceof DataError ? error.status : 503).json({ error: error instanceof DataError ? error.message : 'Export unavailable.' }); }
  });
  let stopping: Promise<void> | undefined;
  return { router, stop: () => stopping ??= (async () => { await exports?.stop(); await db?.close(); })() };
}
