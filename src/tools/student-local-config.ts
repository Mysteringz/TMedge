import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

async function availableWebPort(): Promise<number> {
  for (let port = 8080; port < 8090; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No local student web port available');
}

/** Creates fresh local settings exclusively; existing settings are never replaced. */
const secret = () => randomBytes(32).toString('hex');
try {
  const port = await availableWebPort();
  const settings = [
    '# Local student development only; keep this file private and out of Git.',
    'STUDENT_PERSISTENCE_MODE=postgres',
    'STUDENT_ACTIVITY_RETENTION_DAYS=90',
    'PGHOST=127.0.0.1', 'PGPORT=55433', 'PGDATABASE=tmedge_local',
    'PG_RUNTIME_USER=tmedge_runtime', `PG_RUNTIME_PASSWORD=${secret()}`,
    'PG_MIGRATION_USER=tmedge_migrator', `PG_MIGRATION_PASSWORD=${secret()}`,
    `PG_ADMIN_PASSWORD=${secret()}`, `SESSION_SECRET=${secret()}`, `WEB_PUSH_TOKEN=${secret()}`,
    'WEB_HOST=127.0.0.1', `WEB_PORT=${port}`, 'SIGNUP_OPEN=1',
    'ALLOWED_EMAIL_DOMAINS=hku.hk,connect.hku.hk', 'COOKIE_SECURE=0', 'TRUST_PROXY=0',
  ];
  await writeFile('.env', settings.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Created private local .env (web port ${port}); next start postgres-local and apply migrations.\n`);
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    process.stderr.write('.env already exists; preserve it and configure student storage using docs/student-accounts.md.\n');
  } else process.stderr.write('Could not create private local configuration.\n');
  process.exitCode = 1;
}
