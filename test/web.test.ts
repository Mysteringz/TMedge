/**
 * Claims about the web tier: who can see what, and what students are shown
 * when data goes stale.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { parseCookies, RateLimiter, Sessions, turnstileCheck, UserStore } from '../src/web/auth.js';
import { createWebApp, loadWebConfig, missingAppAssets, safeNext } from '../src/web/main.js';
import { isSnapshot, SnapshotStore } from '../src/web/store.js';
import { SnapshotPublishers } from '../src/web/publishers.js';
import { findGroup, searchSeats } from '../src/shared/seats.js';
import type { OccupancySnapshot, TableState } from '../src/shared/types.js';
import { makerspace } from './fixtures.js';

const TOKEN = 'edge-token-for-tests-0123456789';

test('web: publisher tokens cannot impersonate another edge or publish an unauthorized floor', async () => {
  const web = createWebApp({ port: 0, host: '127.0.0.1', pushToken: TOKEN,
    publishers: new SnapshotPublishers({ version: 1, edges: { 'edge-a': { token: '11'.repeat(32), floors: ['iw-maker-a'] }, 'edge-b': { token: '22'.repeat(32), floors: [] } } }),
    sessionSecret: Buffer.alloc(40, 1), usersPath: join(mkdtempSync(join(tmpdir(), 'publishers-')), 'users.json'),
    allowedDomains: [], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30000 });
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const push = (body: OccupancySnapshot, token: string) => fetch(`${base}/api/edge/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await push(snapshot('edge-a'), '11'.repeat(32))).status, 200);
    assert.equal((await push(snapshot('edge-b'), '11'.repeat(32))).status, 401);
    assert.equal((await push(snapshot('edge-b'), '22'.repeat(32))).status, 403);
    assert.equal((await push(snapshot('edge-a'), TOKEN)).status, 401);
  } finally { web.server.closeAllConnections(); await new Promise<void>(r => web.server.close(() => r())); }
});

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

test('web: a shell whose app bundle is missing is reported, not served blank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmweb-shell-'));
  try {
    assert.deepEqual(missingAppAssets(join(dir, 'nowhere')), ['index.html'], 'no shell at all');
    writeFileSync(join(dir, 'index.html'),
      '<script type="module" src="/app/index-abc123.js"></script>'
      + '<link rel="stylesheet" href="/app/index-abc123.css">'
      + '<link rel="icon" href="/favicon.svg">');
    // Only the bundle is build output; the tracked assets are not its business.
    assert.deepEqual(missingAppAssets(dir), ['/app/index-abc123.js', '/app/index-abc123.css']);
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'index-abc123.js'), '');
    writeFileSync(join(dir, 'app', 'index-abc123.css'), '');
    assert.deepEqual(missingAppAssets(dir), [], 'a built shell passes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: malformed credentials, cookies, origins and JSON are refused without crashing', async () => {
  const w = await start();
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(w.base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  try {
    for (const body of [[], null, { email: 3, password: 'long-password' }, { email: [], password: 'long-password' },
      { email: 'a@connect.hku.hk', password: {} }, { email: 'a@connect.hku.hk', password: 'x'.repeat(1025) },
      { email: 'a@connect.hku.hk', password: 'long-password', name: {} }]) {
      for (const path of ['/login', '/signup']) assert.equal((await post(path, body)).status, 400);
    }
    const account = { email: 'a@connect.hku.hk', password: 'long-password' };
    for (const origin of ['null', 'invalid-url', 'https://127.0.0.1:' + new URL(w.base).port]) {
      assert.equal((await post('/signup', account, { origin })).status, 403);
    }
    const validOrigin = await post('/signup', account, { origin: w.base });
    assert.equal(validOrigin.status, 200);
    assert.equal((await fetch(`${w.base}/api/me`, { headers: { cookie: 'tm_session=%E0%A4%A' } })).status, 401);
    assert.equal((await fetch(`${w.base}/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${w.base}/healthz`)).status, 200);
  } finally { await w.close(); }
});

test('web: async authentication failures produce an error response and leave the server running', async () => {
  const w = await start();
  try {
    w.users.verify = async () => { throw new Error('simulated authentication failure'); };
    const response = await fetch(`${w.base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@connect.hku.hk', password: 'long-password' }),
    });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('simulated authentication failure'));
    assert.equal((await fetch(`${w.base}/healthz`)).status, 200);
  } finally { await w.close(); }
});

test('web: redirects reject browser backslashes, normalization escapes and authentication loops', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/%2e%2e//evil.example', '/dashboard/../login/', '/auth/google']) {
    assert.equal(safeNext(value), '/dashboard/', value);
  }
  assert.equal(safeNext('/dashboard/spaces/iw-maker-a?seats=4#plan'), '/dashboard/spaces/iw-maker-a?seats=4#plan');
  assert.equal(safeNext({ next: '/dashboard/' }), '/dashboard/');
});

test('web: malformed cookies are ignored and duplicate names cannot override an earlier cookie', () => {
  const cookies = parseCookies('bad=%; tm_session=first; tm_session=second; __proto__=value; x=hello%20world');
  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies.bad, undefined);
  assert.equal(cookies.tm_session, 'first');
  assert.equal(cookies.__proto__, 'value');
  assert.equal(cookies.x, 'hello world');
});

test('web: unverified account registration is opt-in and numeric configuration fails closed', () => {
  const base = { WEB_PUSH_TOKEN: TOKEN, SESSION_SECRET: 's'.repeat(40) };
  assert.equal(loadWebConfig(base).signupOpen, false);
  assert.equal(loadWebConfig({ ...base, SIGNUP_OPEN: '1' }).signupOpen, true);
  for (const WEB_PORT of ['NaN', '-1', '65536', '1.5']) assert.throws(() => loadWebConfig({ ...base, WEB_PORT }), /WEB_PORT/);
  for (const STALE_MS of ['NaN', '-1', 'Infinity', '0']) assert.throws(() => loadWebConfig({ ...base, STALE_MS }), /STALE_MS/);
  assert.throws(() => loadWebConfig({ ...base, SIGNUP_OPEN: 'yes' }), /SIGNUP_OPEN/);
});

test('web: an address spray cannot erase existing login limits', () => {
  const limiter = new RateLimiter(1, 1000);
  assert.equal(limiter.allow('blocked', 0), true);
  assert.equal(limiter.allow('blocked', 0), false);
  for (let i = 0; i < 10_100; i++) limiter.allow('ip-' + i, 0);
  assert.equal(limiter.allow('blocked', 1), false);
  assert.equal(limiter.allow('fresh', 1000), true, 'expired entries can make space');
});

test('web: concurrent registrations cannot overwrite an account and corrupted files are never treated as empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmusers-'));
  const path = join(dir, 'users.json');
  try {
    const users = new UserStore(path, ['connect.hku.hk']);
    const attempts = await Promise.allSettled([
      users.create('same@connect.hku.hk', 'First', 'first-password'),
      users.create('same@connect.hku.hk', 'Second', 'second-password'),
    ]);
    assert.equal(attempts.filter((v) => v.status === 'fulfilled').length, 1);
    assert.equal(users.size, 1);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as unknown[]).length, 1);
    assert.equal(new UserStore(path, []).size, 1);
    for (const bad of ['{', '{}', '[{"email":"a@connect.hku.hk","hash":"invalid"}]']) {
      writeFileSync(path, bad);
      assert.throws(() => new UserStore(path, []));
      assert.equal(readFileSync(path, 'utf8'), bad);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('web: snapshot validation rejects missing fields, impossible counts and private debug data', async () => {
  assert.equal(isSnapshot(snapshot()), true);
  const changes: ((s: Record<string, unknown>) => void)[] = [
    (s) => { s.floors = [{ id: 'broken', tables: [], zones: [] }]; },
    (s) => { s.rawFrames = [{ pixels: [1, 2, 3] }]; },
    (s) => { (s.floors as Record<string, unknown>[])[0]!.building = 3; },
    (s) => { delete (s.floors as Record<string, unknown>[])[0]!.totals; },
    (s) => { const f = (s.floors as Record<string, unknown>[])[0]!; (f.tables as Record<string, unknown>[])[0]!.seats = null; },
    (s) => { const f = (s.floors as Record<string, unknown>[])[0]!; (f.totals as Record<string, unknown>).free = 1; },
    (s) => { const f = (s.floors as Record<string, unknown>[])[0]!; f.tables = [...f.tables as unknown[], (f.tables as unknown[])[0]]; },
  ];
  const w = await start();
  try {
    for (const change of changes) {
      const broken = structuredClone(snapshot()) as unknown as Record<string, unknown>;
      change(broken);
      assert.equal(isSnapshot(broken), false);
      assert.equal((await fetch(`${w.base}/api/edge/snapshot`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(broken),
      })).status, 400);
    }
    assert.equal(w.store.view().floors.length, 0);
    assert.equal((await fetch(`${w.base}/healthz`)).status, 200);
  } finally { await w.close(); }
});

test('web: a migrated floor is only counted once and edge identity storage is bounded', () => {
  const store = new SnapshotStore();
  assert.equal(store.put(snapshot('old'), 1000), true);
  assert.equal(store.put(snapshot('new'), 2000), true);
  const floors = store.view(3000).floors;
  assert.equal(floors.length, 1);
  assert.equal(floors[0]?.edgeId, 'new');
  for (let i = 2; i < 256; i++) assert.equal(store.put(snapshot('edge-' + i), 3000), true);
  assert.equal(store.put(snapshot('overflow'), 4000), false);
  assert.equal(store.put(snapshot('new'), 4000), true, 'existing edges still update');
});

test('web: logout revokes a copied cookie and session revocation survives restart', async () => {
  const w = await start();
  try {
    const cookie = await signup(w.base, 'logout@connect.hku.hk');
    assert.equal((await fetch(`${w.base}/api/me`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${w.base}/logout`, { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${w.base}/api/me`, { headers: { cookie } })).status, 401);
  } finally { await w.close(); }
  const dir = mkdtempSync(join(tmpdir(), 'tmsessions-'));
  try {
    const path = join(dir, 'revoked.json');
    const key = Buffer.from('k'.repeat(40));
    const first = new Sessions(key, 60_000, path);
    const other = new Sessions(key, 60_000, path);
    const token = first.issue('a@example.com');
    first.revoke(token);
    assert.equal(other.read(token), null, 'another instance reloads the revocation');
    assert.equal(new Sessions(key, 60_000, path).read(token), null, 'restart does not resurrect logout');
    assert.ok(first.read(first.issue('a@example.com')), 'new sessions are distinct even in the same millisecond');
    writeFileSync(path, 'broken');
    assert.equal(first.read(first.issue('a@example.com')), null, 'corrupt revocation data fails closed');
    assert.throws(() => new Sessions(key, 60_000, path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function refusedSocket(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      ws.terminate();
      resolve(status);
    });
    ws.on('open', () => { ws.terminate(); reject(new Error('expected rejected upgrade')); });
  });
}

test('web: WebSocket upgrades validate cookies and browser origins; logout and protocol errors close feeds safely', async () => {
  const w = await start();
  let ws: WebSocket | null = null;
  try {
    assert.equal(await refusedSocket(w.base, { cookie: 'tm_session=%' }), 401);
    const cookie = await signup(w.base, 'socket@connect.hku.hk');
    assert.equal(await refusedSocket(w.base, { cookie, origin: 'https://evil.example' }), 403);
    assert.equal(await refusedSocket(w.base, { cookie, origin: 'null' }), 403);
    ws = new WebSocket(w.base.replace(/^http/, 'ws') + '/ws', { headers: { cookie, origin: w.base } });
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => { ws!.once('message', () => resolve()); ws!.once('error', reject); });
    const closed = new Promise<void>((resolve) => ws!.once('close', () => resolve()));
    await fetch(`${w.base}/logout`, { method: 'POST', headers: { cookie } });
    await closed;
    assert.equal(await refusedSocket(w.base, { cookie, origin: w.base }), 401);
    const second = await signup(w.base, 'socket2@connect.hku.hk');
    ws = new WebSocket(w.base.replace(/^http/, 'ws') + '/ws', { headers: { cookie: second, origin: w.base } });
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => { ws!.once('message', () => resolve()); ws!.once('error', reject); });
    const invalidClosed = new Promise<void>((resolve) => ws!.once('close', () => resolve()));
    ws.send('x'.repeat(2048));
    await invalidClosed;
    assert.equal((await fetch(`${w.base}/healthz`)).status, 200);
  } finally { ws?.terminate(); await w.close(); }
});

test('web: personalized API responses and raw shell redirects are never cached', async () => {
  const w = await start();
  try {
    const cookie = await signup(w.base, 'cache@connect.hku.hk');
    for (const path of ['/api/me', '/api/occupancy', '/api/search?seats=1', '/index.html']) {
      const response = await fetch(w.base + path, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.match(response.headers.get('vary') ?? '', /(?:^|,\s*)Cookie(?:,|$)/, path);
    }
  } finally { await w.close(); }
});
