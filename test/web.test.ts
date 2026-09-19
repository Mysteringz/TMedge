/**
 * Claims about the web tier: who can see what, and what students are shown
 * when data goes stale.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { Sessions } from '../src/web/auth.js';
import { createWebApp } from '../src/web/main.js';
import { SnapshotStore } from '../src/web/store.js';
import { findGroup, searchSeats } from '../src/shared/seats.js';
import type { OccupancySnapshot, TableState } from '../src/shared/types.js';
import { makerspace } from './fixtures.js';

const TOKEN = 'edge-token-for-tests-0123456789';

async function start() {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  return { ...web, base, close: () => new Promise<void>((r) => web.server.close(() => r())) };
}

/** What an edge publishes: public floors only (see EdgeRuntime.publicSnapshot). */
function snapshot(edgeId = 'edge-a'): OccupancySnapshot {
  const s = new OccupancyEngine(makerspace(), edgeId).snapshot(Date.now());
  return { ...s, floors: s.floors.filter((f) => f.id === 'iw-maker-a') };
}

async function signup(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/signup`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, name: 'Test', password: 'correct horse battery' }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

test('web: occupancy is only served to signed-in students', async () => {
  const w = await start();
  try {
    assert.equal((await fetch(`${w.base}/api/occupancy`)).status, 401);
    assert.equal((await fetch(`${w.base}/`, { redirect: 'manual' })).headers.get('location'), '/login');
    const cookie = await signup(w.base, 'a@connect.hku.hk');
    assert.ok(cookie.startsWith('tm_session='));
    assert.equal((await fetch(`${w.base}/api/occupancy`, { headers: { cookie } })).status, 200);
    // A forged or tampered session is refused.
    assert.equal((await fetch(`${w.base}/api/occupancy`, { headers: { cookie: cookie.slice(0, -2) + 'xx' } })).status, 401);
  } finally {
    await w.close();
  }
});

test('web: sign-up is limited to university addresses and strong-enough passwords', async () => {
  const w = await start();
  try {
    assert.equal(await signup(w.base, 'someone@gmail.com'), '');
    const weak = await fetch(`${w.base}/signup`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'b@connect.hku.hk', password: 'short' }),
    });
    assert.equal(weak.status, 400);
    // Wrong password gets the same answer as an unknown email.
    await signup(w.base, 'c@connect.hku.hk');
    const bad = await fetch(`${w.base}/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'c@connect.hku.hk', password: 'wrong password!!' }),
    });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /do not match/);
  } finally {
    await w.close();
  }
});

test('web: read-only for students -- only an edge with the token can change what others see', async () => {
  const w = await start();
  try {
    const cookie = await signup(w.base, 'd@connect.hku.hk');
    const body = JSON.stringify(snapshot());
    const asStudent = await fetch(`${w.base}/api/edge/snapshot`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    assert.equal(asStudent.status, 401);
    const wrong = await fetch(`${w.base}/api/edge/snapshot`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body });
    assert.equal(wrong.status, 401);
    const junk = await fetch(`${w.base}/api/edge/snapshot`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"hello":1}' });
    assert.equal(junk.status, 400);
    const ok = await fetch(`${w.base}/api/edge/snapshot`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body });
    assert.equal(ok.status, 200);
    const view = (await (await fetch(`${w.base}/api/occupancy`, { headers: { cookie } })).json()) as { floors: unknown[] };
    assert.equal(view.floors.length, 1);
  } finally {
    await w.close();
  }
});

