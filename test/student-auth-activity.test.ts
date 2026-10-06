import { studentSessionVersion } from '../src/modules/student-auth/application/student-session-service.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWebApp, loadWebConfig } from '../src/web/main.js';
import { JsonStudentAccountRepository } from '../src/infrastructure/web/json-student-account-repository.js';
import { StudentActivityLog } from '../src/modules/student-auth/application/student-activity-log.js';
import type { IStudentAccountRepository } from '../src/modules/student-auth/repositories/student-account-repository.js';
import type { StudentActivityEvent, StudentActivityRepository } from '../src/modules/student-auth/repositories/student-activity-repository.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';

async function start(options: { failActivity?: boolean; unavailable?: boolean; beforeGet?: () => Promise<void> } = {}) {
  const accounts = new JsonStudentAccountRepository(join(mkdtempSync(join(tmpdir(), 'student-activity-')), 'users.json'), ['connect.hku.hk']);
  const events: StudentActivityEvent[] = [];
  const adapter: IStudentAccountRepository = {
    count: async () => accounts.count(),
    get: async (email) => {
      await options.beforeGet?.();
      if (options.unavailable) throw new ApplicationError('unavailable', 'Student account storage unavailable');
      return accounts.get(email);
    },
    create: (email, name, password) => accounts.create(email, name, password),
    verify: async (email, password) => {
      if (options.unavailable) throw new ApplicationError('unavailable', 'Student account storage unavailable');
      return accounts.verify(email, password);
    },
  };
  const activity = new StudentActivityLog({
    record: async (event) => {
      if (options.failActivity) throw new Error('private database credentials');
      events.push(event);
    },
    prune: async () => 0,
  });
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: 'test-edge-token-long-enough', sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: 'unused.json', allowedDomains: ['connect.hku.hk'], signupOpen: true,
    cookieSecure: false, trustProxy: false, staleMs: 30_000, studentPersistenceMode: 'postgres',
  }, { accounts: adapter, activity });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  return { ...web, base, events, accounts, close: async () => {
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
  } };
}

function post(base: string, action: string, body: unknown, cookie = '') {
  return fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body), redirect: 'manual' });
}

function rejectedSocket(base: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { cookie }, handshakeTimeout: 2000 });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('error', (error) => {
      if (!/closed before the connection/.test(error.message)) reject(error);
    });
    socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected authorized socket')); });
  });
}

test('student activity follows signup/login/logout and excludes credentials and raw identifiers', async () => {
  const web = await start();
  try {
    const credentials = { email: 'student@connect.hku.hk', name: 'Student', password: 'correct horse battery' };
    const signup = await post(web.base, 'signup', credentials);
    assert.equal(signup.status, 200);
    assert.deepEqual(await signup.json(), { redirect: '/dashboard/' });
    const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const user = web.accounts.get(credentials.email);
    assert.ok(user?.id);
    const me = await fetch(`${web.base}/api/me`, { headers: { cookie } });
    assert.deepEqual(await me.json(), { email: credentials.email, name: 'Student' });
    assert.equal((await post(web.base, 'login', { ...credentials, password: 'wrong-password' })).status, 401);
    assert.equal((await post(web.base, 'login', credentials)).status, 200);
    const logout = await post(web.base, 'logout', {}, cookie);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /tm_session=;/);
    await web.activity?.flush();
    assert.deepEqual(web.events.map((event) => [event.action, event.outcome]), [
      ['signup', 'succeeded'], ['login', 'failed'], ['login', 'succeeded'], ['logout', 'succeeded'],
    ]);
    assert.ok(web.events.every((event) => event.userId === user.id));
    const serialized = JSON.stringify(web.events);
    for (const secret of [credentials.email, credentials.password, user.hash, user.salt, cookie]) assert.ok(!serialized.includes(secret));
    assert.equal(new Set(web.events.map((event) => event.requestId)).size, 4);
  } finally { await web.close(); }
});

test('unknown accounts and rate-limited attempts create anonymous activity; malformed input is rejected', async () => {
  const web = await start();
  try {
    assert.equal((await post(web.base, 'signup', { email: [], password: 42 })).status, 400);
    assert.equal((await post(web.base, 'login', { email: 'unknown@connect.hku.hk', password: 'some-password' })).status, 401);
    let lastStatus = 0;
    for (let index = 0; index < 10; index++) lastStatus = (await post(web.base, 'login', { email: 'unknown@connect.hku.hk', password: 'some-password' })).status;
    assert.equal(lastStatus, 429);
    await web.activity?.flush();
    assert.ok(web.events.every((event) => event.userId === null));
    assert.equal(web.events.at(-1)?.outcome, 'rate-limited');
    assert.ok(!JSON.stringify(web.events).includes('unknown@connect.hku.hk'));
  } finally { await web.close(); }
});

