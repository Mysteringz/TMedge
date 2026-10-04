/** TMedge entry point: `npm run edge`. */
import { accessSync, constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEdgeConfig, EnvError } from './config.js';
import { AlgoUsers, loadAlgoAuthConfig, type AlgoAuthConfig } from '../algo/auth.js';
import { startAlgo } from '../algo/server.js';
import { startConsole } from './console.js';
import { ConfigError, loadRegistry } from './registry.js';
import { EdgeRuntime } from './runtime.js';

/**
 * Admitting a node appends to nodes.json, so provisioning is only honest if
 * that file can actually be written -- and if it survives a deploy.
 *
 * Both failures are silent and expensive. An unwritable file means every
 * approval throws at the moment someone is standing at a node waiting; a
 * file inside the release directory means approvals work all week and
 * vanish on the next deploy, taking the fleet's registrations with them.
 * Refusing to start says so once, now, instead.
 */
function checkNodesWritable(nodesPath: string): void {
  try {
    accessSync(nodesPath, constants.W_OK);
  } catch {
    throw new EnvError(`TMFLASH_TOKEN is set but ${nodesPath} is not writable: approving a node would fail. Point NODES_CONFIG at a writable copy.`);
  }
  // A release tree is replaced wholesale on the next deploy. Anything under
  // the live symlink's target is therefore temporary storage.
  const real = realpathSync(nodesPath);
  if (/[/\\]tmedge-releases[/\\]/.test(real) || real.startsWith(resolve(process.cwd()) + '/config/')) {
    throw new EnvError(`TMFLASH_TOKEN is set but ${nodesPath} is inside the release (${real}); admitted nodes would be lost on the next deploy. Point NODES_CONFIG at /opt/tmedge-shared/nodes.json.`);
  }
}

function main(): void {
  let cfg;
  let reg;
  let algoAuth: AlgoAuthConfig | null = null;
  try {
    cfg = loadEdgeConfig();
    if (cfg.algoPort > 0) {
      try {
        algoAuth = loadAlgoAuthConfig(process.env, cfg.adminPassword);
      } catch (err) {
        throw new EnvError((err as Error).message);
      }
    }
    reg = loadRegistry(cfg.sitePath, cfg.nodesPath);
    if (cfg.flashToken) checkNodesWritable(cfg.nodesPath);
  } catch (err) {
    if (err instanceof EnvError || err instanceof ConfigError) {
      console.error(`[edge] refusing to start: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const rt = new EdgeRuntime(cfg, reg);
  let rejectLogBudget = 20;
  rt.ingest.on('listening', (a) => console.log(`[edge] UDP ${a.address}:${a.port} (TMnode uplink)`));
  rt.ingest.on('error', (e) => console.error(`[edge] UDP error: ${e.message}`));
  rt.ingest.on('rejected', (addr, reason) => {
    // Rate-limited: a flood of junk must not become a flood of log lines.
    if (rejectLogBudget-- > 0) console.warn(`[edge] rejected packet from ${addr}: ${reason}`);
  });
  setInterval(() => (rejectLogBudget = 20), 60_000).unref();

  rt.start();
  rt.startNodeListener().then((port) => {
    if (port !== null) console.log(`[edge] direct nodes: ${cfg.nodeTls ? 'wss' : 'ws'}://${cfg.nodeHost}:${port}/tmnode (tmnode.v1)`);
  }, (err: unknown) => {
    // Configured but unable to bind: stop, so systemd and the deploy health
    // check see a failure instead of an edge that quietly shuts nodes out.
    console.error(`[edge] direct node listener failed to start on ${cfg.nodeHost}:${cfg.nodePort}: ${(err as Error).message}`);
    process.exit(1);
  });
  const server = startConsole(rt);
  server.on('listening', () => {
    const a = server.address();
    const where = typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a);
    console.log(`[edge] debug console http://${where}${cfg.adminPassword ? ' (password protected)' : ' (localhost only: no ADMIN_PASSWORD)'}`);
  });

  // The algo debugger: thermal imagery and live parameter writes, so it sits
  // beside the console on the edge and never on the student tier.
  if (cfg.algoPort > 0 && algoAuth) {
    const auth = algoAuth;
    const { server: algoServer } = startAlgo(rt, cfg.algoPort, cfg.consoleHost, auth);
    algoServer.on('listening', () => {
      const a = algoServer.address();
      const where = typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a);
      if (!auth.enabled) {
        console.log(`[edge] algo console http://${where} (localhost only: no ADMIN_PASSWORD, no sign-in)`);
        return;
      }
      const users = new AlgoUsers(auth.usersPath).size;
      console.log(`[edge] algo console http://${where} (sign-in: ${users} account(s) in ${auth.usersPath}, turnstile ${auth.turnstile ? `on for ${auth.turnstile.hostnames.join(', ')}` : 'off'})`);
      // Not fatal -- the edge's real job is the sensors -- but nobody can get in.
      if (users === 0) console.warn('[edge] algo console has no accounts; add one with: npm run algo-user -- add <name>');
    });
  }

  const tables = [...reg.tables.values()];
  console.log(`[edge] ${cfg.edgeId}: ${reg.floors.length} floor(s), ${tables.length} tables, ` +
    `${tables.reduce((a, t) => a + t.capacity, 0)} seats, ${reg.nodes.size} registered nodes`);
  console.log(`[edge] signing: ${cfg.keys.length ? `${cfg.keys.length} key(s)` : 'none'}${cfg.allowUnsigned ? ', UNSIGNED ACCEPTED' : ''}`);
  console.log(`[edge] publishing to ${cfg.pushUrls.join(', ') || '(nowhere)'} every ${cfg.publishMs} ms; recording to ${cfg.dataDir}${cfg.recordRaw ? ' (with raw frames)' : ''}`);

  const shutdown = async () => {
    console.log('[edge] shutting down');
    server.close();
    await rt.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main();
