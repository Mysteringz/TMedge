/**
 * Claims about the debug console living inside the algo console (module 03).
 *
 * The console a person uses moved behind the algo console's sign-in, at
 * /console-app/, with one set of state shared with CONSOLE_PORT. What did not
 * move is what devices call -- the rig's RGB uploads, firmware downloads and
 * TMflash -- because those callers hold their own credentials and already
 * know the console port's address.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import type { Request } from 'express';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { consoleMovedTo, createConsole, startConsole, stopConsole } from '../src/edge/console.js';
import { buildRegistry } from '../src/edge/registry.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DeviceKeys } from '../src/edge/secure.js';
import { KEY, identity, report, nodesJson, siteJson } from './fixtures.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tmedge-algoconsole-'));

function runtime() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tmedge-'));
  const nodesPath = join(dataDir, 'nodes.json');
  writeFileSync(nodesPath, JSON.stringify(nodesJson()));
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath, dataDir, recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

test('adoption tokens cross the machine gate but never the human approval gate; reports verify only after admission', async () => {
  const { rt, algoBase, cookie } = await boot();
  const uid = '30:ed:a0:11:22:33';
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(algoBase + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const admin = { cookie, 'x-tm-algo': '1' };
  assert.equal((await fetch(algoBase + '/api/adoption')).status, 401);
  assert.equal((await fetch(algoBase + '/adoption', { redirect: 'manual' })).status, 302);
  assert.equal((await post('/api/adoption/tokens', { label: 'Bench', hours: 24 }, { cookie })).status, 403);
  const issued = await post('/api/adoption/tokens', { label: 'Bench', hours: 24 }, admin);
  assert.equal(issued.status, 201);
  const credential = await issued.json() as { id: string; token: string };
  const machine = { authorization: `Bearer ${credential.token}` };
  const stateResponse = await fetch(algoBase + '/api/adoption', { headers: { cookie } });
  const stateText = await stateResponse.text();
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  assert.ok(!stateText.includes(credential.token) && !stateText.includes('digest'));
  assert.ok(!readFileSync(join(rt.cfg.dataDir, 'flasher-credentials.json'), 'utf8').includes(credential.token));
  assert.equal((await fetch(algoBase + '/api/provision/preflight')).status, 401);
  const preflight = await fetch(algoBase + '/api/provision/preflight', { headers: machine });
  assert.deepEqual(await preflight.json(), { protocol: 'tmflash.adoption.v1', ready: true, approval: 'human' });
  assert.equal((await fetch(algoBase + '/api/adoption', { headers: machine })).status, 401);
  const queued = await post('/api/provision/request', { uid, label: 'Physical bench', firmware: '1.6' }, machine);
  assert.equal(queued.status, 202);
  const pending = await queued.json() as { id: string; pairingCode: string };
  assert.match(pending.pairingCode, /^[0-9A-F]{8}$/);
  const approvalPath = `/api/adoption/requests/${pending.id}/approve`;
  const confirmation = { uid, pairingCode: pending.pairingCode };
  assert.equal((await post(approvalPath, confirmation, { ...machine, 'x-tm-algo': '1' })).status, 401);
  assert.equal((await post(approvalPath, { uid, pairingCode: 'WRONG' }, admin)).status, 400);
  assert.equal(rt.reg.nodes.has(uid), false);
  assert.equal((await post(approvalPath, confirmation, admin)).status, 200);
  assert.equal(rt.reg.nodes.get(uid)?.floorId, null);
  assert.ok(readFileSync(rt.cfg.nodesPath, 'utf8').includes(uid));
  assert.ok(readFileSync(join(rt.cfg.dataDir, 'provisioning.jsonl'), 'utf8').includes('algo:alice'));
  const devices = async () => (await (await fetch(algoBase + '/api/adoption', { headers: { cookie } })).json() as { nodes: { uid: string; verified: boolean }[] }).nodes;
  assert.equal((await devices()).find(node => node.uid === uid)?.verified, false, 'approval is not proof of successful telemetry');
  const signed = report(identity(uid), [], 1);
  rt.ingest.handle(signed, { kind: 'udp', address: '127.0.0.1' });
  assert.equal((await devices()).find(node => node.uid === uid)?.verified, true, 'a signed accepted report closes the loop');
  assert.equal((await post(`/api/adoption/tokens/${credential.id}/revoke`, {}, admin)).status, 200);
  assert.equal((await fetch(algoBase + '/api/provision/preflight', { headers: machine })).status, 401);
});

test('TMflash account sign-in needs browser consent and PKCE; its code is one-use and logout revokes access', async () => {
  const { algoBase, cookie } = await boot();
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(algoBase + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const authBody = { challenge, state };
  assert.equal((await post('/api/tmflash/authorize', authBody, { 'x-tm-algo': '1' })).status, 401);
  assert.equal((await post('/api/tmflash/authorize', authBody, { cookie })).status, 403);
  assert.equal((await post('/api/tmflash/authorize', { ...authBody, challenge: 'bad' }, { cookie, 'x-tm-algo': '1' })).status, 400);
  const consent = await post('/api/tmflash/authorize', authBody, { cookie, 'x-tm-algo': '1' });
  assert.equal(consent.status, 200);
  const callback = new URL((await consent.json() as { redirect: string }).redirect);
  assert.equal(callback.origin, 'null');
  assert.equal(callback.protocol, 'hk.hkumyseat.tmflash:');
  assert.equal(callback.host, 'login');
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.equal((await post('/api/tmflash/exchange', { code, verifier: randomBytes(32).toString('base64url') })).status, 401, 'an intercepted callback cannot authorize another Mac');
  const exchange = await post('/api/tmflash/exchange', { code, verifier });
  assert.equal(exchange.status, 201);
  const session = await exchange.json() as { token: string; user: string; expiresAt: number };
  assert.equal(session.user, 'alice');
  assert.ok(session.expiresAt > Date.now() + 23 * 3600_000 && session.expiresAt <= Date.now() + 24 * 3600_000);
  assert.equal((await post('/api/tmflash/exchange', { code, verifier })).status, 401, 'a code cannot create two sessions');
  const machine = { authorization: `Bearer ${session.token}` };
  assert.equal((await fetch(algoBase + '/api/provision/preflight', { headers: machine })).status, 200);
  assert.equal((await fetch(algoBase + '/console-app/api/state', { headers: machine })).status, 401, 'native access cannot read thermal imagery');
  assert.equal((await post('/api/tmflash/logout', {}, machine)).status, 204);
  assert.equal((await fetch(algoBase + '/api/provision/preflight', { headers: machine })).status, 401);
});

test('password changes and account removal invalidate native sessions and pending login codes immediately', async () => {
  const { algoBase, cookie, usersPath } = await boot();
  const users = new AlgoUsers(usersPath);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(algoBase + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const grant = async (browserCookie: string) => {
    const verifier = randomBytes(32).toString('base64url');
    const consent = await post('/api/tmflash/authorize', { challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') }, { cookie: browserCookie, 'x-tm-algo': '1' });
    assert.equal(consent.status, 200);
    return { code: new URL((await consent.json() as { redirect: string }).redirect).searchParams.get('code'), verifier };
  };
  const session = await (await post('/api/tmflash/exchange', await grant(cookie))).json() as { token: string };
  const pending = await grant(cookie);
  await users.add('alice', 'a changed account password');
  assert.equal((await fetch(algoBase + '/api/provision/preflight', { headers: { authorization: `Bearer ${session.token}` } })).status, 401);
  assert.equal((await post('/api/tmflash/exchange', pending)).status, 401);
  const login = await post('/auth/login', { username: 'alice', password: 'a changed account password' });
  const newCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const nextSession = await (await post('/api/tmflash/exchange', await grant(newCookie))).json() as { token: string };
  const nextPending = await grant(newCookie);
  assert.equal(users.remove('alice'), true);
  assert.equal((await fetch(algoBase + '/api/provision/preflight', { headers: { authorization: `Bearer ${nextSession.token}` } })).status, 401);
  assert.equal((await post('/api/tmflash/exchange', nextPending)).status, 401);
});

test('both adoption consoles require an enrolled telemetry key before admitting a secure-policy device', async () => {
  const { rt, algoBase, cookie } = await boot();
  rt.cfg.devices = new DeviceKeys({ version: 2, nodes: {} });
  const uid = '30:ed:a0:11:22:44';
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(algoBase + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const admin = { cookie, 'x-tm-algo': '1' };
  const issued = await (await post('/api/adoption/tokens', { label: 'Test Mac', hours: 24 }, admin)).json() as { token: string };
  const request = await (await post('/api/provision/request', { uid }, { authorization: `Bearer ${issued.token}` })).json() as { id: string; pairingCode: string };
  const confirm = { uid, pairingCode: request.pairingCode };
  assert.equal((await post(`/api/adoption/requests/${request.id}/approve`, confirm, admin)).status, 409);
  assert.equal((await post(`/console-app/api/provision/requests/${request.id}/approve`, confirm, { cookie, 'x-tm-console': '1' })).status, 409);
  assert.equal(rt.reg.nodes.has(uid), false);
  rt.cfg.devices = new DeviceKeys({ version: 2, nodes: { [uid]: { current: { id: 7, secret: '11'.repeat(32) } } } });
  assert.equal((await post(`/api/adoption/requests/${request.id}/approve`, confirm, admin)).status, 200);
});

const running: (() => Promise<void>)[] = [];
after(async () => { for (const stop of running) await stop(); });

const listening = (s: import('node:http').Server) =>
  new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    if (s.listening) done(); else s.once('listening', done);
  });

/** The edge as main.ts wires it: one console core, served by both ports. */
async function boot() {
  const usersPath = join(mkdtempSync(join(tmpdir(), 'tmedge-algousers-')), 'users.json');
  await new AlgoUsers(usersPath).add('alice', 'correct horse battery');
  const rt = runtime();
  const core = createConsole(rt);
  const consoleServer = startConsole(rt, core, { uiMovedTo: consoleMovedTo(8091) });
  const handle = startAlgo(rt, 0, '127.0.0.1',
    loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'admin-pass'), core);
  const { server } = handle;
  const [consoleBase, algoBase] = await Promise.all([listening(consoleServer), listening(server)]);
  running.push(async () => {
    await Promise.all([stopConsole(consoleServer), handle.dispose()]);
    await Promise.all([new Promise<void>(resolve => consoleServer.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
    await rt.stop();
  });
  const login = await fetch(`${algoBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { rt, consoleBase, algoBase, cookie, usersPath };
}

test('signed out, the console inside the algo console is as closed as the rest of it', async () => {
  const { algoBase } = await boot();
  const api = await fetch(`${algoBase}/console-app/api/state`);
  assert.equal(api.status, 401, 'an API answers 401, not a login page it cannot parse');
  assert.equal(api.headers.get('www-authenticate'), null, 'and never asks the browser for a password');
  const page = await fetch(`${algoBase}/console-app/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location') ?? '', /^\/login\?next=/);
});

test('signed in, the console page, its API and its live feed all work under /console-app/', async () => {
  const { rt, algoBase, cookie } = await boot();
  const headers = { cookie };
  assert.equal((await fetch(`${algoBase}/console-app`, { headers, redirect: 'manual' })).headers.get('location'), '/console-app/',
    'the trailing slash its relative URLs need');
  const page = await fetch(`${algoBase}/console-app/`, { headers });
  assert.equal(page.status, 200, 'npm test compiles the console client before serving it');
  const html = await page.text();
  assert.ok(!html.includes('id="firmware"'), 'OTA belongs to module 04, not the embedded debug page');
  assert.ok(html.includes('id="fusion"') && html.includes('id="controls"'), 'debug views and node commands remain');
  assert.ok(html.includes('<html lang="en" data-theme="dark">'), 'inside the dark algo console the frame is dark too');
  // The page itself only exists after a build; the headers are the claim here.
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'self'/, 'only the algo console may frame it');
  assert.match(csp, /img-src 'self' data: blob:/, 'rig RGB is drawn from blob: URLs');
  assert.match((await fetch(`${algoBase}/login`)).headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/,
    'everything else still refuses to be framed');

  const state = await fetch(`${algoBase}/console-app/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.ok('nodes' in ((await state.json()) as object));

  const { token } = (await (await fetch(`${algoBase}/console-app/api/ws-token`, { headers })).json()) as { token: string };
  const ws = new WebSocket(`${algoBase.replace('http', 'ws')}/console-app/ws?token=${encodeURIComponent(token)}`, { headers: { cookie } });
  const seen: { type: string; uid?: string }[] = [];
  ws.addEventListener('message', (e) => seen.push(JSON.parse(String(e.data)) as { type: string; uid?: string }));
  await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }));
  try {
    const uid = [...rt.reg.nodes.keys()][0] ?? '';
    ws.send(JSON.stringify({ type: 'subscribe', uids: [uid] }));
    // The subscription has no acknowledgement, and a slow CI runner can take
    // longer than any fixed pause to apply it; a frame sent before then
    // reaches nobody, correctly. So keep sending frames, as a node would,
    // until one arrives or the deadline says it never will.
    const deadline = Date.now() + 5000;
    for (let frame = 1; Date.now() < deadline && !seen.some((m) => m.type === 'raw' && m.uid === uid); frame++) {
      rt.emit('raw', { uid, frame, tMin: 20, step: 0.05, pixels: Array(768).fill(120), receivedAt: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(seen.some((m) => m.type === 'state'), 'the state arrives on connect');
    assert.ok(seen.some((m) => m.type === 'raw' && m.uid === uid), 'and raw frames for the node it asked for');
  } finally {
    ws.close();
  }

  // A forged token gets nothing.
  const bad = new WebSocket(`${algoBase.replace('http', 'ws')}/console-app/ws?token=1.forged`);
  const outcome = await new Promise<string>((r) => {
    bad.addEventListener('open', () => r('open'), { once: true });
    bad.addEventListener('error', () => r('refused'), { once: true });
  });
  assert.equal(outcome, 'refused');
});

test('console writes still need their header, and the cookie alone is not enough', async () => {
  const { algoBase, cookie } = await boot();
  const uid = encodeURIComponent('02:00:00:00:00:01');
  const res = await fetch(`${algoBase}/console-app/api/nodes/${uid}/command`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'identify' }),
  });
  assert.equal(res.status, 403, 'a cross-site form can carry the cookie but not x-tm-console');
});

test('module 04 deep links require sign-in and its firmware services retain the upload guard', async () => {
  const { algoBase, cookie } = await boot();
  for (const path of ['/updates', '/updates/']) {
    const signedOut = await fetch(`${algoBase}${path}`, { redirect: 'manual' });
    assert.equal(signedOut.status, 302);
    assert.equal(signedOut.headers.get('location'), `/login?next=${encodeURIComponent(path)}`);
    const signedIn = await fetch(`${algoBase}${path}`, { headers: { cookie } });
    assert.ok([200, 503].includes(signedIn.status), 'the shell is available after build, never a missing route');
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
  }
  const url = `${algoBase}/console-app/api/firmware`;
  assert.equal((await fetch(url)).status, 401);
  const status = await fetch(url, { headers: { cookie } });
  assert.equal(status.status, 200);
  assert.ok(Array.isArray((await status.json() as { builds: unknown[] }).builds));
  assert.equal((await fetch(`${url}/uploads`, { method: 'POST', headers: { cookie } })).status, 403);
  const upload = await fetch(`${url}/uploads`, { method: 'POST', headers: { cookie, 'x-tm-console': '1' } });
  assert.equal(upload.status, 200);
  const { uploadId } = await upload.json() as { uploadId: string };
  const fileUrl = `${url}/uploads/${uploadId}/files?path=`;
  const headers = { cookie, 'x-tm-console': '1', 'content-type': 'application/octet-stream' };
  assert.equal((await fetch(`${fileUrl}TMsense%2Fsrc%2Fmain.cpp`, { method: 'POST', headers, body: 'void setup() {}' })).status, 200);
  assert.equal((await fetch(`${fileUrl}TMsense%2Finclude%2Fnode_config.h`, { method: 'POST', headers, body: 'private settings' })).status, 400);
});

test('the console port keeps the device endpoints and sends a browser on to module 03', async () => {
  const { consoleBase } = await boot();
  const page = await fetch(`${consoleBase}/`, { redirect: 'manual' });
  // 200 or 401, nothing else: the health check production runs is pinned on
  // the box (a release cannot replace it), and a 302 here rolled a deploy back.
  assert.equal(page.status, 200, 'the pinned deploy health check accepts only 200 or 401 from this port');
  assert.match(await page.text(), /http-equiv="refresh" content="0; url=http:\/\/127\.0\.0\.1:8091\/console"/, 'and the page forwards the browser at once');
  assert.equal(page.headers.get('www-authenticate'), null, 'no browser password prompt here either');
  // The target is built from the Host header; it must not become markup.
  const { request } = await import('node:http');
  const port = new URL(consoleBase).port;
  const body = await new Promise<string>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', headers: { host: 'x"><script>alert(1)</script>' } }, (r) => {
      let b = ''; r.on('data', (c: Buffer) => { b += c.toString(); }); r.on('end', () => resolve(b));
    }).on('error', reject).end();
  });
  assert.ok(!body.includes('<script>'), 'a hostile Host header is escaped, not injected');
  const api = await fetch(`${consoleBase}/api/state`);
  assert.equal(api.status, 410, 'the old API says where it went instead of serving raw frames past a password');

  // Devices: still here, still answering on their own terms.
  assert.equal((await fetch(`${consoleBase}/fw/0123456789abcdef.bin`)).status, 404, 'firmware download is served, not redirected');
  assert.equal((await fetch(`${consoleBase}/api/provision/status/aa:bb`)).status, 401, 'TMflash gets its token check');
  const rgb = await fetch(`${consoleBase}/api/demo/rgb/02:00:00:00:00:01`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(10) });
  assert.equal(rgb.status, 403, 'the rig upload is checked as before');
});

test('the old public address goes to the algo console over https', () => {
  const to = consoleMovedTo(8091);
  const req = (host: string) => ({ get: (h: string) => (h === 'host' ? host : undefined) }) as unknown as Request;
  assert.equal(to(req('console.hkumyseat.com')), 'https://algo.hkumyseat.com/console');
  assert.equal(to(req('localhost:8090')), 'http://localhost:8091/console');
  assert.equal(to(req('100.79.19.4:8090')), 'http://100.79.19.4:8091/console');
});

async function rejectedFeed(url: string, cookie = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_request, response) => {
      response.resume(); ws.terminate(); resolve(response.statusCode ?? 0);
    });
    ws.on('open', () => { ws.terminate(); reject(new Error('feed unexpectedly accepted')); });
  });
}

test('algo and debug feeds require their live session, bind tokens to it and close on logout', async () => {
  const { algoBase, cookie } = await boot();
  const opened: WebSocket[] = [];
  try {
    for (const prefix of ['', '/console-app']) {
      const { token } = await (await fetch(`${algoBase}${prefix}/api/ws-token`, { headers: { cookie } })).json() as { token: string };
      const url = `${algoBase.replace('http', 'ws')}${prefix}/ws?token=${encodeURIComponent(token)}`;
      assert.equal(await rejectedFeed(url), 401, 'a stolen token alone cannot authorize an upgrade');
      const ws = new WebSocket(url, { headers: { cookie } });
      ws.on('error', () => {});
      opened.push(ws);
      await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject); });
    }
    const closed = opened.map((ws) => new Promise<void>((resolve) => ws.once('close', () => resolve())));
    assert.equal((await fetch(`${algoBase}/auth/logout`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    })).status, 200);
    await Promise.all(closed);
    assert.equal((await fetch(`${algoBase}/api/me`, { headers: { cookie } })).status, 401);
  } finally { for (const ws of opened) ws.terminate(); }
});

test('a password reset ends existing debug streams without an edge restart', async () => {
  const { algoBase, cookie, usersPath } = await boot();
  const { token } = await (await fetch(`${algoBase}/console-app/api/ws-token`, { headers: { cookie } })).json() as { token: string };
  const ws = new WebSocket(`${algoBase.replace('http', 'ws')}/console-app/ws?token=${encodeURIComponent(token)}`, { headers: { cookie } });
  ws.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject); });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await new AlgoUsers(usersPath).add('alice', 'a different correct password');
    await closed;
    assert.equal((await fetch(`${algoBase}/api/me`, { headers: { cookie } })).status, 401);
  } finally { ws.terminate(); }
});