test('web: a cross-site form post to log in is refused', async () => {
  const w = await start();
  try {
    const res = await fetch(`${w.base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: new URLSearchParams({ email: 'x@connect.hku.hk', password: 'whatever-long' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await w.close();
  }
});

test('web: an edge that goes quiet turns its whole floor unknown, not "last known"', () => {
  const store = new SnapshotStore(30_000);
  const snap = snapshot();
  const t0 = 1_000_000;
  // Make one table known and free.
  const f = snap.floors[0]!;
  const t = f.tables[0]!;
  Object.assign(t, { status: 'ok', occupied: 0, free: 6, seats: t.seats.map((s) => ({ ...s, occupied: false })) });
  store.put(snap, t0);
  assert.equal(store.view(t0 + 1000).floors[0]?.tables[0]?.free, 6);
  const later = store.view(t0 + 31_000).floors[0]!;
  assert.equal(later.stale, true);
  assert.ok(later.tables.every((x) => x.status === 'unknown' && x.free === null && x.seats.every((s) => s.occupied === null)));
  assert.equal(later.totals.free, 0);
  assert.equal(later.totals.unknownSeats, 60);
});

test('web: sessions expire', () => {
  const s = new Sessions(Buffer.from('k'.repeat(40)), 1000);
  const tok = s.issue('e@connect.hku.hk', 0);
  assert.equal(s.read(tok, 500), 'e@connect.hku.hk');
  assert.equal(s.read(tok, 1500), null);
});

// --- seat search --------------------------------------------------------------------

function tableWith(free: string[]): TableState {
  const t = snapshot().floors[0]!.tables.find((x) => x.id === 'M3')!;
  return { ...t, status: 'ok', occupied: 6 - free.length, free: free.length, seats: t.seats.map((s) => ({ ...s, occupied: !free.includes(s.id) })) };
}

test('search: two free seats at opposite ends of a table are not "together"', () => {
  assert.equal(findGroup(tableWith(['M3-L1', 'M3-R3']), 2), null);
  assert.deepEqual(findGroup(tableWith(['M3-L1', 'M3-L2']), 2)?.sort(), ['M3-L1', 'M3-L2']);
  assert.deepEqual(findGroup(tableWith(['M3-L3', 'M3-R3']), 2)?.sort(), ['M3-L3', 'M3-R3']);   // across the table
});

test('search: a group of three prefers one side over spreading across', () => {
  const g = findGroup(tableWith(['M3-L1', 'M3-L2', 'M3-L3', 'M3-R1']), 3);
  assert.deepEqual(g?.sort(), ['M3-L1', 'M3-L2', 'M3-L3']);
});

test('search: unknown tables are never suggested, and quieter tables come first', () => {
  const snap = snapshot();
  const floor = snap.floors[0]!;
  floor.tables = floor.tables.map((t) => {
    const n = t.id === 'M1' ? 0 : t.id === 'M2' ? 4 : t.id === 'M4' ? 1 : 6;  // free seats
    const status = t.id === 'M5' ? 'unknown' : 'ok';
    return { ...t, status, occupied: status === 'unknown' ? null : 6 - n, free: status === 'unknown' ? null : n,
      seats: t.seats.map((s, i) => ({ ...s, occupied: status === 'unknown' ? null : i >= n })) } as TableState;
  });
  const results = searchSeats(snap.floors, 2);
  assert.ok(!results.some((r) => r.tableIds.includes('M5')));
  assert.ok(!results.some((r) => r.tableIds.includes('M1')));
  assert.equal(results[0]?.busyness, 0);
  assert.ok(results.findIndex((r) => r.tableIds[0] === 'M2') < results.findIndex((r) => r.tableIds[0] === 'M4') || !results.some((r) => r.tableIds[0] === 'M4'));
});

test('search: a group bigger than any table is offered two neighbouring tables', () => {
  const snap = snapshot();
  const floor = snap.floors[0]!;
  floor.tables = floor.tables.map((t) => ({ ...t, status: 'ok', occupied: 0, free: 6, seats: t.seats.map((s) => ({ ...s, occupied: false })) }) as TableState);
  const results = searchSeats(snap.floors, 8);
  assert.ok(results.length > 0 && results.every((r) => r.tableIds.length === 2 && r.seatIds.length === 8));
});

test('web behind Cloudflare Tunnel: the session cookie is Secure over https, and X-Forwarded-* is trusted only from the local proxy', async () => {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: true, staleMs: 30_000,
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const signupVia = (headers: Record<string, string>, email: string) => fetch(`${base}/signup`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ email, name: 'T', password: 'correct horse battery' }),
  });
  try {
    const viaTunnel = await signupVia({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }, 'p@connect.hku.hk');
    assert.match(viaTunnel.headers.get('set-cookie') ?? '', /;\s*Secure/i, 'https via the local proxy -> Secure');
    const onLan = await signupVia({}, 'q@connect.hku.hk');
    assert.doesNotMatch(onLan.headers.get('set-cookie') ?? '', /;\s*Secure/i, 'plain http on the LAN still works');
  } finally {
    await new Promise<void>((r) => web.server.close(() => r()));
  }
});
