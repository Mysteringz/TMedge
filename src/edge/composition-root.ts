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
import { consoleMovedTo, createConsole, startConsole, stopConsole } from './console.js';
import type { ProvisioningService } from '../modules/provisioning/application/provisioning-service.js';
import type { DataSource } from 'typeorm';
import type { FirmwareBuildJobService } from '../modules/firmware/application/firmware-build-job-service.js';
import { DurableFirmwareBuildJobService } from '../modules/firmware/application/durable-firmware-build-job-service.js';
import { PostgresFirmwareArtifactRepository, PostgresFirmwareBuildJobRepository } from '../infrastructure/postgres/firmware-build-repositories.js';
import { PostgresOccupancyHistoryRepository } from '../infrastructure/postgres/occupancy-history-repository.js';
import { BoundedOccupancyHistorySink } from '../modules/occupancy-history/application/bounded-occupancy-history-sink.js';
import { DurableCommandOutcomes } from '../modules/nodes/application/durable-command-outcomes.js';
import { PostgresCommandOutcomeRepository } from '../infrastructure/postgres/command-outcome-repository.js';
import { PostgresRolloutRepository } from '../infrastructure/postgres/rollout-repository.js';
import { DurableRolloutService } from '../modules/rollouts/application/durable-rollout-service.js';
import type { RolloutRepository } from '../modules/rollouts/repositories/rollout-repository.js';
import { postgresAvailability } from '../infrastructure/postgres/data-source.js';

/** Persistence adapters are optional in legacy file mode. */
export interface EdgeRuntimePersistenceOptions {
  occupancyHistory?: BoundedOccupancyHistorySink;
  commandOutcomeRepository?: PostgresCommandOutcomeRepository;
  rolloutRepository?: RolloutRepository;
  persistenceAvailable?: () => Promise<boolean>;
}

/** Creates the runtime with its infrastructure dependencies wired at the edge boundary. */
export function createEdgeRuntime(
  cfg: EdgeConfig, reg: Registry, occupancy: OccupancyOptions = DEFAULT_OCCUPANCY,
  persistence: EdgeRuntimePersistenceOptions = {},
): EdgeRuntime {
  let runtime: EdgeRuntime | null = null;
  let gateways: GatewayServer | null = null;
  let direct: NodeServer | null = null;
  const engine = new OccupancyEngine(reg, cfg.edgeId, occupancy);
  const recorder = new Recorder(cfg.dataDir, cfg.recordRaw);
  const publisher = new Publisher(cfg.pushUrls, cfg.pushToken);
  const occupancyHistory = persistence.occupancyHistory ?? null;
  const firmware = new FirmwareStore(join(cfg.dataDir, 'firmware'), { log: logRuntime, persistMetadata: cfg.persistenceMode === 'file' });
  const ingest = new Ingest({
    port: cfg.udpPort,
    host: cfg.udpHost,
    verify: { keys: cfg.keys, allowUnsigned: cfg.allowUnsigned, devices: cfg.devices },
    cursorPath: join(cfg.dataDir, 'replay.jsonl'),
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
      encryptionRequired: !!ingest.links.get(node.uid)?.secureId || !!cfg.devices?.keys(node.uid).length,
    })) ?? [],
    sendImageToGateway: (id, metadata, bytes) => gateways?.sendImage(id, metadata, bytes) ?? false,
    sendOta: (uid, image) => ingest.sendOta(uid, image),
    onNodeDone: (uid) => direct?.revokeGrants(uid),
    directPort: cfg.consolePort,
    log: logRuntime,
  });
  if (cfg.gatewayPort > 0 && (cfg.gatewayToken || cfg.gatewayKeys)) {
    gateways = new GatewayServer({
      port: cfg.gatewayPort, host: '0.0.0.0', token: cfg.gatewayToken ?? Buffer.alloc(0), edgeId: cfg.edgeId,
      tokens: cfg.gatewayKeys ? (id) => cfg.gatewayKeys!.tokens(id) : undefined,
      helloPath: join(cfg.dataDir, 'gateway-hellos.json'),
      allowRawTcp: cfg.gatewayAllowRawTcp ?? false,
      onUplink: (datagram, source) => ingest.handleDurable(datagram, source),
      onImageReady: (gatewayId, result) => rollouts.onImageReady(gatewayId, result),
      log: logRuntime,
    });
  }
  if (cfg.nodePort > 0) {
    direct = new NodeServer({
      host: cfg.nodeHost, port: cfg.nodePort, limits: cfg.nodeLimits, keys: cfg.keys, devices: cfg.devices,
      isRegistered: (uid) => reg.nodes.has(uid),
      ingest: (datagram, route) => ingest.handleDurable(datagram, route),
      dropRoute: (uid, sessionId) => void ingest.dropDirectRoute(uid, sessionId),
      image: (buildId) => firmware.bytes(buildId),
      otaApproved: (uid, buildId) => rollouts.wantsDownload(uid, buildId),
      tls: cfg.nodeTls ? { cert: readFileSync(cfg.nodeTls.certPath), key: readFileSync(cfg.nodeTls.keyPath) } : undefined,
      log: logRuntime,
    });
  }
  const commandOutcomes = persistence.commandOutcomeRepository
    ? new DurableCommandOutcomes(persistence.commandOutcomeRepository, (command) => ingest.sendCommand(command.uid, command.opcode, command.argument, command.value))
    : null;
  const rolloutService = persistence.rolloutRepository
    ? new DurableRolloutService(rollouts, persistence.rolloutRepository)
    : rollouts;
  runtime = new EdgeRuntime(cfg, reg, {
    ingest, engine, recorder, publisher, gateways, direct, firmware, rollouts,
    occupancyHistory: occupancyHistory ?? undefined, commandOutcomes: commandOutcomes ?? undefined, rolloutService,
    persistenceAvailable: persistence.persistenceAvailable,
  });
  return runtime;
}