test('HTTP and WebSocket account checks await storage and fail closed', async () => {
  const web = await start();
  try {
    const missing = `tm_session=${web.sessions.issue('missing@connect.hku.hk')}`;
    assert.equal((await fetch(`${web.base}/api/occupancy`, { headers: { cookie: missing } })).status, 401);
    assert.equal(await rejectedSocket(web.base, missing), 401);
    const user = await web.accounts.create('known@connect.hku.hk', 'Known', 'correct horse battery');
    const cookie = `tm_session=${web.sessions.issue(user.email, Date.now(), studentSessionVersion(user))}`;
    const client = new WebSocket(web.base.replace('http:', 'ws:') + '/ws', { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { client.once('message', () => resolve()); client.once('error', reject); });
    client.terminate();
  } finally { await web.close(); }
  const unavailable = await start({ unavailable: true });
  try {
    const cookie = `tm_session=${unavailable.sessions.issue('known@connect.hku.hk')}`;
    assert.equal((await fetch(`${unavailable.base}/api/me`, { headers: { cookie } })).status, 503);
    assert.equal((await post(unavailable.base, 'login', { email: 'known@connect.hku.hk', password: 'correct horse battery' })).status, 503);
    assert.equal(await rejectedSocket(unavailable.base, cookie), 503);
    assert.equal((await post(unavailable.base, 'logout', {}, cookie)).status, 200);
  } finally { await unavailable.close(); }
});

test('activity storage failure leaves valid authentication usable and exposes failed writes', async () => {
  const web = await start({ failActivity: true });
  try {
    const credentials = { email: 'known@connect.hku.hk', name: 'Known', password: 'correct horse battery' };
    assert.equal((await post(web.base, 'signup', credentials)).status, 200);
    assert.equal((await post(web.base, 'login', credentials)).status, 200);
    await web.activity?.flush();
    assert.equal(web.activity?.stats().failedWrites, 2);
    assert.equal(web.activity?.stats().droppedEvents, 2);
    const health = await fetch(`${web.base}/readyz`);
    assert.equal(health.status, 200);
    assert.ok(!JSON.stringify(await health.json()).includes('private database credentials'));
  } finally { await web.close(); }
});

test('activity queue bounds include in-flight writes; retention and shutdown are explicit', async () => {
  const events: StudentActivityEvent[] = [];
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const before: number[] = [];
  const repository: StudentActivityRepository = {
    record: async (event) => { await blocked; events.push(event); },
    prune: async (timestamp) => { before.push(timestamp); return 1; },
  };
  const now = 2_000_000_000_000;
  const log = new StudentActivityLog(repository, { maxPending: 2, retentionDays: 30, now: () => now });
  assert.equal(log.record('login', 'failed', null, randomUUID()), true);
  assert.equal(log.record('login', 'failed', null, randomUUID()), true);
  assert.equal(log.record('login', 'failed', null, randomUUID()), false);
  assert.equal(log.stats().queuedEvents, 2);
  release();
  await log.flush();
  assert.equal(events.length, 2);
  assert.equal(log.stats().droppedEvents, 1);
  log.start();
  await log.flush();
  assert.deepEqual(before, [now - 30 * 86_400_000]);
  await log.dispose();
  assert.equal(log.record('login', 'failed', null, randomUUID()), false);
});

test('student persistence configuration is independent and validates retention', () => {
  const env = { WEB_PUSH_TOKEN: 't'.repeat(20), SESSION_SECRET: 's'.repeat(40), PERSISTENCE_MODE: 'postgres' };
  assert.equal(loadWebConfig(env).studentPersistenceMode, 'file');
  assert.throws(() => loadWebConfig({ ...env, STUDENT_PERSISTENCE_MODE: 'invalid' }), /STUDENT_PERSISTENCE_MODE/);
  assert.throws(() => loadWebConfig({ ...env, STUDENT_ACTIVITY_RETENTION_DAYS: '0' }), /RETENTION/);
  assert.throws(() => loadWebConfig({ ...env, STUDENT_PERSISTENCE_MODE: 'postgres' }), /PGDATABASE/);
});

test('student parser errors preserve safe 400/413 responses and malformed cookies fail closed', async () => {
  const web = await start();
  try {
    const malformed = await fetch(`${web.base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"private-value",bad' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid request body' });
    const large = await post(web.base, 'signup', { email: 'private@connect.hku.hk', password: 'p'.repeat(9000) });
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { error: 'request body too large' });
    const cookie = 'tm_session=%ZZ';
    assert.equal((await fetch(`${web.base}/api/me`, { headers: { cookie } })).status, 401);
    assert.equal(await rejectedSocket(web.base, cookie), 401);
    await web.activity?.flush();
    assert.deepEqual(web.events.map((event) => [event.action, event.outcome, event.userId]), [
      ['login', 'failed', null], ['signup', 'failed', null],
    ]);
    assert.ok(!JSON.stringify(web.events).includes('private'));
  } finally { await web.close(); }
});

test('rejected WebSocket upgrades release half-open client connections', async () => {
  for (const unavailable of [false, true]) {
    const web = await start({ unavailable });
    const address = web.server.address() as AddressInfo;
    const client = createConnection({ host: '127.0.0.1', port: address.port, allowHalfOpen: true });
    try {
      let response = '';
      client.on('data', (bytes: Buffer) => { response += bytes.toString(); });
      const cookie = unavailable ? `tm_session=${web.sessions.issue('known@connect.hku.hk')}` : '';
      const ended = new Promise<void>((resolve, reject) => { client.once('end', resolve); client.once('error', reject); });
      client.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`);
      await ended;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(response, unavailable ? /503 Service Unavailable/ : /401 Unauthorized/);
      const count = await new Promise<number>((resolve, reject) => web.server.getConnections((error, total) => error ? reject(error) : resolve(total)));
      assert.equal(count, 0);
    } finally { client.destroy(); await web.close(); }
  }
});

test('logout revokes access before a delayed account lookup completes', async () => {
  let release!: () => void;
  let markLookup!: () => void;
  const lookup = new Promise<void>(resolve => { markLookup = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const web = await start({ beforeGet: async () => { markLookup(); await gate; } });
  const user = await web.accounts.create('delayed@connect.hku.hk', 'Student', 'correct horse battery');
  const token = web.sessions.issue(user.email, Date.now(), studentSessionVersion(user));
  const logout = post(web.base, 'logout', {}, `tm_session=${token}`);
  try {
    await lookup;
    assert.equal(web.sessions.read(token), null, 'access ends while account storage is still pending');
    release();
    assert.equal((await logout).status, 200);
  } finally { release(); await logout; await web.close(); }
});
