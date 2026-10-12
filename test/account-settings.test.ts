/**
 * A person's own account: /api/account on the algo console. Every role has
 * it, it only ever acts on whoever is signed in, and what it keeps -- an
 * address to be reached at -- is nobody else's to read.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { DEFAULT_NODE_LIMITS } from '../src/edge/config.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { buildRegistry } from '../src/edge/registry.js';
import { emailAddress, parseSettings } from '../src/modules/algo-admin/domain/account-settings.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

const PASSWORD = 'correct horse battery';
const running: (() => Promise<void>)[] = [];
after(async () => { for (const stop of running.splice(0)) await stop(); });

async function boot(options: { signIn?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-account-'));
  writeFileSync(join(directory, 'nodes.json'), JSON.stringify(nodesJson()));
  const config = {
    edgeId: 'account-settings', keys: [KEY], allowUnsigned: false,
    udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: join(directory, 'nodes.json'), dataDir: directory,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1',
    adminPassword: options.signIn === false ? null : 'local-test', flashToken: null, pushUrls: [], pushToken: '',
    publishMs: 1000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1',
    nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
    persistenceMode: 'file' as const, postgres: null,
  };
  const runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const usersPath = join(directory, 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('alice', PASSWORD, 'admin');
  await users.add('vera', PASSWORD, 'viewer', undefined, ['ml']);
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath, DATA_DIR: directory }, config.adminPassword));
  await new Promise<void>((done) => { if (handle.server.listening) done(); else handle.server.once('listening', () => done()); });
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  running.push(async () => {
    await handle.dispose();
    await new Promise<void>((done) => handle.server.close(() => done()));
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const signIn = async (username: string, password = PASSWORD): Promise<string> => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200, `${username} signs in`);
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };
  const call = (path: string, cookie: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-tm-algo': '1' }) => fetch(`${base}/api/account${path}`, {
    method, headers: { 'content-type': 'application/json', cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (cookie: string) => (await (await call('', cookie)).json() as { data: { name: string; role: string; teamRoles: string[]; namedAccount: boolean; emailDelivery: boolean; settings: { email: string | null; notify: string[] } } }).data;
  return { base, directory, users, usersPath, signIn, call, read, settingsPath: join(directory, 'account-settings.json') };
}

test('everyone has an account page, and it is always their own', async () => {
  const { base, signIn, call, read } = await boot();
  assert.equal((await fetch(`${base}/api/account`)).status, 401, 'no session, no account');
  const [alice, vera] = [await signIn('alice'), await signIn('vera')];
  const mine = await read(vera);
  assert.deepEqual([mine.name, mine.role, mine.teamRoles, mine.namedAccount, mine.settings], ['vera', 'viewer', ['ml'], true, { email: null, notify: [] }]);
  assert.equal(mine.emailDelivery, false, 'a server that cannot send email says so, rather than letting the page promise mail');

  // A viewer may change nothing else on this console, and may still keep their own address.
  const saved = await call('/settings', vera, 'PUT', { email: '  Vera.Chan@Example.COM ', notify: ['task', 'sensor'] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await read(vera)).settings, { email: 'Vera.Chan@example.com', notify: ['sensor', 'task'] });

  // There is no argument that reaches somebody else: the session is the only name there is.
  assert.deepEqual((await read(alice)).settings, { email: null, notify: [] });
  for (const attempt of [{ email: 'a@example.com', notify: [], name: 'vera' }, { email: 'a@example.com', notify: [], user: 'vera' }]) {
    assert.equal((await call('/settings', alice, 'PUT', attempt)).status, 400, 'a field naming an account is refused, not ignored');
  }
  assert.equal((await call('/vera', alice)).status, 404);
  assert.equal((await call('/vera/settings', alice, 'PUT', { email: 'a@example.com', notify: [] })).status, 404);
  assert.deepEqual((await read(vera)).settings, { email: 'Vera.Chan@example.com', notify: ['sensor', 'task'] });
});

test('an address is its owner’s: no admin, list or page hands it to anyone else, and it is kept in a private file', async () => {
  const { base, signIn, call, settingsPath } = await boot();
  const [alice, vera] = [await signIn('alice'), await signIn('vera')];
  assert.equal((await call('/settings', vera, 'PUT', { email: 'vera@example.com', notify: ['mail'] })).status, 200);
  for (const path of ['/api/admin/accounts?offset=0&limit=25', '/api/workspace', '/api/workspace/members', '/api/me', '/api/assistant', '/api/admin/notifications']) {
    const response = await fetch(base + path, { headers: { cookie: alice } });
    assert.ok(!(await response.text()).includes('vera@example.com'), `${path} does not carry it`);
  }
  assert.equal(statSync(settingsPath).mode & 0o077, 0, 'readable by the service account only');
  assert.ok(readFileSync(settingsPath, 'utf8').includes('vera@example.com'));
});

test('an address is one plain address, and choices come from the list', async () => {
  const { signIn, call, read } = await boot();
  const vera = await signIn('vera');
  for (const email of ['vera', 'vera@', '@example.com', 'vera@example', 'a b@example.com', 'vera@example.com, boss@example.com', 'Vera <vera@example.com>', 'vera@example.com\r\nBcc: x@example.com', 'vera@-example.com', `${'a'.repeat(250)}@example.com`, 42, ['vera@example.com']]) {
    const refused = await call('/settings', vera, 'PUT', { email, notify: [] });
    assert.equal(refused.status, 400, JSON.stringify(email));
  }
  for (const notify of [['sensor', 'everything'], 'sensor', null, [1]]) assert.equal((await call('/settings', vera, 'PUT', { email: 'vera@example.com', notify })).status, 400, JSON.stringify(notify));
  assert.deepEqual((await read(vera)).settings, { email: null, notify: [] }, 'a refused save keeps nothing');
  assert.equal(emailAddress('first.last+console@mail.hku.hk'), 'first.last+console@mail.hku.hk');

  // No address means nothing to send to: choices are not kept as though they applied.
  assert.equal((await call('/settings', vera, 'PUT', { email: 'vera@example.com', notify: ['sensor', 'firmware'] })).status, 200);
  assert.equal((await call('/settings', vera, 'PUT', { email: null, notify: ['sensor'] })).status, 200);
  assert.deepEqual((await read(vera)).settings, { email: null, notify: [] });
  assert.equal((await call('/settings', vera, 'PUT', { email: '', notify: [] })).status, 200);
});

test('a write needs the console’s own page: a cross-site form cannot change an address or a password', async () => {
  const { base, signIn, call, read } = await boot();
  const vera = await signIn('vera');
  const body = { email: 'attacker@example.com', notify: [] };
  assert.equal((await call('/settings', vera, 'PUT', body, {})).status, 403, 'no x-tm-algo header');
  assert.equal((await call('/settings', vera, 'PUT', body, { 'x-tm-algo': '1', origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await call('/password', vera, 'POST', { current: PASSWORD, password: 'a new long password' }, {})).status, 403);
  assert.equal((await call('/session-revocations', vera, 'POST', {}, {})).status, 403);
  assert.equal((await call('/settings', vera, 'PUT', body, { 'x-tm-algo': '1', origin: base })).status, 200, 'the console itself may');
  assert.equal((await read(vera)).settings.email, 'attacker@example.com');
});

test('a new account with an old username does not inherit the last one’s address, and a removed account leaves none behind', async () => {
  const { users, signIn, call, read, settingsPath } = await boot();
  assert.equal((await call('/settings', await signIn('vera'), 'PUT', { email: 'vera@example.com', notify: ['mail'] })).status, 200);
  users.remove('vera');
  await new Promise((done) => setTimeout(done, 5));
  await users.add('vera', PASSWORD, 'operator');
  assert.deepEqual((await read(await signIn('vera'))).settings, { email: null, notify: [] }, 'the name came back; the person did not');

  // The next save by anybody drops what belonged to the account that is gone.
  assert.ok(readFileSync(settingsPath, 'utf8').includes('vera@example.com'));
  assert.equal((await call('/settings', await signIn('alice'), 'PUT', { email: 'alice@example.com', notify: [] })).status, 200);
  const kept = parseSettings(JSON.parse(readFileSync(settingsPath, 'utf8')));
  assert.deepEqual(kept.accounts.map((entry) => [entry.name, entry.email]), [['alice', 'alice@example.com']]);
});

test('changing a password takes the current one, keeps this session and ends every other', async () => {
  const { base, signIn, call } = await boot();
  const [here, elsewhere] = [await signIn('vera'), await signIn('vera')];
  const next = 'an entirely new passphrase';
  const me = (cookie: string) => fetch(`${base}/api/me`, { headers: { cookie } }).then((response) => response.status);

  for (const [body, why] of [
    [{ current: 'not the password', password: next }, 'a wrong current password'],
    [{ current: PASSWORD, password: 'short' }, 'a short new password'],
    [{ current: PASSWORD, password: PASSWORD }, 'the same password again'],
    [{ password: next }, 'no current password'],
    [{ current: PASSWORD, password: next, role: 'admin' }, 'an extra field'],
  ] as const) {
    const refused = await call('/password', here, 'POST', body);
    assert.ok([400, 403].includes(refused.status), why);
    assert.equal(refused.headers.get('set-cookie'), null, `${why} hands out no session`);
  }
  assert.deepEqual([await me(here), await me(elsewhere)], [200, 200], 'and nothing was changed by the refusals');

  const changed = await call('/password', here, 'POST', { current: PASSWORD, password: next });
  assert.equal(changed.status, 200);
  const renewed = (changed.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(changed.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.deepEqual([await me(renewed), await me(here), await me(elsewhere)], [200, 401, 401], 'this browser carries on with a new session; the old ones are dead');
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vera', password: PASSWORD }) })).status, 401);
  await signIn('vera', next);
});

test('a wrong current password is counted, so a borrowed session cannot be used to guess it', async () => {
  const { signIn, call } = await boot();
  const vera = await signIn('vera');
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) statuses.push((await call('/password', vera, 'POST', { current: `guess number ${attempt}`, password: 'an entirely new passphrase' })).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429, 429]);
  assert.equal((await call('/password', vera, 'POST', { current: PASSWORD, password: 'an entirely new passphrase' })).status, 429, 'the right one waits too');
});

test('signing out everywhere ends every session of the account, this one included, and nobody else’s', async () => {
  const { base, signIn, call } = await boot();
  const [here, elsewhere, alice] = [await signIn('vera'), await signIn('vera'), await signIn('alice')];
  const me = (cookie: string) => fetch(`${base}/api/me`, { headers: { cookie } }).then((response) => response.status);
  const ended = await call('/session-revocations', here, 'POST', {});
  assert.equal(ended.status, 200);
  assert.match(ended.headers.get('set-cookie') ?? '', /tm_algo=;/, 'the cookie is cleared');
  assert.deepEqual([await me(here), await me(elsewhere), await me(alice)], [401, 401, 200]);
  assert.equal(await me(await signIn('vera')), 200, 'the password still works');
});

test('with sign-in off there is one local operator and no account to keep settings for', async () => {
  const { base, call } = await boot({ signIn: false });
  const local = await (await fetch(`${base}/api/account`)).json() as { data: { name: string; namedAccount: boolean; settings: unknown } };
  assert.deepEqual([local.data.name, local.data.namedAccount, local.data.settings], ['local', false, { email: null, notify: [] }]);
  const refused = await call('/settings', '', 'PUT', { email: 'local@example.com', notify: [] });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'LOCAL_MODE');
  assert.equal((await call('/password', '', 'POST', { current: 'x', password: 'an entirely new passphrase' })).status, 403);
});

test('a settings file this console cannot fully read is refused, never overwritten', async () => {
  const { signIn, call, settingsPath } = await boot();
  const vera = await signIn('vera');
  for (const content of ['{ not json', JSON.stringify({ version: 2, accounts: [] }), JSON.stringify({ version: 1, accounts: [{ name: 'vera', accountCreatedAt: 1, updatedAt: 1, email: 'a@example.com, b@example.com', notify: [] }] })]) {
    writeFileSync(settingsPath, content);
    assert.equal((await call('', vera)).status, 503);
    assert.equal((await call('/settings', vera, 'PUT', { email: 'vera@example.com', notify: [] })).status, 503);
    assert.equal(readFileSync(settingsPath, 'utf8'), content, 'what was there is still there for somebody to look at');
  }
});