/** Composes and coordinates the required edge listeners and their lifecycles. */
export interface EdgeApplicationOptions {
  firmwareBuildJobs?: FirmwareBuildJobService;
  provisioningService?: ProvisioningService;
  postgres?: DataSource;
  closePersistence?: () => Promise<void>;
  occupancyHistory?: BoundedOccupancyHistorySink;
}

export function createEdgeApplication(cfg: EdgeConfig, reg: Registry, options: EdgeApplicationOptions = {}): EdgeApplication {
  const runtime = createEdgeRuntime(cfg, reg, DEFAULT_OCCUPANCY, {
    occupancyHistory: options.occupancyHistory ?? (options.postgres ? new BoundedOccupancyHistorySink(new PostgresOccupancyHistoryRepository(options.postgres)) : undefined),
    commandOutcomeRepository: options.postgres ? new PostgresCommandOutcomeRepository(options.postgres) : undefined,
    rolloutRepository: options.postgres ? new PostgresRolloutRepository(options.postgres) : undefined,
    persistenceAvailable: options.postgres ? async () => (await postgresAvailability(options.postgres!)).available : undefined,
  });
  const builds = options.firmwareBuildJobs ?? (options.postgres ? createDurableFirmwareBuildJobs(runtime, options.postgres) : createFirmwareBuildJobs(runtime));
  // Both listeners share the injected services and the same live feed.
  const consoleCore = createConsole(runtime, {
    firmwareBuildJobs: builds, provisioningService: options.provisioningService,
  });
  const consoleServer = startConsole(runtime, consoleCore, {
    listen: false, uiMovedTo: cfg.algoPort > 0 ? consoleMovedTo(cfg.algoPort) : undefined,
  });
  const debuggerServer = cfg.algoPort > 0
    ? startAlgo(runtime, cfg.algoPort, cfg.consoleHost, { listen: false, dataDir: cfg.dataDir }, consoleCore)
    : null;
  return new EdgeApplication(runtime, consoleServer, debuggerServer, cfg, options.closePersistence,
    async () => {
      if (builds instanceof DurableFirmwareBuildJobService) await builds.initialize();
      await runtime.commandOutcomes?.initialize();
      await runtime.rolloutService.initialize?.();
    });
}

function createFirmwareBuildJobs(runtime: EdgeRuntime): FirmwareBuildJobs {
  const worker = new FirmwareBuildWorkerClient();
  return new FirmwareBuildJobs(new FirmwareStoreExecutor(runtime.firmware, worker));
}

function createDurableFirmwareBuildJobs(runtime: EdgeRuntime, source: DataSource): DurableFirmwareBuildJobService {
  const artifacts = new PostgresFirmwareArtifactRepository(source, { read: (id, sha256, size) => runtime.firmware.readArtifactContent(id, sha256, size) });
  return new DurableFirmwareBuildJobService({
    repository: new PostgresFirmwareBuildJobRepository(source, { read: (id, sha256, size) => runtime.firmware.readArtifactContent(id, sha256, size) }),
    artifacts,
    executor: new FirmwareStoreExecutor(runtime.firmware, new FirmwareBuildWorkerClient(), true),
    hydrateArtifacts: (rows, jobs) => runtime.firmware.hydrateDurableArtifacts(rows, jobs),
    activateArtifact: (id) => runtime.firmware.activateBuild(id),
  });
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
    private readonly initializePersistence?: () => Promise<void>,
  ) {}

  /** Binds every configured listener before starting periodic runtime work. */
  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error(`edge application cannot start from state ${this.state}`);
    try {
      await this.initializePersistence?.();
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
