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
import { mkdtempSync } from 'node:fs';
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
import { KEY, nodesJson, siteJson } from './fixtures.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tmedge-algoconsole-'));

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

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
  await new AlgoUsers(usersPath).add('alice', 'correct horse battery', 'admin');
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
    await new AlgoUsers(usersPath).resetPassword('alice', 'a different correct password');
    await closed;
    assert.equal((await fetch(`${algoBase}/api/me`, { headers: { cookie } })).status, 401);
  } finally { ws.terminate(); }
});
