/** Process entry point: configuration, composition, signals, and fatal startup handling. */
import { accessSync, constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEdgeConfig, EnvError } from './config.js';
import { createEdgeApplication } from './composition-root.js';
import { ConfigError, loadRegistry } from './registry.js';

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
  const loaded = loadConfiguration();
  if (!loaded) return;
  const { cfg, registry } = loaded;
  const edge = createEdgeApplication(cfg, registry);
  const rejectBudgetTimer = installRuntimeLogs(edge.runtime);
  let shuttingDown = false;
  const shutdown = async () => {
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

function loadConfiguration() {
  try {
    const cfg = loadEdgeConfig();
    const registry = loadRegistry(cfg.sitePath, cfg.nodesPath);
    if (cfg.flashToken) checkNodesWritable(cfg.nodesPath);
    return { cfg, registry };
  } catch (error) {
    if (error instanceof EnvError || error instanceof ConfigError) {
      console.error(`[edge] refusing to start: ${error.message}`);
      process.exitCode = 2;
      return null;
    }
    throw error;
  }
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

function logStartup(runtime: ReturnType<typeof createEdgeApplication>['runtime'], cfg: ReturnType<typeof loadEdgeConfig>, registry: ReturnType<typeof loadRegistry>): void {
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
