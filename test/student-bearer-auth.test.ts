import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebApp, type WebConfig } from '../src/web/main.js';
import type { User } from '../src/modules/student-auth/domain/user.js';
import { StudentActivityLog } from '../src/modules/student-auth/application/student-activity-log.js';
import type { StudentActivityEvent } from '../src/modules/student-auth/repositories/student-activity-repository.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';

const CREDENTIALS = { email: 'u3587219@connect.hku.hk', name: 'Student', password: 'correct horse battery' };

interface TokenResponse { access_token: string; token_type: string; expires_in: number }

async function start(options: { usersPath?: string; turnstile?: WebConfig['turnstile']; secret?: string } = {}) {
  const events: StudentActivityEvent[] = [];
  const activity = new StudentActivityLog({ record: async (event) => { events.push(event); }, prune: async () => 0 });
  const usersPath = options.usersPath ?? join(mkdtempSync(join(tmpdir(), 'student-bearer-')), 'users.json');
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: 'edge-token-for-tests-0123456789',
    sessionSecret: Buffer.from(options.secret ?? 's'.repeat(40)), usersPath,
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false,
    staleMs: 30_000, turnstile: options.turnstile,
  }, { activity });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual',
  });
  const login = (headers: Record<string, string> = {}) => post('/api/auth/token', CREDENTIALS, headers);
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: 'manual' });
  return { ...web, base, usersPath, events, post, login, get, close: async () => {
    await web.dispose();
    web.server.closeAllConnections();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
  } };
}

test('student tokens open student HTTP APIs without setting a browser cookie', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const response = await web.post('/api/auth/token', { ...CREDENTIALS, email: 'u3587219' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  const token = await response.json() as TokenResponse;
  assert.equal(token.token_type, 'Bearer');
  assert.equal(token.expires_in, 900);
  const headers = { authorization: `Bearer ${token.access_token}` };
  const me = await web.get('/api/me', headers);
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: CREDENTIALS.email, name: CREDENTIALS.name });
  assert.match(me.headers.get('vary') ?? '', /Authorization/);
  for (const path of ['/api/occupancy', '/api/search?seats=2']) {
    assert.equal((await web.get(path, headers)).status, 200);
  }
  assert.equal((await web.get('/api/me', { authorization: `bearer ${token.access_token}` })).status, 200);
  assert.equal((await web.get('/dashboard/', headers)).status, 302, 'bearer access does not replace browser login');
  const push = await web.post('/api/edge/snapshot', {}, headers);
  assert.equal(push.status, 401, 'student tokens cannot publish edge snapshots');
  await web.activity?.flush();
  assert.ok(web.events.some((event) => event.action === 'login' && event.outcome === 'succeeded'));
  const audit = JSON.stringify(web.events);
  for (const secret of [token.access_token, CREDENTIALS.email, CREDENTIALS.password]) assert.ok(!audit.includes(secret));
});

test('browser sessions remain independent; mixed or malformed credentials cannot fall back to cookies', async (t) => {
  const web = await start();
  t.after(web.close);
  const signup = await web.post('/signup', CREDENTIALS);
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal((await web.get('/api/me', { cookie })).status, 200);
  const token = await (await web.login()).json() as TokenResponse;
  for (const authorization of [`Bearer ${token.access_token}`, 'Basic abc', 'Bearer invalid']) {
    assert.equal((await web.get('/api/me', { cookie, authorization })).status, 400);
  }
  assert.equal((await web.get('/api/me', { cookie: 'tm_session=%ZZ', authorization: `Bearer ${token.access_token}` })).status, 400);
  for (const authorization of ['Basic abc', 'Bearer', 'Bearer a,b', `Bearer ${'x'.repeat(2049)}`]) {
    assert.equal((await web.get('/api/me', { authorization })).status, 400);
  }
  assert.equal((await web.get('/api/me', { authorization: `Bearer ${cookie.split('=')[1]}` })).status, 401);
  assert.equal((await web.get('/api/me', { cookie: `tm_session=${token.access_token}` })).status, 401);
  assert.equal((await web.get('/api/me?access_token=' + token.access_token)).status, 401);
  assert.equal((await web.get('/api/me', { authorization: 'Bearer edge-token-for-tests-0123456789' })).status, 401);
  assert.equal((await web.post('/logout', {}, { cookie })).status, 200);
  assert.equal((await web.get('/api/me', { authorization: `Bearer ${token.access_token}` })).status, 200);
});

test('tokens expire at fifteen minutes and are not renewed into cookies', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const issuedAt = Date.now();
  const clock = t.mock.method(Date, 'now', () => issuedAt);
  const token = await (await web.login()).json() as TokenResponse;
  const headers = { authorization: `Bearer ${token.access_token}` };
  clock.mock.mockImplementation(() => issuedAt + 8 * 60_000);
  const active = await web.get('/api/me', headers);
  assert.equal(active.status, 200);
  assert.equal(active.headers.get('set-cookie'), null);
  clock.mock.mockImplementation(() => issuedAt + 15 * 60_000);
  const expired = await web.get('/api/me', headers);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
});

test('browser cookies still renew after half their lifetime', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const issuedAt = Date.now();
  const clock = t.mock.method(Date, 'now', () => issuedAt);
  const login = await web.post('/login', CREDENTIALS);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  clock.mock.mockImplementation(() => issuedAt + 8 * 24 * 3600_000);
  const response = await web.get('/api/me', { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /tm_session=.*HttpOnly.*SameSite=Lax/);
});

