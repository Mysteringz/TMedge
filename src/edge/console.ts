/**
 * The debug console: admin-only HTTP + WebSocket on the edge.
 *
 * It shows raw thermal frames, so it is the one place imagery reaches a
 * browser. That is why it lives on the edge (never the web tier), requires
 * ADMIN_PASSWORD, and without one binds to localhost only (see config.ts).
 *
 * Commands to nodes are POSTs that need a custom header, which a cross-site
 * form cannot send -- basic-auth credentials are attached by the browser
 * automatically, so without it any page the admin visits could reboot nodes.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { FirmwareStore } from './firmware.js';
import type { FirmwareBuildJobService } from '../modules/firmware/application/firmware-build-job-service.js';
import { FirmwareBuildJobs } from '../modules/firmware/application/firmware-build-jobs.js';
import { createFirmwareRouter } from '../modules/firmware/routes/firmware-router.js';
import { FirmwareStoreExecutor } from '../infrastructure/firmware-build/firmware-store-executor.js';
import { RolloutImageUsageQuery } from '../infrastructure/firmware-build/rollout-image-usage-query.js';
import { Provisioning } from './provisioning.js';
import { FileProvisioningService } from '../infrastructure/provisioning/file-provisioning-service.js';
import type { ProvisioningService } from '../modules/provisioning/application/provisioning-service.js';
import { createProvisioningAdminRouter, createProvisioningToolRouter } from '../modules/provisioning/routes/provisioning-routers.js';
import { applicationErrorHandler } from '../infrastructure/http/errors.js';
import type { EdgeRuntime } from './runtime.js';
import { ExecuteNodeCommand } from '../modules/nodes/application/execute-node-command.js';
import { ResetNodeCursor } from '../modules/nodes/application/reset-node-cursor.js';
import { createNodeRouter } from '../modules/nodes/routes/node-router.js';
import { ConsoleWebSocketAdapter } from '../modules/console-live/console-websocket-adapter.js';
import { FirmwareBuildWorkerClient } from '../infrastructure/firmware-build/firmware-build-worker-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const consoleCleanups = new WeakMap<Server, () => Promise<void>>();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startConsole(rt: EdgeRuntime, options: {
  firmwareBuildJobs?: FirmwareBuildJobService;
  provisioningService?: ProvisioningService;
  listen?: boolean;
} = {}): Server {
  const { adminPassword, consolePort, consoleHost } = rt.cfg;
  const provisioningService = options.provisioningService ?? new FileProvisioningService(new Provisioning(rt.reg, {
    token: rt.cfg.flashToken,
    nodesPath: rt.cfg.nodesPath,
    auditPath: join(rt.cfg.dataDir, 'provisioning.jsonl'),
  }));
  let broadcastProvisioning = (_message: unknown): void => {};
  const app = express();
  app.disable('x-powered-by');

  // RGB frames from verification rigs. Before the admin check because the
  // sender is a node, not a person: it signs each frame with the site key
  // over (uid, timestamp, sha256(jpeg)). Only nodes flagged "rgb" in
  // nodes.json are accepted; frames live in memory and reach only this console.
  const lastRgbTs = new Map<string, number>();
  app.post('/api/demo/rgb/:uid', express.raw({ type: 'image/jpeg', limit: '600kb' }), (req, res) => {
    const uid = (req.params.uid ?? '').toLowerCase();
    const node = rt.reg.nodes.get(uid);
    if (!node?.rgb) return res.status(403).json({ error: 'not an RGB-enabled node' });
    const ts = Number(req.get('x-tm-ts'));
    const now = Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 30_000 || ts <= (lastRgbTs.get(uid) ?? 0)) {
      return res.status(401).json({ error: 'stale or replayed frame' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) return res.status(400).json({ error: 'not a JPEG' });
    const msg = `${uid}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`;
    const got = req.get('x-tm-sig') ?? '';
    const ok = rt.cfg.keys.some((k) => safeEqual(got, createHmac('sha256', k).update(msg).digest('hex')));
    if (!ok) return res.status(401).json({ error: 'bad signature' });
    lastRgbTs.set(uid, ts);
    rt.acceptRgb(uid, body, now);
    return res.status(204).end();
  });

  /**
   * The firmware image itself, for a node that talks to this edge directly;
   * one behind a gateway fetches from its gateway instead. Before the admin
   * check for the same reason as the RGB endpoint: the caller is a node, not
   * a person. It is safe to serve: the release build bakes in no secrets, and
   * the node accepts the bytes only if they hash to the SHA-256 in the signed
   * request that sent it here.
   */
  app.get('/fw/:image', (req, res) => {
    const id = /^([0-9a-f]{16})\.bin$/.exec(req.params.image ?? '')?.[1];
    const bytes = id ? rt.firmware.bytes(id) : null;
    if (!bytes) return res.status(404).end();
    res.set('Content-Type', 'application/octet-stream');
    return res.end(bytes);
  });

  app.use('/api/provision', express.json({ limit: '4kb' }), createProvisioningToolRouter({
    service: provisioningService,
    broadcast: (message) => broadcastProvisioning(message),
  }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) return next();
    const h = req.headers.authorization ?? '';
    const [scheme, b64] = h.split(' ');
    const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass && safeEqual(pass, adminPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="TMedge console"').status(401).send('authentication required');
  });

  app.use(express.json({ limit: '4kb' }));
  // Never cached. Express would send max-age=0 with an ETag, which is correct
  // and not enough: Cloudflare caches by file extension in front of this, so a
  // .js file can be served from the edge long after a deploy -- the same trap
  // that once left the student site on last week's stylesheet. There are a
  // handful of admins on this page and revalidating costs nothing, so the
  // whole class of "is this the new one?" simply goes away.
  app.use(express.static(join(ROOT, 'public-console'), {
    index: 'index.html',
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  }));

  app.get('/api/layout', (_req, res) => res.json(rt.layout()));
  app.get('/api/state', (_req, res) => res.json(state(rt)));
  const mutating = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-tm-console') !== '1') return res.status(403).json({ error: 'missing x-tm-console header' });
    return next();
  };

  app.use('/api/nodes', createNodeRouter({
    reads: {
      rgb: (uid) => rt.rgb.get(uid) ?? null,
      raw: (uid) => rt.lastRaw(uid),
    },
    executeCommand: new ExecuteNodeCommand(({ uid, opcode, argument, value }) =>
      rt.commandOutcomes
        ? rt.commandOutcomes.send({ uid, opcode, argument, value }, { id: 'console', kind: 'console' })
        : rt.ingest.sendCommand(uid, opcode, argument, value).then(() => undefined)),
    resetCursor: new ResetNodeCursor((uid) => rt.ingest.resetCursor(uid)),
    mutating,
  }));

  app.use('/api/provision', createProvisioningAdminRouter({
    service: provisioningService,
    mutating,
    broadcast: (message) => broadcastProvisioning(message),
  }));

  // A short-lived token for the WebSocket, which cannot carry basic auth reliably.
  const firmwareBuildWorker = new FirmwareBuildWorkerClient();
  const firmwareBuildJobs: FirmwareBuildJobService = options.firmwareBuildJobs ?? new FirmwareBuildJobs(new FirmwareStoreExecutor(rt.firmware, firmwareBuildWorker));
  const imageInUse = new RolloutImageUsageQuery(rt.rollouts);
  rt.firmware.cleanup(imageInUse);
  app.use('/api', createFirmwareRouter({
    firmware: rt.firmware,
    buildJobs: firmwareBuildJobs,
    rollouts: rt.rolloutService,
    imageInUse,
    mutating,
    buildWorkerConfigured: () => firmwareBuildWorker.configured,
  }));

  const server = createServer(app);
  const live = new ConsoleWebSocketAdapter(server, rt, () => state(rt));
  live.start();
  let cleanup: Promise<void> | null = null;
  const dispose = () => {
    cleanup ??= Promise.all([firmwareBuildJobs.dispose?.() ?? Promise.resolve(), live.close()]).then(() => undefined);
    return cleanup;
  };
  consoleCleanups.set(server, dispose);
  server.once('close', () => { void dispose(); });
  broadcastProvisioning = (message) => live.broadcast(message);
  app.get('/api/ws-token', (_req, res) => res.json({ token: live.issueToken() }));
  app.use(applicationErrorHandler);

  if (options.listen !== false) server.listen(consolePort, consoleHost);
  return server;
}

/** Awaits console-owned WebSocket and firmware worker cleanup. */
export function stopConsole(server: Server): Promise<void> {
  return consoleCleanups.get(server)?.() ?? Promise.resolve();
}

function state(rt: EdgeRuntime) {
  const now = Date.now();
  return {
    health: rt.health(now),
    nodes: rt.nodes(now),
    snapshot: rt.latest,
    authorities: rt.engine.authorities(),
    dwell: Object.fromEntries([...rt.dwell].map(([id, d]) => [id, d.toJSON()])),
  };
}
