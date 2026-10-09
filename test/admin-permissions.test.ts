import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createConsole } from '../src/edge/console.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { nodeCommandCapability, principal } from '../src/modules/algo-admin/domain/permissions.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

test('policy distinguishes reader, engineer, admin and local account management', () => {
  assert.deepEqual(principal('reader', 'viewer').capabilities, ['algo.read', 'training.read', 'firmware.read']);
  assert.ok(principal('operator', 'operator').capabilities.includes('training.write'));
  assert.ok(!principal('operator', 'operator').capabilities.includes('firmware.write'));
  assert.ok(principal('engineer', 'engineer').capabilities.includes('firmware.write'));
  assert.ok(principal('engineer', 'engineer').capabilities.includes('nodes.admin'));
  assert.ok(!principal('engineer', 'engineer').capabilities.includes('accounts.manage'));
  assert.ok(!principal('local', 'admin', false).capabilities.includes('accounts.manage'));
  for (const op of ['set', 'reset-bg', 'identify', 'save']) assert.equal(nodeCommandCapability({ op }), 'nodes.write');
  for (const op of ['reboot', 'ota', 'erase', undefined, 1]) assert.equal(nodeCommandCapability({ op }), 'nodes.admin');
});

test('legacy normalization, explicit bootstrap, duplicate create and serialized final-admin safety', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-roles-')), 'users.json');
  const users = new AlgoUsers(path);
  await users.add('legacy', 'a long test password');
  const records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  for (const record of records) { delete record.role; delete record.disabled; delete record.sessionVersion; }
  writeFileSync(path, JSON.stringify(records));
  assert.equal(users.get('legacy')?.role, 'engineer');
  assert.equal(users.get('legacy')?.sessionVersion, 0);
  await assert.rejects(users.add('legacy', 'another long password'), /already exists/);
  users.update('legacy', { role: 'admin' });
  assert.throws(() => users.remove('legacy'), /final enabled admin/);
  assert.throws(() => new AlgoUsers(path).update('legacy', { disabled: true }), /final enabled admin/);
  await users.add('second', 'another long password', 'admin');
  users.update('legacy', { role: 'engineer' });
  assert.throws(() => new AlgoUsers(path).update('second', { role: 'viewer' }), /final enabled admin/);
  users.update('legacy', { disabled: true });
  assert.equal(await users.verify('legacy', 'a long test password'), null);
  users.update('legacy', { disabled: false });
  const stale = users.get('legacy')!;
  const resetting = users.resetPassword('legacy', 'replacement password');
  users.update('legacy', { revoke: true });
  await assert.rejects(resetting, /account changed/);
  assert.throws(() => users.update('legacy', { disabled: true }, stale), /account changed/);
  assert.equal(await users.verify('legacy', 'a long test password'), 'legacy', 'failed stale reset preserves original credentials');
  const invalid = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  invalid[0]!.role = 'superuser'; writeFileSync(path, JSON.stringify(invalid));
  assert.equal(users.size, 0, 'malformed roles fail closed');
});