test('revocation survives restart, affects only the presented token, and preserves browser sessions', async (t) => {
  const first = await start();
  t.after(first.close);
  const signup = await first.post('/signup', CREDENTIALS);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const revoked = await (await first.login()).json() as TokenResponse;
  const active = await (await first.login()).json() as TokenResponse;
  const response = await fetch(first.base + '/api/auth/token', {
    method: 'DELETE', headers: { authorization: `Bearer ${revoked.access_token}` },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await first.get('/api/me', { cookie })).status, 200);
  assert.equal((await first.get('/api/me', { authorization: `Bearer ${revoked.access_token}` })).status, 401);
  const second = await start({ usersPath: first.usersPath });
  t.after(second.close);
  assert.equal((await second.get('/api/me', { authorization: `Bearer ${revoked.access_token}` })).status, 401);
  assert.equal((await second.get('/api/me', { authorization: `Bearer ${active.access_token}` })).status, 200);
  const cookieRevoke = await fetch(first.base + '/api/auth/token', { method: 'DELETE', headers: { cookie } });
  assert.equal(cookieRevoke.status, 400);
  writeFileSync(join(first.usersPath, '..', 'student-token-revocations.json'), '{broken');
  assert.equal((await second.get('/api/me', { authorization: `Bearer ${active.access_token}` })).status, 401);
});

test('tampering, account removal, password resets and secret rotation invalidate access tokens', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const token = await (await web.login()).json() as TokenResponse;
  const headers = { authorization: `Bearer ${token.access_token}` };
  const forged = token.access_token.slice(0, -2) + 'xx';
  assert.equal((await web.get('/api/me', { authorization: `Bearer ${forged}` })).status, 401);
  const rotated = await start({ usersPath: web.usersPath, secret: 'another-secret'.repeat(4) });
  t.after(rotated.close);
  assert.equal((await rotated.get('/api/me', headers)).status, 401);
  const users = JSON.parse(readFileSync(web.usersPath, 'utf8')) as User[];
  writeFileSync(web.usersPath, '[]');
  const removed = await start({ usersPath: web.usersPath });
  t.after(removed.close);
  assert.equal((await removed.get('/api/me', headers)).status, 401);
  for (const user of users) user.hash = 'a'.repeat(64);
  writeFileSync(web.usersPath, JSON.stringify(users));
  const reset = await start({ usersPath: web.usersPath });
  t.after(reset.close);
  assert.equal((await reset.get('/api/me', headers)).status, 401);
});

test('token login preserves Turnstile, credential validation and the shared browser login limit', async (t) => {
  const seen: string[] = [];
  const web = await start({ turnstile: {
    siteKey: 'test-site-key', secretKey: 'test-secret', hostnames: ['localhost'],
    check: async (token, action) => { seen.push(action); return token === 'verified'; },
  } });
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  assert.equal((await web.post('/api/auth/token', { email: [], password: 123 })).status, 400);
  assert.equal((await web.login()).status, 403);
  assert.equal((await web.login({ origin: 'https://evil.example' })).status, 403);
  const credentials = { ...CREDENTIALS, 'cf-turnstile-response': 'verified' };
  assert.equal((await web.post('/api/auth/token', { ...credentials, password: 'wrong-password' })).status, 401);
  assert.equal((await web.post('/api/auth/token', credentials)).status, 200);
  assert.ok(seen.every((action) => action === 'login'));
  for (let index = 0; index < 7; index++) await web.post('/login', { ...credentials, password: 'wrong-password' });
  assert.equal((await web.post('/api/auth/token', credentials)).status, 429);
  const malformed = await fetch(web.base + '/api/auth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get('cache-control'), 'no-store');
  await web.activity?.flush();
  assert.ok(web.events.some((event) => event.action === 'login' && event.outcome === 'rate-limited'));
});

test('a token revoked during an asynchronous account lookup cannot finish authorizing', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const token = await (await web.login()).json() as TokenResponse;
  const headers = { authorization: `Bearer ${token.access_token}` };
  let reachedLookup: () => void = () => undefined;
  const lookup = new Promise<void>((resolve) => { reachedLookup = resolve; });
  let releaseLookup: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const get = web.users.get.bind(web.users);
  const accounts = {
    count: () => web.users.count(),
    get: async (email: string) => { reachedLookup(); await released; return get(email); },
    create: web.users.create.bind(web.users), verify: web.users.verify.bind(web.users),
  };
  const delayed = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: 'edge-token-for-tests-0123456789',
    sessionSecret: Buffer.from('s'.repeat(40)), usersPath: web.usersPath,
    allowedDomains: ['connect.hku.hk'], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  }, { accounts });
  await new Promise<void>((resolve) => delayed.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    releaseLookup();
    await delayed.dispose();
    delayed.server.closeAllConnections();
    await new Promise<void>((resolve) => delayed.server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(delayed.server.address() as AddressInfo).port}`;
  const pending = fetch(base + '/api/me', { headers });
  await lookup;
  try {
    assert.equal((await fetch(web.base + '/api/auth/token', { method: 'DELETE', headers })).status, 204);
  } finally { releaseLookup(); }
  assert.equal((await pending).status, 401);
});

test('bearer access fails closed when asynchronous student account storage is unavailable', async (t) => {
  const web = await start();
  t.after(web.close);
  await web.users.create(CREDENTIALS.email, CREDENTIALS.name, CREDENTIALS.password);
  const token = await (await web.login()).json() as TokenResponse;
  web.users.get = () => { throw new ApplicationError('unavailable', 'Student account storage unavailable'); };
  const response = await web.get('/api/me', { authorization: `Bearer ${token.access_token}` });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Student account storage unavailable' });
  web.users.get = () => { throw new Error('private storage details'); };
  const unexpected = await web.get('/api/me', { authorization: `Bearer ${token.access_token}` });
  assert.equal(unexpected.status, 500);
  assert.ok(!(await unexpected.text()).includes('private storage details'));
});
