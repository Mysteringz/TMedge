import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { createWebApp } from '../src/web/main.js';
import { JsonStudentAccountRepository } from '../src/infrastructure/web/json-student-account-repository.js';
import { StudentActivityLog } from '../src/modules/student-auth/application/student-activity-log.js';
import type { StudentActivityEvent } from '../src/modules/student-auth/repositories/student-activity-repository.js';
import { makerspace } from './fixtures.js';

async function start(t: { after(fn: () => Promise<void>): void }, failActivity = false, fileMode = false) {
  const directory = mkdtempSync(join(tmpdir(), 'student-usage-'));
  const accounts = new JsonStudentAccountRepository(join(directory, 'users.json'), ['example.edu']);
  const user = await accounts.create('known@example.edu', 'Known', 'correct horse battery');
  const events: StudentActivityEvent[] = [];
  const activity = new StudentActivityLog({
    record: async (event) => { if (failActivity) throw new Error('private storage connection'); events.push(event); },
    prune: async () => 0,
  });
  const web = createWebApp({ port: 0, host: '127.0.0.1', pushToken: 'test-edge-token-long-enough',
    sessionSecret: Buffer.from('s'.repeat(40)), usersPath: 'unused.json', allowedDomains: ['example.edu'],
    signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000, studentPersistenceMode: fileMode ? 'file' : 'postgres',
  }, { accounts, ...(fileMode ? {} : { activity }) });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await web.dispose();
    await activity.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const cookie = `tm_session=${web.sessions.issue(user.email)}`;
  const snapshot = new OccupancyEngine(makerspace(), 'usage-test').snapshot(Date.now());
  snapshot.floors = snapshot.floors.filter((floor) => floor.id === 'iw-maker-a');
  const floor = snapshot.floors[0]!;
  const table = floor.tables[0]!;
  Object.assign(table, { status: 'ok', occupied: 0, free: table.capacity,
    seats: table.seats.map((seat) => ({ ...seat, occupied: false })) });
  web.store.put(snapshot);
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/activity`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-tm-student-activity': '1', ...headers },
    body: JSON.stringify(body),
  });
  return { ...web, activity, accounts, base, cookie, user, events, post, snapshot, floor, table };
}

test('student usage is attributed to the verified account with bounded server-derived context', async (t) => {
  const web = await start(t);
  for (const input of [
    { action: 'seat-search', seats: 2, venueId: 'twf' },
    { action: 'space-view', seats: 2, floorId: web.floor.id },
    { action: 'table-select', seats: 2, floorId: web.floor.id, tableId: web.table.id },
    { action: 'directions-view', seats: 2, floorId: web.floor.id, tableId: web.table.id },
  ]) assert.equal((await web.post(input)).status, 202);
  await web.activity.flush();
  assert.equal(web.events.length, 4);
  assert.ok(web.events.every((event) => event.userId === web.user.id && event.outcome === 'succeeded'));
  assert.equal(new Set(web.events.map((event) => event.requestId)).size, 4);
  assert.deepEqual(web.events[0]?.details, { seats: 2, venueId: 'twf', resultCount: 1, liveData: true });
  assert.deepEqual(web.events[2]?.details, { seats: 2, floorId: web.floor.id, tableId: web.table.id, liveData: true });
  assert.ok(!JSON.stringify(web.events).includes(web.user.email));
});

test('usage rejects forged actors, arbitrary details, unknown campus targets and cross-origin posts', async (t) => {
  const web = await start(t);
  const valid = { action: 'seat-search', seats: 2, floorId: web.floor.id };
  for (const input of [
    { ...valid, userId: randomUUID() }, { ...valid, outcome: 'succeeded' }, { ...valid, resultCount: 10 },
    { ...valid, password: 'secret' }, { ...valid, seats: 31 }, { ...valid, seats: '2' },
    { ...valid, floorId: 'missing' }, { ...valid, venueId: 'twf' },
    { action: 'table-select', seats: 2, floorId: web.floor.id, tableId: 'missing' },
    { action: 'login', seats: 2 }, null, [],
  ]) assert.equal((await web.post(input)).status, 400);
  assert.equal((await web.post(valid, { cookie: '' })).status, 401);
  assert.equal((await web.post(valid, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await web.post(valid, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await web.post(valid, { 'x-tm-student-activity': '' })).status, 403);
  assert.equal((await web.post(valid, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await web.post({ ...valid, padding: 'x'.repeat(3000) })).status, 413);
  const malformed = await fetch(`${web.base}/api/activity`, { method: 'POST', headers: {
    cookie: web.cookie, 'content-type': 'application/json', 'x-tm-student-activity': '1',
  }, body: '{broken' });
  assert.equal(malformed.status, 400);
  await web.activity.flush();
  assert.deepEqual(web.events, []);
});

test('legacy search logs one valid call, omits unknown floor text, and ignores malformed searches', async (t) => {
  const web = await start(t);
  const headers = { cookie: web.cookie };
  const result = await fetch(`${web.base}/api/search?seats=2&floor=${web.floor.id}`, { headers });
  assert.equal(result.status, 200);
  const body = await result.json() as { seats: number; results: unknown[] };
  assert.equal(body.results.length, 1);
  assert.equal((await fetch(`${web.base}/api/search?seats=31`, { headers })).status, 400);
  assert.equal((await fetch(`${web.base}/api/search?seats=2`)).status, 401);
  assert.equal((await fetch(`${web.base}/api/search?seats=2&floor=private%40example.edu`, { headers })).status, 200);
  await web.activity.flush();
  assert.equal(web.events.length, 2);
  assert.deepEqual(web.events[0]?.details, { seats: 2, resultCount: 1, liveData: true, floorId: web.floor.id });
  assert.deepEqual(web.events[1]?.details, { seats: 2, resultCount: 0, liveData: false });
  assert.ok(!JSON.stringify(web.events).includes('private@example.edu'));
});

test('search context records stale data and dynamically published other venues', async (t) => {
  const web = await start(t);
  web.store.put(web.snapshot, Date.now() - 31_000);
  assert.equal((await web.post({ action: 'seat-search', seats: 2, venueId: 'twf' })).status, 202);
  const other = structuredClone(web.snapshot);
  other.edgeId = 'dynamic-edge';
  other.floors[0]!.id = 'dynamic-room';
  web.store.put(other);
  assert.equal((await web.post({ action: 'seat-search', seats: 2, venueId: 'other' })).status, 202);
  await web.activity.flush();
  assert.deepEqual(web.events[0]?.details, { seats: 2, venueId: 'twf', liveData: false, resultCount: 0 });
  assert.deepEqual(web.events[1]?.details, { seats: 2, venueId: 'other', liveData: true, resultCount: 1 });
});

test('occupancy polling, me checks and WebSocket updates do not count as student interactions', async (t) => {
  const web = await start(t);
  for (let index = 0; index < 3; index++) {
    assert.equal((await fetch(`${web.base}/api/occupancy`, { headers: { cookie: web.cookie } })).status, 200);
    assert.equal((await fetch(`${web.base}/api/me`, { headers: { cookie: web.cookie } })).status, 200);
  }
  const socket = new WebSocket(web.base.replace('http:', 'ws:') + '/ws', { headers: { cookie: web.cookie } });
  await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
  socket.terminate();
  await web.activity.flush();
  assert.deepEqual(web.events, []);
});

test('activity outage leaves student actions usable', async (t) => {
  const web = await start(t, true);
  assert.equal((await web.post({ action: 'seat-search', seats: 2 })).status, 202);
  assert.equal((await fetch(`${web.base}/api/search?seats=2`, { headers: { cookie: web.cookie } })).status, 200);
  await web.activity.flush();
  assert.equal(web.activity.stats().failedWrites, 2);
  const ready = await fetch(`${web.base}/readyz`);
  assert.equal(ready.status, 200);
  assert.ok(!JSON.stringify(await ready.json()).includes('private storage'));
});

test('file mode supports the new browser requests without implicit database activity', async (t) => {
  const web = await start(t, false, true);
  assert.equal((await web.post({ action: 'seat-search', seats: 2, venueId: 'twf' })).status, 202);
  assert.equal((await fetch(`${web.base}/api/search?seats=2`, { headers: { cookie: web.cookie } })).status, 200);
  await web.activity.flush();
  assert.deepEqual(web.events, []);
});

test('activity details are allowlisted and copied before queuing, and usage posts are rate bounded', async (t) => {
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const events: StudentActivityEvent[] = [];
  const log = new StudentActivityLog({ record: async (event) => { await blocked; events.push(event); }, prune: async () => 0 });
  const details = { seats: 2, floorId: 'iw-maker-a', password: 'private-password', cookie: 'private-cookie' };
  log.record('login', 'succeeded', null, randomUUID());
  log.record('seat-search', 'succeeded', randomUUID(), randomUUID(), details);
  details.seats = 30;
  details.floorId = 'other-floor';
  release();
  await log.flush();
  assert.deepEqual(events[1]?.details, { seats: 2, floorId: 'iw-maker-a' });
  assert.ok(!JSON.stringify(events).includes('private-'));
  await log.dispose();
  const web = await start(t);
  for (let index = 0; index < 120; index++) assert.equal((await web.post({ action: 'seat-search', seats: 2 })).status, 202);
  assert.equal((await web.post({ action: 'seat-search', seats: 2 })).status, 429);
  await web.activity.flush();
  assert.equal(web.events.length, 120);
});
