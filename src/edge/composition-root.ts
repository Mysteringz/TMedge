import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAlgo, type AlgoServerHandle } from '../algo/server.js';
import { FirmwareBuildJobs } from '../modules/firmware/application/firmware-build-jobs.js';
import { FirmwareStoreExecutor } from '../infrastructure/firmware-build/firmware-store-executor.js';
import { FirmwareBuildWorkerClient } from '../infrastructure/firmware-build/firmware-build-worker-client.js';
import { DEFAULT_OCCUPANCY, OccupancyEngine, type OccupancyOptions } from './occupancy.js';
import { GatewayServer } from './gwlink.js';
import { Ingest } from './ingest.js';
import { NodeServer } from './nodelink.js';
import { Publisher } from './publisher.js';
import { Recorder } from './recorder.js';
import { Rollouts } from './rollout.js';
import { FirmwareStore } from './firmware.js';
import type { EdgeConfig } from './config.js';
import type { Registry } from './registry.js';
import { EdgeRuntime } from './runtime.js';
import { startConsole, stopConsole } from './console.js';
import type { ProvisioningService } from '../modules/provisioning/application/provisioning-service.js';

/** Creates the runtime with its infrastructure dependencies wired at the edge boundary. */
export function createEdgeRuntime(cfg: EdgeConfig, reg: Registry, occupancy: OccupancyOptions = DEFAULT_OCCUPANCY): EdgeRuntime {
  let runtime: EdgeRuntime | null = null;
  let gateways: GatewayServer | null = null;
  let direct: NodeServer | null = null;
  const engine = new OccupancyEngine(reg, cfg.edgeId, occupancy);
  const recorder = new Recorder(cfg.dataDir, cfg.recordRaw);
  const publisher = new Publisher(cfg.pushUrls, cfg.pushToken);
  const firmware = new FirmwareStore(join(cfg.dataDir, 'firmware'), { log: logRuntime });
  const ingest = new Ingest({
    port: cfg.udpPort,
    host: cfg.udpHost,
    verify: { keys: cfg.keys, allowUnsigned: cfg.allowUnsigned },
    commandKey: cfg.keys[0] ?? null,
    routeViaGateway: (address, bytes) => gateways?.sendDownlink(address, bytes) ?? false,
  });
  const rollouts = new Rollouts({
    image: (buildId) => {
      const build = firmware.get(buildId);
      const bytes = firmware.bytes(buildId);
      return build && bytes ? { bytes, sha256: build.sha256, size: build.size, version: build.version } : null;
    },
    nodes: () => runtime?.nodes().filter((node) => node.registered).map((node) => ({
      uid: node.uid, label: node.label, floorId: node.floorId, address: node.address,
      transport: node.transport, online: node.online,
    })) ?? [],
    sendImageToGateway: (id, metadata, bytes) => gateways?.sendImage(id, metadata, bytes) ?? false,
    sendOta: (uid, image) => ingest.sendOta(uid, image),
    onNodeDone: (uid) => direct?.revokeGrants(uid),
    directPort: cfg.consolePort,
    log: logRuntime,
  });
  if (cfg.gatewayPort > 0 && cfg.gatewayToken) {
    gateways = new GatewayServer({
      port: cfg.gatewayPort, host: '0.0.0.0', token: cfg.gatewayToken, edgeId: cfg.edgeId,
      onUplink: (datagram, source) => ingest.handle(datagram, source),
      onImageReady: (gatewayId, result) => rollouts.onImageReady(gatewayId, result),
      log: logRuntime,
    });
  }
  if (cfg.nodePort > 0) {
    direct = new NodeServer({
      host: cfg.nodeHost, port: cfg.nodePort, limits: cfg.nodeLimits, keys: cfg.keys,
      isRegistered: (uid) => reg.nodes.has(uid),
      ingest: (datagram, route) => ingest.handle(datagram, route),
      dropRoute: (uid, sessionId) => void ingest.dropDirectRoute(uid, sessionId),
      image: (buildId) => firmware.bytes(buildId),
      otaApproved: (uid, buildId) => rollouts.wantsDownload(uid, buildId),
      tls: cfg.nodeTls ? { cert: readFileSync(cfg.nodeTls.certPath), key: readFileSync(cfg.nodeTls.keyPath) } : undefined,
      log: logRuntime,
    });
  }
  runtime = new EdgeRuntime(cfg, reg, { ingest, engine, recorder, publisher, gateways, direct, firmware, rollouts });
  return runtime;
}

