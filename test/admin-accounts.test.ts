import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { FileAccountRepository } from '../src/infrastructure/algo-admin/file-account-repository.js';
import { ManageAccounts } from '../src/modules/algo-admin/use-cases/manage-accounts.js';
import { accountRoutes } from '../src/modules/algo-admin/controllers/accounts.js';
import { AccountError } from '../src/modules/algo-admin/domain/accounts.js';
import type { AdminAccount } from '../src/modules/algo-admin/domain/accounts.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-accounts-')), 'users.json');
  const users = new AlgoUsers(path);
  await users.add('admin', 'long admin password', 'admin');
  await users.add('other', 'long other password', 'admin');
  await users.add('viewer', 'long viewer password', 'viewer');
  const repository = new FileAccountRepository(users, Buffer.alloc(32, 1));
  const accounts = new ManageAccounts(repository);
  return { path, users, repository, accounts, authorize: accounts.authority(() => principal('admin', 'admin')) };
}
const code = (expected: string) => (error: unknown) => error instanceof AccountError && error.code === expected;

test('public DTO, pagination, validation and serialized stale/final-admin protections', async () => {
  const f = await fixture();
  const list = f.accounts.list(1, 1, f.authorize); assert.equal(list.total, 3); assert.equal(list.accounts.length, 1);
  assert.deepEqual(Object.keys(list.accounts[0]!).sort(), ['createdAt', 'disabled', 'name', 'revision', 'role']);
  await assert.rejects(f.accounts.mutate('create', '', { name: 'viewer', role: 'viewer', password: 'long duplicate password' }, f.authorize), code('DUPLICATE'));
  for (const body of [{ name: 'invalid user', role: 'viewer', password: 'long new password' }, { name: 'new-user', role: 'root', password: 'long new password' }, { name: 'new-user', role: 'viewer', password: 'short' }, { name: 'new-user', role: 'viewer', password: 'long new password', hash: 'x' }]) await assert.rejects(f.accounts.mutate('create', '', body, f.authorize), code('VALIDATION'));
  const admin = f.repository.list().find((a) => a.name === 'admin')!, other = f.repository.list().find((a) => a.name === 'other')!;
  const changes = await Promise.allSettled([f.accounts.mutate('update', 'admin', { revision: admin.revision, role: 'engineer' }, f.authorize), f.accounts.mutate('update', 'other', { revision: other.revision, disabled: true }, f.authorize)]);
  assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(changes.some((result) => result.status === 'rejected' && code('LAST_ADMIN')(result.reason)));
  await assert.rejects(f.accounts.mutate('revoke', 'admin', { revision: admin.revision }, f.authorize), code('STALE_REVISION'));
  assert.throws(() => f.accounts.list(0, 101, f.authorize), code('VALIDATION'));
  await assert.rejects(f.accounts.mutate('revoke', 'missing', { revision: 'a'.repeat(64) }, f.authorize), code('NOT_FOUND'));
  writeFileSync(f.path, '{broken'); assert.throws(() => f.repository.list(), code('STORAGE_UNAVAILABLE'));
});

test('admin revocation during hashing cannot commit create/reset; stale reset preserves new fields', async () => {
  const f = await fixture();
  const snapshot = f.users.get('admin')!;
  const authorize = f.accounts.authority(() => { const current = f.users.get('admin'); return current && current.sessionVersion === snapshot.sessionVersion ? principal('admin', current.role!, !current.disabled) : null; });
  const creating = f.accounts.mutate('create', '', { name: 'delayed', role: 'viewer', password: 'long delayed password' }, authorize);
  f.users.update('admin', { revoke: true });
  await assert.rejects(creating, code('UNAUTHENTICATED')); assert.equal(f.users.has('delayed'), false);
  const other = f.repository.list().find((a) => a.name === 'other')!;
  const resetting = f.accounts.mutate('password', 'other', { revision: other.revision, password: 'replacement password' }, f.authorize);
  f.users.update('other', { role: 'viewer' });
  await assert.rejects(resetting, code('STALE_REVISION'));
  assert.equal(await f.users.verify('other', 'long other password'), 'other'); assert.equal(f.users.get('other')!.role, 'viewer');
  const admin2 = f.users.get('admin')!;
  const authorize2 = f.accounts.authority(() => f.users.get('admin')?.sessionVersion === admin2.sessionVersion ? principal('admin', 'admin') : null);
  const target = f.repository.list().find((a) => a.name === 'viewer')!;
  const resetDenied = f.accounts.mutate('password', 'viewer', { revision: target.revision, password: 'replacement password' }, authorize2);
  f.users.update('admin', { revoke: true }); await assert.rejects(resetDenied, code('UNAUTHENTICATED'));
  assert.equal(await f.users.verify('viewer', 'long viewer password'), 'viewer');
});

