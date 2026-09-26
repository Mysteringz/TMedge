/** TMedge entry point: `npm run edge`. */
import { loadEdgeConfig, EnvError } from './config.js';
import { startAlgo } from '../algo/server.js';
import { startConsole } from './console.js';
import { ConfigError, loadRegistry } from './registry.js';
import { EdgeRuntime } from './runtime.js';

function main(): void {
  let cfg;
  let reg;
  try {
    cfg = loadEdgeConfig();
    reg = loadRegistry(cfg.sitePath, cfg.nodesPath);
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
  if (cfg.algoPort > 0) {
    const { server: algoServer } = startAlgo(rt, cfg.algoPort, cfg.consoleHost);
    algoServer.on('listening', () => {
      const a = algoServer.address();
      const where = typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a);
      console.log(`[edge] algo debugger http://${where}${cfg.adminPassword ? ' (password protected)' : ' (localhost only: no ADMIN_PASSWORD)'}`);
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
