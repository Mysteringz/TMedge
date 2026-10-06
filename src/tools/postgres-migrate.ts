import { closePostgres, openPostgres } from '../infrastructure/postgres/data-source.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import type { DataSource } from 'typeorm';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  process.stderr.write('Usage: npm run db:migrate -- up|down\n');
  process.exitCode = 2;
} else {
  let source: DataSource | undefined;
  try {
    source = await openPostgres(loadPostgresConnectionConfig('migrator'));
    if (direction === 'up') {
      const applied = await source.runMigrations({ transaction: 'all' });
      process.stdout.write(`Applied ${applied.length} migration(s).\n`);
    } else {
      await source.undoLastMigration({ transaction: 'all' });
      process.stdout.write('Reverted the latest migration.\n');
    }
  } catch {
    // Driver errors can include the user, host, or other connection metadata.
    process.stderr.write('PostgreSQL migration command failed; connection details were suppressed.\n');
    process.exitCode = 1;
  } finally {
    if (source) {
      try {
        await closePostgres(source);
      } catch {
        process.stderr.write('PostgreSQL connection shutdown failed.\n');
        process.exitCode = 1;
      }
    }
  }
}
