import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { FileAccountRepository } from '../src/infrastructure/algo-admin/file-account-repository.js';
import { ManageAccounts } from '../src/modules/algo-admin/use-cases/manage-accounts.js';
import { accountRoutes } from '../src/modules/algo-admin/controllers/accounts.js';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-delete-')), 'users.json'), users = new AlgoUsers(path);
  for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) await users.add(role, 'long test password', role);
  await users.add('backup', 'long test password', 'admin');
  const cfg = loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: path }, 'set'), auth = createAlgoAuth(cfg);
  const repository = new FileAccountRepository(auth.users, cfg.sessionSecret), accounts = new ManageAccounts(repository), app = express();
  app.use('/api/admin/accounts', accountRoutes(auth, accounts)); app.use(auth.router);
  app.get('/me', (req, res) => res.status(auth.principalOf(req) ? 200 : 401).json({ valid: !!auth.principalOf(req) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'long test password' }) })).headers.get('set-cookie')!.split(';')[0]!;
  const request = (cookie: string, name: string, revision: string, extra: Record<string, string> = {}) => fetch(`${base}/api/admin/accounts/${name}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1', ...extra }, body: JSON.stringify({ revision }) });
  return { path, users, auth, repository, accounts, base, login, request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('DELETE named Admin only, revision/CSRF, self deletion and recreated cookies/epochs stay invalid', async () => {
  const f = await fixture();
  const revision = (name: string) => f.repository.list().find((row) => row.name === name)!.revision;
  try {
    const admin = await f.login('admin'), old = await f.login('engineer'), oldEpoch = f.auth.accountEpoch('engineer');
    assert.equal((await f.request('', 'engineer', revision('engineer'))).status, 401);
    for (const role of ['viewer', 'operator', 'engineer']) assert.equal((await f.request(await f.login(role), 'engineer', revision('engineer'))).status, 403);
    assert.equal((await f.request(admin, 'engineer', revision('engineer'), { 'x-tm-algo': '' })).status, 403);
    assert.equal((await f.request(admin, 'engineer', revision('engineer'), { origin: 'https://elsewhere.invalid' })).status, 403);
    const stale = revision('engineer'); f.users.update('engineer', { revoke: true });
    assert.equal((await f.request(admin, 'engineer', stale)).status, 409);
    const current = revision('engineer'), removed = await f.request(admin, 'engineer', current);
    assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { data: { name: 'engineer', deleted: true }, error: null });
    assert.equal(f.auth.accountEpoch('engineer'), null);
    assert.equal((await fetch(`${f.base}/me`, { headers: { cookie: old } })).status, 401);
    await f.users.add('engineer', 'long test password', 'engineer');
    assert.notEqual(f.auth.accountEpoch('engineer'), oldEpoch);
    assert.equal((await fetch(`${f.base}/me`, { headers: { cookie: old } })).status, 401);
    assert.equal((await f.request(admin, 'engineer', current)).status, 409, 'stale revision cannot delete replacement');
    assert.equal((await f.request(admin, 'admin', revision('admin'))).status, 200, 'self deletion succeeds with backup');
    assert.equal((await fetch(`${f.base}/me`, { headers: { cookie: admin } })).status, 401);
    const backup = await f.login('backup'), denied = await f.request(backup, 'backup', revision('backup'));
    assert.equal(denied.status, 409); assert.equal((await denied.json() as { error: { code: string } }).error.code, 'LAST_ADMIN');
  } finally { await f.close(); }
});

test('delete checks actor and expected target inside lock; no implicit admin creation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.users.add('implicit', 'long test password')).role, 'operator');
    const expected = f.users.get('viewer')!;
    assert.throws(() => f.users.remove('viewer', expected, () => { throw new Error('revoked actor'); }), /revoked actor/);
    assert.ok(f.users.has('viewer'));
    f.users.update('viewer', { disabled: true });
    assert.throws(() => f.users.remove('viewer', expected), /account changed/);
    const deleted = await f.accounts.delete('viewer', { revision: f.repository.list().find((row) => row.name === 'viewer')!.revision }, () => {});
    assert.equal(deleted.deleted, true);
    await assert.rejects(f.accounts.delete('viewer', { revision: 'a'.repeat(64) }, () => {}), /no longer exists/);
    for (const body of [{}, { revision: 'bad' }, { revision: 'a'.repeat(64), role: 'admin' }]) await assert.rejects(f.accounts.delete('backup', body, () => {}), /revision/);
  } finally { await f.close(); }
});

const cli = (path: string, args: string[], input = '') => new Promise<{ code: number | null; output: string }>((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/tools/algouser.js', import.meta.url)), ...args], { env: { ...process.env, ALGO_USERS_FILE: path }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (part: Buffer) => { output += part.toString(); }); child.stderr.on('data', (part: Buffer) => { output += part.toString(); });
  child.stdin.end(input); child.on('close', (code) => resolve({ code, output }));
});

test('separate-process CLI defaults Operator and concurrent Admin removal preserves one', async () => {
  const f = await fixture();
  try {
    const added = await cli(f.path, ['add', 'cli-user'], 'long cli password\n'); assert.equal(added.code, 0, added.output); assert.equal(f.users.get('cli-user')!.role, 'operator');
    const results = await Promise.all([cli(f.path, ['remove', 'admin']), cli(f.path, ['remove', 'backup'])]);
    assert.equal(results.filter((row) => row.code === 0).length, 1); assert.ok(results.some((row) => /final enabled admin|storage is busy/.test(row.output)));
    assert.equal(f.users.records().filter((row) => row.role === 'admin' && !row.disabled).length, 1);
    const last = f.users.records().find((row) => row.role === 'admin' && !row.disabled)!;
    const retry = await cli(f.path, ['remove', last.name]); assert.equal(retry.code, 1); assert.match(retry.output, /final enabled admin/);
  } finally { await f.close(); }
});
