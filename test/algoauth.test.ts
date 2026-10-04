/**
 * Claims about signing in to the algo console (algo.hkumyseat.com).
 *
 * The browser's own password dialog is gone: nothing here ever answers with
 * WWW-Authenticate. A person signs in on a page, as themselves, past a
 * Turnstile check, and only then does any API answer -- while the deploy
 * health check still gets the 401 it counts as "up".
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig, safeAlgoNext, type AlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { Sessions } from '../src/web/auth.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

const SECRET = 'x'.repeat(40);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tmedge-algoauth-'));

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return new EdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

const running: (() => Promise<void>)[] = [];
after(async () => { for (const stop of running) await stop(); });

/** An algo server with one account, alice, and whatever auth settings the test wants. */
async function boot(over: Partial<AlgoAuthConfig> = {}, env: NodeJS.ProcessEnv = {}) {
  const usersPath = join(mkdtempSync(join(tmpdir(), 'tmedge-algousers-')), 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('alice', 'correct horse battery');
  const cfg: AlgoAuthConfig = {
    ...loadAlgoAuthConfig({ SESSION_SECRET: SECRET, ALGO_USERS_FILE: usersPath, ...env }, 'admin-pass'),
    ...over,
  };
  const rt = runtime();
  const { server } = startAlgo(rt, 0, '127.0.0.1', cfg);
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  running.push(async () => { server.close(); await rt.stop(); });
  return { base, users };
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

test('nothing asks the browser for a password; the API says 401 and pages go to /login', async () => {
  const { base } = await boot();
  const api = await fetch(`${base}/api/catalogue`);
  assert.equal(api.status, 401, 'the deploy health check counts 401 as up');
  assert.equal(api.headers.get('www-authenticate'), null, 'a WWW-Authenticate header is what drew the browser dialog');
  for (const path of ['/', '/flow', '/train', '/index.html']) {
    const page = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(page.status, 302, path);
    assert.equal(page.headers.get('www-authenticate'), null, path);
    assert.match(page.headers.get('location') ?? '', /^\/(login|$)/, path);
  }
  const flow = await fetch(`${base}/flow`, { redirect: 'manual' });
  assert.equal(flow.headers.get('location'), '/login?next=%2Fflow', 'and comes back to the page it asked for');
});

test('the right account signs in and opens the API; wrong or unknown ones do not', async () => {
  const { base } = await boot();
  assert.equal((await post(base, '/auth/login', { username: 'alice', password: 'wrong password!!' })).status, 401);
  assert.equal((await post(base, '/auth/login', { username: 'mallory', password: 'correct horse battery' })).status, 401);
  assert.equal((await post(base, '/auth/login', { username: '', password: '' })).status, 400);

  const ok = await post(base, '/auth/login', { username: 'Alice', password: 'correct horse battery', next: '/flow' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, user: 'alice', redirect: '/flow' });
  const setCookie = ok.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = cookieOf(ok);

  const me = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { user: string }).user, 'alice');
  assert.equal((await fetch(`${base}/api/catalogue`, { headers: { cookie } })).status, 200);
  // Signed in, the sign-in page sends you on rather than asking again.
  const login = await fetch(`${base}/login?next=/train`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/train');

  const out = await post(base, '/auth/logout', {}, { cookie });
  assert.match(out.headers.get('set-cookie') ?? '', /tm_algo=;/);
});

test('a removed account is signed out on its next request, not when its cookie expires', async () => {
  const { base, users } = await boot();
  const cookie = cookieOf(await post(base, '/auth/login', { username: 'alice', password: 'correct horse battery' }));
  assert.equal((await fetch(`${base}/api/catalogue`, { headers: { cookie } })).status, 200);
  // Another process (npm run algo-user) edits the file; mtime granularity
  // can be coarse, so make sure the change is visible as one.
  await new Promise((r) => setTimeout(r, 20));
  new AlgoUsers(users.path).remove('alice');
  assert.equal((await fetch(`${base}/api/catalogue`, { headers: { cookie } })).status, 401);
});

test('a student session is not an engineer session, even with the same SESSION_SECRET', async () => {
  const { base } = await boot();
  // The student tier signs {e, x} with SESSION_SECRET itself; a token for a
  // name that happens to be an algo account must still be refused.
  const student = new Sessions(Buffer.from(SECRET)).issue('alice');
  assert.equal((await fetch(`${base}/api/catalogue`, { headers: { cookie: `tm_algo=${student}` } })).status, 401);
});

test('Turnstile is checked for this form before the password is', async () => {
  const seen: { token: string; action: string }[] = [];
  const { base } = await boot({
    turnstile: {
      siteKey: '1x00000000000000000000AA', secretKey: 's', hostnames: ['algo.example'],
      check: async (token, action) => { seen.push({ token, action }); return token === 'human'; },
    },
  });
  const none = await post(base, '/auth/login', { username: 'alice', password: 'correct horse battery' });
  assert.equal(none.status, 403, 'no token, no sign-in, even with the right password');
  const bot = await post(base, '/auth/login', { username: 'alice', password: 'correct horse battery', 'cf-turnstile-response': 'bot' });
  assert.equal(bot.status, 403);
  const ok = await post(base, '/auth/login', { username: 'alice', password: 'correct horse battery', 'cf-turnstile-response': 'human' });
  assert.equal(ok.status, 200);
  assert.ok(seen.every((s) => s.action === 'algo-login'), 'a student sign-in token is solved for another action');
});

test('the CSP admits Cloudflare only while Turnstile is on', async () => {
  const off = await boot();
  assert.match((await fetch(`${off.base}/login`)).headers.get('content-security-policy') ?? '', /frame-src 'none'/);
  const on = await boot({ turnstile: { siteKey: '1x00000000000000000000AA', secretKey: 's', hostnames: ['h'], check: async () => true } });
  const csp = (await fetch(`${on.base}/login`)).headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
});

test('sign-in refuses cross-origin and malformed Origin headers', async () => {
  const { base } = await boot();
  const creds = { username: 'alice', password: 'correct horse battery' };
  assert.equal((await post(base, '/auth/login', creds, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(base, '/auth/login', creds, { origin: 'null' })).status, 403, 'refused, not a 500');
  assert.equal((await post(base, '/auth/login', creds, { origin: base })).status, 200);
});

test('the limiter counts each visitor behind cloudflared separately, not everyone as 127.0.0.1', async () => {
  const { base } = await boot({ trustProxy: true });
  const wrong = { username: 'alice', password: 'not the password' };
  for (let i = 0; i < 10; i++) await post(base, '/auth/login', wrong, { 'x-forwarded-for': '203.0.113.7' });
  assert.equal((await post(base, '/auth/login', wrong, { 'x-forwarded-for': '203.0.113.7' })).status, 429);
  const other = await post(base, '/auth/login', { username: 'alice', password: 'correct horse battery' }, { 'x-forwarded-for': '198.51.100.9' });
  assert.equal(other.status, 200, 'one guesser does not lock out the team');
});

test('with no ADMIN_PASSWORD (a localhost-only edge) there is no sign-in at all', async () => {
  const cfg = loadAlgoAuthConfig({}, null);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.turnstile, null);
});

test('the config refuses half a setup', () => {
  assert.throws(() => loadAlgoAuthConfig({}, 'admin-pass'), /SESSION_SECRET/);
  assert.throws(() => loadAlgoAuthConfig({ SESSION_SECRET: SECRET, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, 'admin-pass'), /together/);
  assert.throws(() => loadAlgoAuthConfig({
    SESSION_SECRET: SECRET, TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 's',
  }, 'admin-pass'), /TURNSTILE_HOSTNAMES/);
});

test('after sign-in you go to a page on this site, never somewhere else', () => {
  assert.equal(safeAlgoNext('/flow'), '/flow');
  assert.equal(safeAlgoNext('//evil.example'), '/');
  assert.equal(safeAlgoNext('/\\evil.example'), '/');
  assert.equal(safeAlgoNext('https://evil.example'), '/');
  assert.equal(safeAlgoNext('/login'), '/');
  assert.equal(safeAlgoNext(undefined), '/');
});

test('accounts need a sensible name and a long password, and are stored hashed', async () => {
  const users = new AlgoUsers(join(mkdtempSync(join(tmpdir(), 'tmedge-algousers-')), 'users.json'));
  await assert.rejects(users.add('bob', 'short'), /12/);
  await assert.rejects(users.add('../etc', 'long enough password'), /username/);
  await users.add('bob', 'long enough password');
  assert.equal(await users.verify('BOB', 'long enough password'), 'bob');
  assert.equal(await users.verify('bob', 'long enough passwore'), null);
  const { readFileSync } = await import('node:fs');
  assert.ok(!readFileSync(users.path, 'utf8').includes('long enough password'));
});
