import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource, type DataSourceOptions, type MigrationInterface } from 'typeorm';
import type { PostgresConnectionConfig } from './config.js';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createPostgresDataSource(
  config: PostgresConnectionConfig,
  migrations?: Array<(new () => MigrationInterface) | string>,
): DataSource {
  const options: DataSourceOptions = {
    type: 'postgres',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    synchronize: config.synchronize,
    migrationsRun: config.migrationsRun,
    migrationsTransactionMode: 'all',
    migrations: migrations ?? [join(migrationDirectory, '*.js')],
    logging: false,
    extra: { max: config.role === 'migrator' ? 1 : 10 },
  };
  return new DataSource(options);
}

/** Initialize one pool; the caller owns closing it through closePostgres. */
export async function openPostgres(config: PostgresConnectionConfig): Promise<DataSource> {
  const source = createPostgresDataSource(config);
  await source.initialize();
  return source;
}

/** Close an initialized pool. Repeated shutdown calls are safe. */
export async function closePostgres(source: DataSource): Promise<void> {
  if (source.isInitialized) await source.destroy();
}

/** Safe health signal: database error details can contain connection metadata. */
export async function postgresAvailability(source: DataSource): Promise<{ available: boolean }> {
  if (!source.isInitialized) return { available: false };
  try {
    await source.query('SELECT 1');
    return { available: true };
  } catch {
    return { available: false };
  }
}
