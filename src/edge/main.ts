/** Process entry point: configuration, composition, signals, and fatal startup handling. */
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEdgeConfig, EnvError } from './config.js';
import { createEdgeApplication } from './composition-root.js';
import { buildRegistry, buildRegistryFromLocationDocuments, ConfigError, type Registry } from './registry.js';
import { parseLocationDocument } from '../modules/location-config/domain/location-document.js';
import type { ProvisioningRepository } from '../modules/provisioning/repositories/provisioning-repository.js';
import { PostgresRegistryRepository } from '../infrastructure/postgres/registry-repository.js';
import { PostgresProvisioningRepository } from '../infrastructure/postgres/provisioning-repository.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { initializeFileLocationPersistence } from '../infrastructure/location-config/file-location-storage.js';
import { PostgresRegistryMutationCoordinator } from '../infrastructure/location-config/postgres-registry-mutation-coordinator.js';
import { bootstrapPostgresLegacyLocations } from '../infrastructure/postgres/location-storage-bootstrap.js';
import { PostgresLocationDraftRepository, PostgresPublishedLocationRepository } from '../infrastructure/postgres/location-configuration-repositories.js';
import { PostgresLocationRegistrySnapshotRepository } from '../infrastructure/postgres/location-registry-snapshot-repository.js';
import type { LocationRegistrySnapshot, RegistryMutationCoordinator } from '../modules/location-config/repositories/location-storage.js';
import type { DataSource } from 'typeorm';

function checkNodesWritable(nodesPath: string): void {
  try {
    accessSync(nodesPath, constants.W_OK);
  } catch {
    throw new EnvError(`TMFLASH_TOKEN is set but ${nodesPath} is not writable: approving a node would fail. Point NODES_CONFIG at a writable copy.`);
  }
  const real = realpathSync(nodesPath);
  if (/[/\\]tmedge-releases[/\\]/.test(real) || real.startsWith(resolve(process.cwd()) + '/config/')) {
    throw new EnvError(`TMFLASH_TOKEN is set but ${nodesPath} is inside the release (${real}); admitted nodes would be lost on the next deploy. Point NODES_CONFIG at /opt/tmedge-shared/nodes.json.`);
  }
}