test('HTTP permissions guard every mutation family and external CLI edits close idle feeds', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-role-api-'));
  const cfg: EdgeConfig = {
    edgeId: 'role-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir, recordRaw: false, consolePort: 0, algoPort: 0,
    consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '',
    publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0,
    nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  const usersPath = join(dataDir, 'users.json'), users = new AlgoUsers(usersPath);
  for (const role of ['viewer', 'operator', 'engineer', 'admin'] as const) await users.add(role, 'a long test password', role);
  const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  const consoleCore = createConsole(runtime);
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, cfg.adminPassword), consoleCore);
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  const login = async (username: string) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a long test password' }) });
    assert.equal(response.status, 200);
    return (response.headers.get('set-cookie') ?? '').split(';')[0]!;
  };
  try {
    const operator = await login('operator'), viewer = await login('viewer'), engineer = await login('engineer'), admin = await login('admin');
    const write = (cookie: string, path: string, body: unknown = {}, method = 'POST') => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1', 'x-tm-console': '1' }, body: JSON.stringify(body) });
    for (const path of ['/api/run', '/api/mode', '/api/pipeline/save', '/api/params/apply', '/api/params/commit', '/api/params/revert', '/api/params/persist', '/api/node/reset-background', '/api/pairs/record', '/api/pairs/prune', '/api/train/uploads', '/api/train/jobs', '/api/train/hpc/ticket', '/api/train/hpc/connect', '/api/train/hpc/term']) {
      assert.equal((await write(viewer, path)).status, 403, path);
    }
    for (const path of ['/api/catalogue', '/api/params', '/console-app/api/state', '/console-app/api/firmware']) assert.equal((await fetch(`${base}${path}`, { headers: { cookie: viewer } })).status, 200, path);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: viewer } })).json() as { role: string; capabilities: string[] };
    assert.equal(me.role, 'viewer'); assert.ok(!me.capabilities.includes('algo.write'));
    for (const path of ['/console-app/api/firmware/cleanup', '/console-app/api/firmware/uploads', '/console-app/api/firmware/rollout', '/console-app/api/firmware/rollout/cancel', '/console-app/api/nodes/0000000000000001/reset-cursor', '/console-app/api/provision/requests/missing/approve']) assert.equal((await write(operator, path)).status, 403, path);
    assert.equal((await write(operator, '/console-app/api/nodes/0000000000000001/command', { op: 'reboot' })).status, 403);
    assert.equal((await write(operator, '/console-app/api/nodes/0000000000000001/command', { opcode: 7 })).status, 403);
    for (const path of ['/console-app/api/firmware/cleanup', '/console-app/api/nodes/0000000000000001/reset-cursor', '/console-app/api/provision/requests/missing/approve']) assert.notEqual((await write(engineer, path)).status, 403, path);
    assert.notEqual((await write(engineer, '/console-app/api/nodes/0000000000000001/command', { op: 'reboot' })).status, 403);
    assert.equal((await write(admin, '/console-app/api/nodes/0000000000000001/command', { op: 'ota' })).status, 400, 'unknown raw operations remain rejected');
    assert.equal((await write(engineer, '/api/pipeline/save', { name: 'permissions-test' })).status, 200);
    const token = (await (await fetch(`${base}/api/ws-token`, { headers: { cookie: engineer } })).json() as { token: string }).token;
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token)}`, { headers: { cookie: engineer } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => { ws.terminate(); reject(new Error('revoked idle feed remained open')); }, 7000); ws.once('close', () => { clearTimeout(timeout); resolve(); }); });
    new AlgoUsers(usersPath).update('engineer', { role: 'viewer' });
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: engineer } })).status, 401);
    await closed;
    const newCookie = await login('engineer');
    assert.equal((await write(newCookie, '/api/run')).status, 403);
    users.update('engineer', { revoke: true });
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: newCookie } })).status, 401);
    const deletedCookie = await login('engineer');
    const deletedToken = (await (await fetch(`${base}/api/ws-token`, { headers: { cookie: deletedCookie } })).json() as { token: string }).token;
    users.remove('engineer'); await users.add('engineer', 'a long test password', 'engineer');
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: deletedCookie } })).status, 401);
    await new Promise<void>((resolve, reject) => {
      const oldSocket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(deletedToken)}`, { headers: { cookie: deletedCookie } });
      oldSocket.once('open', () => { oldSocket.terminate(); reject(new Error('old ticket revived after account recreation')); });
      oldSocket.once('unexpected-response', (_request, response) => { assert.notEqual(response.statusCode, 101); response.resume(); resolve(); });
      oldSocket.once('error', () => resolve());
    });
  } finally { await handle.dispose(); await new Promise<void>((resolve) => handle.server.close(() => resolve())); await runtime.stop(); }
});
