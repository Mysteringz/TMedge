import { resolve } from 'node:path';
import { readHelloReplaySnapshot } from '../edge/hello-replay.js';
import { readReplaySnapshot } from '../edge/replay.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { importLegacyReplayState } from '../infrastructure/postgres/replay-import.js';
import type { DataSource } from 'typeorm';

const [replayArgument, helloArgument] = process.argv.slice(2);
if (!replayArgument || !helloArgument || process.argv.length !== 4) {
  process.stderr.write('Usage: npm run failover:import-replay -- <replay.jsonl> <gateway-hellos.json|--no-gateway-journal>\n');
  process.exitCode = 2;
} else {
  let source: DataSource | undefined;
  try {
    const replayPath = resolve(replayArgument);
    const replay = readReplaySnapshot(replayPath);
    const hellos = helloArgument === '--no-gateway-journal'
      ? { highWater: 0, nonces: [] }
      : readHelloReplaySnapshot(resolve(helloArgument));
    const siteId = process.env.FAILOVER_SITE_ID?.trim() ?? '';
    source = await openPostgres(loadPostgresConnectionConfig('migrator'));
    const result = await importLegacyReplayState(source, siteId, replay, hellos);
    process.stdout.write(`Imported ${result.nodeCursors} node cursor(s), command sequence ${result.commandSequence}, and ${result.liveGatewayNonces} live gateway nonce(s).\n`);
  } catch {
    process.stderr.write('Replay-state import failed; stop the edge, verify the files and database configuration, then retry.\n');
    process.exitCode = 1;
  } finally {
    if (source) await closePostgres(source).catch(() => { process.exitCode = 1; });
  }
}
