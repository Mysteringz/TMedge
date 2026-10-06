import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JsonStudentAccountRepository } from '../src/infrastructure/web/json-student-account-repository.js';
import { createStudentUser, verifyStudentPassword } from '../src/modules/student-auth/application/student-credentials.js';
import { StudentAccountImportExport, validateStudentAccountImport } from '../src/modules/student-auth/application/student-account-import-export.js';
import { PostgresStudentAccountRepository } from '../src/infrastructure/postgres/student-account-repository.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import { createPostgresDataSource } from '../src/infrastructure/postgres/data-source.js';
import { AuthError, Sessions, studentSessionVersion } from '../src/modules/student-auth/application/student-session-service.js';

test('JSON new accounts retain UUIDs, legacy scrypt credentials, and concurrent duplicate protection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'student-storage-'));
  try {
    const path = join(directory, 'users.json');
    const legacy = await createStudentUser('legacy@example.edu', 'Legacy', 'existing password');
    delete legacy.id;
    writeFileSync(path, JSON.stringify([legacy]));
    const accounts = new JsonStudentAccountRepository(path, ['example.edu']);
    assert.equal((await accounts.verify(legacy.email, 'existing password'))?.id, undefined);
    const results = await Promise.allSettled([
      accounts.create(' New@Example.edu ', ' New ', 'strong password'), accounts.create('new@example.edu', 'New', 'strong password'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(accounts.count(), 2);
    const id = accounts.get('new@example.edu')?.id;
    assert.match(id ?? '', /^[a-f0-9-]{36}$/);
    assert.equal(new JsonStudentAccountRepository(path, []).get('new@example.edu')?.id, id);
    const records = JSON.parse(readFileSync(path, 'utf8')) as Array<{ email: string; id?: string }>;
    assert.equal(records.find((user) => user.email === legacy.email)?.id, undefined);
    assert.equal(await accounts.verify('new@example.edu', 'incorrect password'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Google accounts use stable subject identity and never auto-link by email', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'student-google-'));
  try {
    const accounts = new JsonStudentAccountRepository(join(directory, 'users.json'), ['example.edu']);
    const first = accounts.google({ sub: 'google-subject-1', email: 'person@example.net', name: 'Person' }, true);
    const returned = accounts.google({ sub: 'google-subject-1', email: 'changed@example.net', name: 'Changed' }, false);
    assert.equal(returned.id, first.id);
    assert.equal(returned.email, first.email);
    assert.equal(returned.google, 'google-subject-1');
    const passwordAccount = await accounts.create('owned@example.edu', 'Owned', 'strong password');
    assert.ok(passwordAccount.id);
    assert.throws(() => accounts.google({ sub: 'google-subject-2', email: passwordAccount.email, name: 'Other' }, true), AuthError);
    assert.throws(() => accounts.google({ sub: 'google-subject-3', email: 'closed@example.net', name: 'Closed' }, false), AuthError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('student sessions bind to account credentials and persist logout revocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'student-session-'));
  try {
    const path = join(directory, 'revocations.json');
    const secret = Buffer.alloc(32, 7);
    const user = { id: randomUUID(), email: 'student@example.edu', name: 'Student', salt: 'a'.repeat(32), hash: 'b'.repeat(64), createdAt: Date.now() };
    const sessions = new Sessions(secret, undefined, path);
    const cookie = sessions.issue(user.email, Date.now(), studentSessionVersion(user));
    assert.equal(sessions.detail(cookie)?.version, studentSessionVersion(user));
    assert.notEqual(sessions.detail(cookie)?.version, studentSessionVersion({ ...user, hash: 'c'.repeat(64) }));
    sessions.revoke(cookie);
    assert.equal(new Sessions(secret, undefined, path).read(cookie), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('import validates the whole legacy format and normalizes identities without printing credentials', async () => {
  const user = await createStudentUser('student@example.edu', 'Student', 'strong password');
  const parsed = validateStudentAccountImport([{ ...user, email: ' STUDENT@EXAMPLE.EDU ' }]);
  assert.equal(parsed[0]?.email, user.email);
  assert.throws(() => validateStudentAccountImport([user, { ...user, id: randomUUID(), email: ' STUDENT@example.edu ' }]), /Duplicate normalized email/);
  assert.throws(() => validateStudentAccountImport([user, { ...user, email: 'second@example.edu' }]), /Duplicate account ID/);
  for (const replacement of [{ hash: 'secret-invalid-hash' }, { salt: 'bad' }, { createdAt: NaN }, { id: 'bad' }, { name: '' }]) {
    assert.throws(() => validateStudentAccountImport([{ ...user, ...replacement }]), (error: Error) =>
      error instanceof ApplicationError && !error.message.includes(user.hash) && !error.message.includes('secret-invalid-hash'));
  }
  let called = false;
  const service = new StudentAccountImportExport({
    async exportAccounts() { return [user]; },
    async importAccounts(users, options) {
      called = true;
      assert.equal(options.dryRun, true);
      return { total: users.length, inserted: 0, unchanged: 0, insertable: users.length, dryRun: true };
    },
  });
  await assert.rejects(service.import([user, { ...user, hash: 'bad' }]));
  assert.equal(called, false);
  assert.equal((await service.import([user])).dryRun, true);
  assert.equal(called, true);
});

test('password verification handles malformed and unknown credentials without throwing', async () => {
  const user = await createStudentUser('test@example.edu', 'Test', 'strong password');
  assert.equal(await verifyStudentPassword(user, 'strong password'), true);
  assert.equal(await verifyStudentPassword({ ...user, hash: 'bad' }, 'strong password'), false);
  assert.equal(await verifyStudentPassword(undefined, 'strong password'), false);
});

test('damaged JSON storage fails closed instead of becoming an empty writable account store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'student-invalid-'));
  try {
    const path = join(directory, 'users.json');
    writeFileSync(path, '{invalid-secret-content');
    assert.throws(() => new JsonStudentAccountRepository(path, []),
      (error: ApplicationError) => error.kind === 'unavailable' && !error.message.includes('invalid-secret-content'));
    assert.equal(readFileSync(path, 'utf8'), '{invalid-secret-content');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('disconnected PostgreSQL accounts return controlled unavailable errors', async () => {
  const source = createPostgresDataSource({ host: '127.0.0.1', port: 5432, database: 'unused', username: 'unused',
    password: 'unused', role: 'runtime', synchronize: false, migrationsRun: false });
  const accounts = new PostgresStudentAccountRepository(source);
  for (const operation of [() => accounts.count(), () => accounts.get('student@example.edu'),
    () => accounts.create('student@example.edu', 'Student', 'strong password'), () => accounts.verify('student@example.edu', 'strong password')]) {
    await assert.rejects(operation(), (error: ApplicationError) => error.kind === 'unavailable' && !error.message.includes('unused'));
  }
});
