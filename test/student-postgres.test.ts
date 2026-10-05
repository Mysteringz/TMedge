import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';
import { loadPostgresConfig } from '../src/infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../src/infrastructure/postgres/data-source.js';
import { CreateStudentAccountsActivity1791331200000 } from '../src/infrastructure/postgres/migrations/1791331200000-CreateStudentAccountsActivity.js';
import { PostgresStudentAccountRepository } from '../src/infrastructure/postgres/student-account-repository.js';
import { PostgresStudentActivityRepository } from '../src/infrastructure/postgres/student-activity-repository.js';
import { StudentAccountImportExport } from '../src/modules/student-auth/application/student-account-import-export.js';
import { createStudentUser } from '../src/modules/student-auth/application/student-credentials.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import { AuthError } from '../src/modules/student-auth/application/student-session-service.js';
import type { StudentActivityEvent } from '../src/modules/student-auth/repositories/student-activity-repository.js';
import { createConfiguredWebApp, loadWebConfig } from '../src/web/main.js';

test('student PostgreSQL migration, accounts, transfer, activity and outages', {
  skip: process.env.PG_INTEGRATION_TEST !== '1',
}, async () => {
  const config = loadPostgresConfig();
  const migrator = new DataSource({ type: 'postgres', ...config.migrator, migrationsTransactionMode: 'all',
    migrations: [CreateStudentAccountsActivity1791331200000], migrationsTableName: 'student_test_migrations', logging: false });
  const runtime = await openPostgres(config.runtime);
  let migrated = false;
  let lock: QueryRunner | undefined;
  try {
    await migrator.initialize();
    lock = migrator.createQueryRunner();
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock(1791331200)');
    const tables = await migrator.query("SELECT to_regclass('public.student_users') AS existing") as Array<{ existing: string | null }>;
    assert.equal(tables[0]?.existing, null, 'integration tests require an empty disposable student schema');
    assert.equal((await migrator.runMigrations()).length, 1);
    migrated = true;
    const role = quoteIdentifier(config.runtime.username);
    await migrator.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_users, public.student_activity_events TO ${role}`);
    await assertAccounts(runtime);
    await assertTransfer(runtime);
    await assertConstraints(migrator);
    await assertActivity(runtime, migrator);
    await assertCli();
    await assertHttp(runtime);
    await runtime.destroy();
    await assert.rejects(new PostgresStudentAccountRepository(runtime).get('new@example.edu'),
      (error: ApplicationError) => error.kind === 'unavailable');
    await migrator.undoLastMigration();
    migrated = false;
    const removed = await migrator.query("SELECT to_regclass('public.student_users') AS users, to_regclass('public.student_activity_events') AS events");
    assert.equal(removed[0].users, null);
    assert.equal(removed[0].events, null);
  } finally {
    if (migrated) await migrator.undoLastMigration();
    if (lock) {
      await lock.query('SELECT pg_advisory_unlock(1791331200)');
      await lock.release();
    }
    if (migrator.isInitialized) await migrator.query('DROP TABLE IF EXISTS public.student_test_migrations');
    await closePostgres(runtime);
    await closePostgres(migrator);
  }
});

async function assertAccounts(source: DataSource): Promise<void> {
  const accounts = new PostgresStudentAccountRepository(source, ['example.edu']);
  const user = await accounts.create(' NEW@Example.edu ', ' New ', 'strong password');
  assert.equal(user.email, 'new@example.edu');
  assert.ok(user.id);
  assert.equal((await accounts.get('NEW@example.edu'))?.id, user.id);
  assert.equal(await accounts.count(), 1);
  assert.equal((await accounts.verify(user.email, 'strong password'))?.id, user.id);
  assert.equal(await accounts.verify(user.email, 'wrong password'), null);
  assert.equal(await accounts.verify('unknown@example.edu', 'strong password'), null);
  await assert.rejects(accounts.create(user.email, 'New', 'strong password'), AuthError);
  const concurrent = await Promise.allSettled([
    accounts.create('concurrent@example.edu', 'Concurrent', 'strong password'),
    accounts.create('concurrent@example.edu', 'Concurrent', 'strong password'),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
}

async function assertTransfer(source: DataSource): Promise<void> {
  const accounts = new PostgresStudentAccountRepository(source);
  const transfer = new StudentAccountImportExport(accounts);
  const legacy = await createStudentUser('legacy@example.edu', 'Legacy', 'legacy password');
  delete legacy.id;
  const before = await accounts.count();
  assert.equal((await transfer.import([legacy])).inserted, 0);
  assert.equal(await accounts.count(), before);
  assert.equal((await transfer.import([legacy], { dryRun: false })).inserted, 1);
  const imported = await accounts.get(legacy.email);
  assert.ok(imported?.id);
  assert.equal(imported.createdAt, legacy.createdAt);
  assert.equal((await accounts.verify(legacy.email, 'legacy password'))?.id, imported.id);
  assert.equal((await transfer.import([legacy], { dryRun: false })).unchanged, 1);
  const another = await createStudentUser('another@example.edu', 'Another', 'strong password');
  await assert.rejects(transfer.import([another, { ...legacy, name: 'Conflicting' }], { dryRun: false }),
    (error: ApplicationError) => error.kind === 'conflict');
  assert.equal(await accounts.get(another.email), undefined);
  assert.equal((await transfer.export()).find((user) => user.email === legacy.email)?.id, imported.id);
  await assert.rejects(transfer.import([{ ...legacy, id: randomUUID() }], { dryRun: false }),
    (error: ApplicationError) => error.kind === 'conflict');
}

async function assertConstraints(source: DataSource): Promise<void> {
  const runner = source.createQueryRunner();
  await runner.startTransaction();
  try {
    for (const [column, value] of [['email', 'UPPER@example.edu'], ['salt', 'bad'], ['hash', 'bad']]) {
      await runner.query('SAVEPOINT expected');
      // Column identifiers come only from this hardcoded allowlist; values remain parameters.
      await assert.rejects(runner.query(`UPDATE public.student_users SET ${column} = $1 WHERE email = $2`,
        [value, 'new@example.edu']));
      await runner.query('ROLLBACK TO SAVEPOINT expected');
    }
    await runner.query('SAVEPOINT expected');
    await assert.rejects(runner.query(`INSERT INTO public.student_activity_events
      (id, action, outcome, request_id, occurred_at) VALUES ($1, $2, $3, $4, now())`,
    [randomUUID(), 'page-view', 'succeeded', randomUUID()]));
    await runner.query('ROLLBACK TO SAVEPOINT expected');
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

async function assertActivity(source: DataSource, migrator: DataSource): Promise<void> {
  const accounts = new PostgresStudentAccountRepository(source);
  const user = await accounts.get('new@example.edu');
  assert.ok(user?.id);
  const activity = new PostgresStudentActivityRepository(source);
  const now = Date.now();
  const event: StudentActivityEvent = { id: randomUUID(), requestId: randomUUID(), userId: user.id,
    action: 'login', outcome: 'succeeded', occurredAt: now };
  await activity.record(event);
  await activity.record({ ...event, id: randomUUID(), userId: null, outcome: 'failed', occurredAt: now - 1000 });
  assert.equal((await activity.list())[0]?.userId, user.id);
  assert.equal(await activity.countBefore(now), 1);
  assert.equal(await activity.prune(now), 1);
  assert.equal((await activity.list()).length, 1);
  await migrator.query('DELETE FROM public.student_users WHERE id = $1', [user.id]);
  assert.equal((await activity.list())[0]?.userId, null);
  const fields = await migrator.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_activity_events'`) as Array<{ column_name: string }>;
  assert.deepEqual(fields.map((field) => field.column_name).sort(),
    ['action', 'created_at', 'id', 'occurred_at', 'outcome', 'request_id', 'user_id']);
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

async function assertCli(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'student-cli-'));
  try {
    const input = join(directory, 'input.json');
    const output = join(directory, 'recovery.json');
    const user = await createStudentUser('cli@example.edu', 'CLI', 'strong password');
    await writeFile(input, JSON.stringify([user]), { mode: 0o600 });
    assert.equal(JSON.parse(await cli(['import', input])).dryRun, true);
    assert.equal(JSON.parse(await cli(['import', input, '--apply'])).inserted, 1);
    await cli(['export', output]);
    const recovered = JSON.parse(await readFile(output, 'utf8')) as Array<{ email: string; hash: string }>;
    assert.equal(recovered.find((record) => record.email === user.email)?.hash, user.hash);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(cli(['export', output]));
    assert.ok(Array.isArray(JSON.parse(await cli(['activity', '--limit', '1'])).events));
    assert.equal(JSON.parse(await cli(['prune', '--days', '90'])).dryRun, true);
    assert.equal(JSON.parse(await cli(['prune', '--days', '90', '--apply'])).dryRun, false);
    await assert.rejects(cli(['activity', '--limit', '1001']));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cli(args: string[]): Promise<string> {
  const script = join(dirname(fileURLToPath(import.meta.url)), '../src/tools/student-accounts.js');
  const result = await promisify(execFile)(process.execPath, [script, ...args], { env: process.env });
  return result.stdout;
}

async function assertHttp(source: DataSource): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'student-http-pg-'));
  const usersPath = join(directory, 'never-written-users.json');
  const web = await createConfiguredWebApp(loadWebConfig({ ...process.env, STUDENT_PERSISTENCE_MODE: 'postgres',
    SESSION_SECRET: 's'.repeat(40), WEB_PUSH_TOKEN: 't'.repeat(20), ALLOWED_EMAIL_DOMAINS: 'example.edu',
    USERS_FILE: usersPath, SIGNUP_OPEN: '1', COOKIE_SECURE: '0', WEB_PORT: '0', WEB_HOST: '127.0.0.1' }));
  try {
    await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    await assertHttpRequests(base);
    await web.activity?.flush();
    const user = await new PostgresStudentAccountRepository(source).get('http@example.edu');
    assert.ok(user?.id);
    const events = (await new PostgresStudentActivityRepository(source).list()).filter((event) => event.userId === user.id);
    assert.deepEqual(events.map((event) => `${event.action}/${event.outcome}`).sort(),
      ['login/failed', 'login/succeeded', 'logout/succeeded', 'signup/succeeded']);
    await assert.rejects(stat(usersPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal((await fetch(base + '/readyz')).status, 200);
  } finally {
    await web.dispose();
    await new Promise<void>((resolve, reject) => web.server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertHttpRequests(base: string): Promise<void> {
  const signup = await authRequest(base, '/signup', { email: 'http@example.edu', name: 'HTTP', password: 'strong password' });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal(signup.headers.get('set-cookie')?.includes('HttpOnly'), true);
  const me = await fetch(base + '/api/me', { headers: { cookie } });
  assert.deepEqual(await me.json(), { email: 'http@example.edu', name: 'HTTP' });
  assert.equal((await authRequest(base, '/login', { email: 'http@example.edu', password: 'incorrect password' })).status, 401);
  assert.equal((await authRequest(base, '/login', { email: 'http@example.edu', password: 'strong password' })).status, 200);
  const logout = await authRequest(base, '/logout', {}, cookie);
  assert.deepEqual(await logout.json(), { redirect: '/login/' });
  assert.equal((await fetch(base + '/api/me')).status, 401);
}

function authRequest(base: string, path: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields) });
}