/** Composes and coordinates the required edge listeners and their lifecycles. */
export interface EdgeApplicationOptions {
  firmwareBuildJobs?: FirmwareBuildJobs;
  provisioningService?: ProvisioningService;
  closePersistence?: () => Promise<void>;
}

export function createEdgeApplication(cfg: EdgeConfig, reg: Registry, options: EdgeApplicationOptions = {}): EdgeApplication {
  const runtime = createEdgeRuntime(cfg, reg);
  const builds = options.firmwareBuildJobs ?? createFirmwareBuildJobs(runtime);
  const consoleServer = startConsole(runtime, { firmwareBuildJobs: builds, provisioningService: options.provisioningService, listen: false });
  const debuggerServer = cfg.algoPort > 0
    ? startAlgo(runtime, cfg.algoPort, cfg.consoleHost, { listen: false, dataDir: cfg.dataDir })
    : null;
  return new EdgeApplication(runtime, consoleServer, debuggerServer, cfg, options.closePersistence);
}

function createFirmwareBuildJobs(runtime: EdgeRuntime): FirmwareBuildJobs {
  const worker = new FirmwareBuildWorkerClient();
  return new FirmwareBuildJobs(new FirmwareStoreExecutor(runtime.firmware, worker));
}

/** Owns startup and shutdown of all long-lived edge components. */
export class EdgeApplication {
  private state: 'new' | 'started' | 'stopped' = 'new';
  private stopPromise: Promise<void> | null = null;

  constructor(
    readonly runtime: EdgeRuntime,
    readonly consoleServer: Server,
    readonly debuggerServer: AlgoServerHandle | null,
    private readonly config: EdgeConfig,
    private readonly closePersistence?: () => Promise<void>,
  ) {}

  /** Binds every configured listener before starting periodic runtime work. */
  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error(`edge application cannot start from state ${this.state}`);
    try {
      await this.runtime.ingest.start();
      await this.runtime.gateways?.listen();
      await this.runtime.direct?.listen();
      await listenHttp(this.consoleServer, this.config.consolePort, this.config.consoleHost);
      if (this.debuggerServer) await listenHttp(this.debuggerServer.server, this.config.algoPort, this.config.consoleHost);
      this.runtime.start();
      this.state = 'started';
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  /** Stops listeners, WebSockets, timers, build work, and recording exactly once. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.state = 'stopped';
    this.stopPromise = this.stopComponents();
    return this.stopPromise;
  }

  private async stopComponents(): Promise<void> {
    const closeServers = [closeHttp(this.consoleServer)];
    const cleanup = [stopConsole(this.consoleServer)];
    if (this.debuggerServer) {
      closeServers.push(closeHttp(this.debuggerServer.server));
      cleanup.push(this.debuggerServer.dispose());
    }
    const cleanupResults = await Promise.allSettled(cleanup);
    const closeResults = await Promise.allSettled(closeServers);
    const runtimeResult = await Promise.allSettled([this.runtime.stop()]);
    const persistenceResult = this.closePersistence ? await Promise.allSettled([this.closePersistence()]) : [];
    const failure = [...cleanupResults, ...closeResults, ...runtimeResult, ...persistenceResult]
      .find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

function listenHttp(server: Server, port: number, host: string): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function logRuntime(message: string): void {
  console.log(`[edge] ${message}`);
}
