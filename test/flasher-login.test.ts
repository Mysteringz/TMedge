import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { flasherLogin } from '../src/algo/flasher-login.js';
import { createConsole } from '../src/edge/console.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { applicationErrorHandler } from '../src/infrastructure/http/errors.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

test('native login codes expire at sixty seconds and admission readiness is required before browser consent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-native-login-'));
  const nodesPath = join(directory, 'nodes.json'), usersPath = join(directory, 'users.json');
  writeFileSync(nodesPath, JSON.stringify(nodesJson()));
  await new AlgoUsers(usersPath).add('alice', 'local test account password', 'engineer');
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath, dataDir: directory, recordRaw: false, consolePort: 0,
    algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 1000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  const rt = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson())), core = createConsole(rt);
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'test'));
  let now = Date.now();
  const native = flasherLogin(auth, core, () => now), app = express();
  app.use(express.json({ limit: '4kb' }));
  app.use(auth.router);
  app.use('/api/tmflash', native.machine);
  app.use('/api/tmflash', auth.requireUser, native.browser);
  app.use(applicationErrorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    const login = await post('/auth/login', { username: 'alice', password: 'local test account password' });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const verifier = randomBytes(32).toString('base64url');
    const input = { challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
    const consent = await post('/api/tmflash/authorize', input, { cookie, 'x-tm-algo': '1' });
    assert.equal(consent.status, 200);
    const code = new URL((await consent.json() as { redirect: string }).redirect).searchParams.get('code');
    now += 60_000;
    assert.equal((await post('/api/tmflash/exchange', { code, verifier })).status, 401);
    assert.deepEqual(core.flasherCredentials.list(), [], 'expired codes cannot create account sessions');
    writeFileSync(nodesPath, '{}');
    const refused = await post('/api/tmflash/authorize', input, { cookie, 'x-tm-algo': '1' });
    assert.equal(refused.status, 503);
    assert.ok(!(await refused.text()).includes(directory), 'storage paths never reach the login UI');
    const originalReady = core.provisioningService.ready;
    let release: (() => void) | undefined;
    core.provisioningService.ready = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = post('/api/tmflash/authorize', input, { cookie, 'x-tm-algo': '1' });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await post('/auth/logout', {}, { cookie })).status, 200);
    (release as () => void)();
    assert.equal((await pending).status, 401, 'logout during readiness cannot create a native grant');
    core.provisioningService.ready = originalReady;
  } finally {
    await core.dispose(); await rt.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
