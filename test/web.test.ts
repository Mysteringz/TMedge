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
import { Sessions, turnstileCheck } from '../src/web/auth.js';
import { createWebApp, loadWebConfig } from '../src/web/main.js';
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
    assert.equal((await fetch(`${w.base}/`, { redirect: 'manual' })).headers.get('location'), '/login/');
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

test('with Turnstile on, sign-in and sign-up need a token Cloudflare accepted for that form', async () => {
  const seen: { token: string; action: string }[] = [];
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
    turnstile: {
      siteKey: '0x4AAAAAAA-test-site', secretKey: 'secret-never-sent-to-browser', hostnames: ['hkumyseat.com'],
      // Stands in for siteverify: a token is good only for the form it was solved on.
      check: async (token, action) => { seen.push({ token, action }); return token === `ok-${action}`; },
    },
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const post = (path: string, body: Record<string, string>) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const account = { email: 'u3587219', name: 'T', password: 'a-long-enough-pin' };
  try {
    // The browser gets the public key and a CSP that lets Cloudflare's widget load -- never the secret.
    const page = await fetch(`${base}/login/`);
    const html = await page.text();
    assert.match(html, /<meta name="turnstile" content="0x4AAAAAAA-test-site">/);
    assert.ok(!html.includes('secret-never-sent-to-browser'));
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' https:\/\/challenges\.cloudflare\.com/);

    assert.equal((await post('/signup', account)).status, 403, 'no token, no account');
    assert.equal((await post('/signup', { ...account, 'cf-turnstile-response': 'ok-login' })).status, 403, 'a sign-in token does not open sign-up');
    assert.equal(web.users.size, 0);
    assert.equal((await post('/signup', { ...account, 'cf-turnstile-response': 'ok-signup' })).status, 200);

    assert.equal((await post('/login', { email: account.email, password: account.password })).status, 403);
    assert.equal((await post('/login', { email: account.email, password: account.password, 'cf-turnstile-response': 'forged' })).status, 403);
    const ok = await post('/login', { email: account.email, password: account.password, 'cf-turnstile-response': 'ok-login' });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get('set-cookie')?.startsWith('tm_session='));

    // The limiter still runs first: a flood past it never costs a call to Cloudflare.
    const before = seen.length;
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await post('/login', { email: account.email, password: 'x', 'cf-turnstile-response': 'ok-login' })).status === 429) limited++;
    assert.ok(limited > 0);
    assert.equal(seen.length - before, 12 - limited, 'refused-by-limiter requests are not verified');
  } finally {
    await new Promise<void>((r) => web.server.close(() => r()));
  }
});

test('with Turnstile off, the shell carries no key and nothing may be framed in', async () => {
  const w = await start();
  try {
    const page = await fetch(`${w.base}/login/`);
    assert.match(await page.text(), /<meta name="turnstile" content="">/);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.ok(!csp.includes('cloudflare'));
    assert.match(csp, /frame-src 'none'/);
  } finally {
    await w.close();
  }
});

test('Turnstile config is both keys or neither', () => {
  const base = { WEB_PUSH_TOKEN: TOKEN, SESSION_SECRET: 's'.repeat(40) };
  assert.equal(loadWebConfig(base).turnstile, null);
  assert.throws(() => loadWebConfig({ ...base, TURNSTILE_SITE_KEY: '0x4AAAAAAAtest' }), /together/);
  assert.throws(() => loadWebConfig({ ...base, TURNSTILE_SECRET_KEY: 'x' }), /together/);
  const keys = { TURNSTILE_SITE_KEY: '0x4AAAAAAAtest', TURNSTILE_SECRET_KEY: 'x' };
  assert.throws(() => loadWebConfig({ ...base, ...keys, TURNSTILE_SITE_KEY: '"><script>', TURNSTILE_HOSTNAMES: 'hkumyseat.com' }), /site key/);
  assert.throws(() => loadWebConfig({ ...base, ...keys }), /TURNSTILE_HOSTNAMES/, 'no hostnames would refuse every student');
  const on = loadWebConfig({ ...base, ...keys, TURNSTILE_HOSTNAMES: 'hkumyseat.com, WWW.hkumyseat.com' }).turnstile;
  assert.equal(on?.siteKey, '0x4AAAAAAAtest');
  assert.deepEqual(on?.hostnames, ['hkumyseat.com', 'www.hkumyseat.com']);
});

test('turnstileCheck: only success for the same action on our own hostname passes, and an outage fails closed', async () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const check = (body: unknown, status = 200) => turnstileCheck('k', ['hkumyseat.com'], reply(body, status), () => {});
  const good = { success: true, action: 'login', hostname: 'hkumyseat.com' };
  assert.equal(await check(good)('t', 'login', '1.2.3.4'), true);
  assert.equal(await check({ ...good, action: 'signup' })('t', 'login', undefined), false, 'solved on another form');
  assert.equal(await check({ ...good, hostname: 'evil.example' })('t', 'login', undefined), false, 'our public site key embedded elsewhere');
  assert.equal(await check({ ...good, success: false })('t', 'login', undefined), false);
  assert.equal(await check({}, 500)('t', 'login', undefined), false);
  assert.equal(await check({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } })('t', 'login', undefined), true, "Cloudflare's dummy keys work locally");
  assert.equal(await check({ success: true, hostname: 'hkumyseat.com' })('t', 'login', undefined), false, 'a real reply with no action does not');
  assert.equal(await turnstileCheck('k', [], reply(good), () => {})('t', 'login', undefined), false, 'no allowlist, no pass');
  // The refusal that actually happened in production: the token is fine, the
  // allowlist names a host the site is not served on. The log must say so.
  const said: string[] = [];
  const wrongHost = turnstileCheck('k', ['www.hkumyseat.com'], reply(good), (m) => said.push(m));
  assert.equal(await wrongHost('secret-token-value', 'login', undefined), false);
  assert.match(said[0] ?? '', /login: token was solved on "hkumyseat.com", TURNSTILE_HOSTNAMES allows www.hkumyseat.com/);
  await turnstileCheck('k', ['hkumyseat.com'], reply({ success: false, 'error-codes': ['invalid-input-secret'] }), (m) => said.push(m))('t', 'login', undefined);
  assert.match(said[1] ?? '', /invalid-input-secret/);
  assert.ok(!said.join('\n').includes('secret-token-value'));
  const down = (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;
  assert.equal(await turnstileCheck('k', ['hkumyseat.com'], down, () => {})('t', 'login', undefined), false);
  assert.equal(await check(good)('', 'login', undefined), false);
});