test('partial account patches preserve omitted role/status and legacy primitive ignores undefined', async () => {
  const f = await fixture();
  const update = async (name: string, patch: { role?: string; disabled?: boolean }) => f.accounts.mutate('update', name, { revision: f.repository.list().find((a) => a.name === name)!.revision, ...patch }, f.authorize);
  assert.equal((await update('viewer', { disabled: true })).role, 'viewer');
  assert.equal((await update('viewer', { role: 'engineer' })).disabled, true);
  assert.equal((await update('viewer', { disabled: false })).role, 'engineer');
  assert.equal((await update('other', { disabled: true })).role, 'admin');
  assert.equal(f.users.update('other', { disabled: undefined, role: undefined }).disabled, true);
  assert.equal(f.users.get('other')!.role, 'admin');
});

test('HTTP auth, CSRF, pagination, self-invalidation and rate limits', async () => {
  const f = await fixture();
  const cfg = loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: f.path }, 'set');
  const auth = createAlgoAuth(cfg), app = express(); app.use('/api/admin/accounts', accountRoutes(auth, new ManageAccounts(new FileAccountRepository(auth.users, cfg.sessionSecret)))); app.use(auth.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (name: string, password = `long ${name} password`) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password }) })).headers.get('set-cookie')!.split(';')[0]!;
  const request = (cookie: string, suffix = '', method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/admin/accounts${suffix}`, { method, headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await request('')).status, 401);
    assert.equal((await request(await login('viewer'))).status, 403);
    const cookie = await login('admin');
    for (const malformed of ['{bad', JSON.stringify({ password: 'x'.repeat(9000) })]) {
      const response = await fetch(`${base}/api/admin/accounts`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1' }, body: malformed });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { data: null, error: { code: 'VALIDATION', message: 'Invalid or oversized JSON body.' } });
    }
    assert.equal((await fetch(`${base}/api/admin/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 401);
    assert.equal((await request(cookie, '', 'POST', { name: 'csrf', role: 'viewer', password: 'long csrf password' }, { origin: 'https://elsewhere.invalid' })).status, 403);
    assert.equal((await request(cookie, '', 'POST', {}, { 'x-tm-algo': '' })).status, 403);
    assert.equal((await request(cookie, '?limit=0')).status, 400);
    const created = await request(cookie, '', 'POST', { name: 'new-user', role: 'engineer', password: 'long new password' }); assert.equal(created.status, 201);
    const data = (await created.json() as { data: AdminAccount & { hash?: string } }).data; assert.equal(data.role, 'engineer'); assert.equal(data.hash, undefined);
    const changed = await request(cookie, '/new-user', 'PATCH', { revision: data.revision, disabled: true }); assert.equal(changed.status, 200);
    assert.equal((await request(cookie, '/new-user', 'PATCH', { revision: data.revision, role: 'viewer' })).status, 409);
    const own = (await (await request(cookie)).json() as { data: { accounts: AdminAccount[] } }).data.accounts.find((a) => a.name === 'admin')!;
    assert.equal((await request(cookie, '/admin/session-revocations', 'POST', { revision: own.revision })).status, 200);
    assert.equal((await request(cookie)).status, 401);
    const fresh = await login('admin');
    for (let i = 0; i < 10; i++) await request(fresh, '', 'POST', {});
    assert.equal((await request(fresh, '', 'POST', {})).status, 429);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('local account API is explicitly unavailable', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-local-')), 'users.json');
  const cfg = loadAlgoAuthConfig({ ALGO_USERS_FILE: path }, null), auth = createAlgoAuth(cfg), app = express();
  app.use('/api/admin/accounts', accountRoutes(auth, new ManageAccounts(new FileAccountRepository(auth.users, cfg.sessionSecret))));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/accounts`); assert.equal(response.status, 403); assert.equal((await response.json() as { error: { code: string } }).error.code, 'LOCAL_MODE'); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