async function main(): Promise<void> {
  const loaded = await loadConfiguration();
  if (!loaded) return;
  const { cfg, registry, source, provisioningRepository, locationPublication } = loaded;
  const edge = createEdgeApplication(cfg, registry, {
    provisioningRepository,
    provisioningToken: cfg.flashToken,
    registryMutationCoordinator: loaded.registryMutationCoordinator,
    locationPublication,
    postgres: source ?? undefined,
    closePersistence: loaded.closePersistence,
  });
  const rejectBudgetTimer = installRuntimeLogs(edge.runtime);
  let shuttingDown = false;  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(rejectBudgetTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    console.log('[edge] shutting down');
    try {
      await edge.stop();
    } catch (error) {
      console.error(`[edge] shutdown failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await edge.start();
    logStartup(edge.runtime, cfg, registry);
  } catch (error) {
    clearInterval(rejectBudgetTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    console.error(`[edge] startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function loadConfiguration(): Promise<{
  cfg: ReturnType<typeof loadEdgeConfig>;
  registry: Registry;
  source: DataSource | null;
  provisioningRepository: ProvisioningRepository | undefined;
  locationPublication: NonNullable<NonNullable<Parameters<typeof createEdgeApplication>[2]>['locationPublication']>;
  registryMutationCoordinator: RegistryMutationCoordinator;
  closePersistence: () => Promise<void>;
} | null> {
  let source: DataSource | null = null;
  let filePersistence: ReturnType<typeof initializeFileLocationPersistence> | null = null;
  try {
    const cfg = loadEdgeConfig();
    if (cfg.persistenceMode === 'file') {
      filePersistence = initializeFileLocationPersistence(cfg.sitePath, cfg.nodesPath, cfg.dataDir);
      const registry = filePersistence.registry;
      if (cfg.flashToken) checkNodesWritable(cfg.nodesPath);
      return { cfg, registry, source: null, provisioningRepository: undefined,
        registryMutationCoordinator: filePersistence.coordinator,
        locationPublication: {
          siteSeed: filePersistence.siteSeed, drafts: filePersistence.drafts,
          published: filePersistence.published, snapshots: filePersistence.snapshots,
        },
        closePersistence: async () => filePersistence?.close() };
    }
    if (!cfg.postgres) throw new EnvError('PostgreSQL runtime configuration is missing');
    source = await openPostgres(cfg.postgres);
    let site: unknown;
    try {
      site = JSON.parse(readFileSync(cfg.sitePath, 'utf8'));
    } catch (error) {
      throw new ConfigError(`${cfg.sitePath}: ${(error as Error).message}`);
    }
    const seedRegistry = buildRegistry(site, { nodes: [] });
    const mutationCoordinator = new PostgresRegistryMutationCoordinator(source);
    const registryRepository = new PostgresRegistryRepository(source, mutationCoordinator);
    await bootstrapPostgresLegacyLocations(source, seedRegistry, mutationCoordinator);
    const published = new PostgresPublishedLocationRepository(source, new Set(seedRegistry.floors.map((floor) => floor.id)), mutationCoordinator);
    const snapshots = new PostgresLocationRegistrySnapshotRepository(site, registryRepository, published);
    const drafts = new PostgresLocationDraftRepository(source);
    const initialSnapshot = await mutationCoordinator.withMutationLock(() => snapshots.readSnapshot());
    const active = activeDocuments(initialSnapshot);
    const registry = buildRegistryFromLocationDocuments(site, nodesConfigFor(initialSnapshot), active.documents, active.legacySpatialByLocation);
    const provisioningRepository = new PostgresProvisioningRepository(source);
    return { cfg, registry, source, provisioningRepository,
      registryMutationCoordinator: mutationCoordinator,
      locationPublication: { siteSeed: site, drafts, published, snapshots },
      closePersistence: () => closePostgres(source!) };
  } catch (error) {
    if (filePersistence) filePersistence.close();
    if (source) await closePostgres(source).catch(() => undefined);
    if (error instanceof EnvError || error instanceof ConfigError) {
      console.error(`[edge] refusing to start: ${error.message}`);
      process.exitCode = 2;
      return null;
    }
    if (error instanceof Error && 'name' in error && error.name === 'PostgresConfigError') {
      console.error(`[edge] refusing to start: ${error.message}`);
    } else if (source || loadEdgePersistenceMode()) {
      console.error('[edge] refusing to start: PostgreSQL registry could not be opened or validated');
    } else {
      console.error(`[edge] refusing to start: ${errorMessage(error)}`);
    }
    process.exitCode = 2;
    return null;
  }
}

function nodesConfigFor(snapshot: LocationRegistrySnapshot): unknown {
  return { nodes: snapshot.nodes.map((node) => ({
    uid: node.uid, label: node.label, ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
    owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
  })) };
}

function activeDocuments(snapshot: LocationRegistrySnapshot) {
  const legacySpatialByLocation = new Map(snapshot.locations.flatMap((state) => {
    const active = state.history.find((revision) => revision.revision === state.activeRevision);
    return state.activeRevision !== 0 && active?.legacySpatial ? [[state.locationId, active.legacySpatial] as const] : [];
  }));
  const documents = snapshot.locations.flatMap((state) => {
    if (state.activeRevision === 0) return [];
    const active = state.history.find((revision) => revision.revision === state.activeRevision);
    return active ? [parseLocationDocument(active.document)] : [];
  });
  return { documents, legacySpatialByLocation };
}

function loadEdgePersistenceMode(): boolean {
  return process.env.PERSISTENCE_MODE === 'postgres';
}

function installRuntimeLogs(runtime: ReturnType<typeof createEdgeApplication>['runtime']): NodeJS.Timeout {
  let rejectLogBudget = 20;
  runtime.ingest.on('listening', (address) => console.log(`[edge] UDP ${address.address}:${address.port} (TMnode uplink)`));
  runtime.ingest.on('error', (error) => console.error(`[edge] UDP error: ${error.message}`));
  runtime.ingest.on('rejected', (address, reason) => {
    if (rejectLogBudget-- > 0) console.warn(`[edge] rejected packet from ${address}: ${reason}`);
  });
  const timer = setInterval(() => { rejectLogBudget = 20; }, 60_000);
  timer.unref();
  return timer;
}

function logStartup(runtime: ReturnType<typeof createEdgeApplication>['runtime'], cfg: ReturnType<typeof loadEdgeConfig>, registry: Registry): void {
  const tables = [...registry.tables.values()];
  console.log(`[edge] debug console http://${cfg.consoleHost}:${cfg.consolePort}${cfg.adminPassword ? ' (password protected)' : ' (localhost only: no ADMIN_PASSWORD)'}`);
  if (cfg.algoPort > 0) console.log(`[edge] algo debugger http://${cfg.consoleHost}:${cfg.algoPort}${cfg.adminPassword ? ' (password protected)' : ' (localhost only: no ADMIN_PASSWORD)'}`);
  if (cfg.gatewayPort > 0) console.log(`[edge] access gateways: TCP 0.0.0.0:${cfg.gatewayPort} (TMGW v1)`);
  if (cfg.nodePort > 0) console.log(`[edge] direct nodes: ${cfg.nodeTls ? 'wss' : 'ws'}://${cfg.nodeHost}:${cfg.nodePort}/tmnode (tmnode.v1)`);
  console.log(`[edge] ${cfg.edgeId}: ${registry.floors.length} floor(s), ${tables.length} tables, ${tables.reduce((sum, table) => sum + table.capacity, 0)} seats, ${registry.nodes.size} registered nodes`);
  console.log(`[edge] signing: ${cfg.keys.length ? `${cfg.keys.length} key(s)` : 'none'}${cfg.allowUnsigned ? ', UNSIGNED ACCEPTED' : ''}`);
  console.log(`[edge] publishing to ${cfg.pushUrls.join(', ') || '(nowhere)'} every ${cfg.publishMs} ms; recording to ${cfg.dataDir}${cfg.recordRaw ? ' (with raw frames)' : ''}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
