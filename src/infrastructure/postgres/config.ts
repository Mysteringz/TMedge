export class PostgresConfigError extends Error {}

export type PostgresRole = 'migrator' | 'runtime';

export interface PostgresCredentials {
  username: string;
  password: string;
}

export interface PostgresConnectionConfig extends PostgresCredentials {
  host: string;
  port: number;
  database: string;
  role: PostgresRole;
  /** TypeORM schema synchronization is never enabled for this application. */
  synchronize: false;
  /** Migrations are applied only by the explicit migration command. */
  migrationsRun: false;
}

export interface PostgresConfig {
  migrator: PostgresConnectionConfig;
  runtime: PostgresConnectionConfig;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new PostgresConfigError(`${key} must be set`);
  return value;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.PGPORT ?? '5432';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new PostgresConfigError('PGPORT must be an integer 1..65535');
  }
  return value;
}

export function loadPostgresConnectionConfig(
  role: PostgresRole,
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnectionConfig {
  const credentialPrefix = role === 'migrator' ? 'PG_MIGRATION' : 'PG_RUNTIME';
  return {
    host: env.PGHOST?.trim() || '127.0.0.1',
    port: port(env),
    database: required(env, 'PGDATABASE'),
    username: required(env, `${credentialPrefix}_USER`),
    password: required(env, `${credentialPrefix}_PASSWORD`),
    role,
    synchronize: false,
    migrationsRun: false,
  };
}

export function loadPostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresConfig {
  const migrator = loadPostgresConnectionConfig('migrator', env);
  const runtime = loadPostgresConnectionConfig('runtime', env);
  if (migrator.username === runtime.username || migrator.password === runtime.password) {
    throw new PostgresConfigError('PG_MIGRATION and PG_RUNTIME credentials must be different');
  }

  return { migrator, runtime };
}
