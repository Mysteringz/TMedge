import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function createRuntime() {
  const cfg: EdgeConfig = {
    edgeId: 'algo-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-algo-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60_000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return { cfg, runtime: createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson())) };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('algo debugger preserves authenticated APIs and owns its WebSocket lifecycle', async () => {
  const { cfg, runtime } = createRuntime();
  const usersPath = join(mkdtempSync(join(tmpdir(), 'tmedge-algo-users-')), 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('alice', 'correct horse battery');
  await users.add('read-only-engineer', 'another correct horse battery', 'engineer');
  const auth = loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, cfg.adminPassword);
  const handle = startAlgo(runtime, 0, '127.0.0.1', auth);
  await new Promise<void>((resolve) => handle.server.once('listening', () => resolve()));
  const port = (handle.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const headers = { cookie, 'content-type': 'application/json', 'x-tm-algo': '1' };
    const engineerLogin = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'read-only-engineer', password: 'another correct horse battery' }),
    });
    assert.equal(engineerLogin.status, 200);
    const engineerCookie = (engineerLogin.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const vendorPath = '/location-model/vendor/three/GLTFLoader.js';
    const anonymousVendor = await fetch(`${base}${vendorPath}`, { redirect: 'manual' });
    assert.equal(anonymousVendor.status, 302, 'unsigned vendor requests are redirected to sign-in without receiving module bytes');
    assert.match(anonymousVendor.headers.get('location') ?? '', /^\/login/);
    const vendor = await fetch(`${base}${vendorPath}`, { headers: { cookie } });
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get('content-type') ?? '', /javascript/);
    assert.equal(vendor.headers.get('cache-control'), 'no-store');
    assert.match(await vendor.text(), /GLTFLoader/);
    const utility = await fetch(`${base}/location-model/vendor/three/BufferGeometryUtils.js`, { headers: { cookie } });
    assert.equal(utility.status, 200, 'GLTFLoader’s checked-in relative dependency is available from the same edge origin');
    assert.match(await utility.text(), /toTrianglesDrawMode/);
    assert.equal((await fetch(`${base}${vendorPath}`, { headers: { cookie: engineerCookie } })).status, 404,
      'the viewer modules are restricted to location managers');
    const viewerEntryPath = '/location-model-viewer.js?attempt=2';
    assert.equal((await fetch(`${base}/location-model-viewer.js`)).status, 404,
      'the executable viewer module is not served to anonymous requests');
    assert.equal((await fetch(`${base}${viewerEntryPath}`, { headers: { cookie: engineerCookie } })).status, 404,
      'the executable viewer module is restricted to locations managers');
    const viewerEntry = await fetch(`${base}${viewerEntryPath}`, { headers: { cookie } });
    assert.equal(viewerEntry.status, 200, 'location managers can retry the edge-hosted viewer entry');
    assert.equal(viewerEntry.headers.get('cache-control'), 'no-store');
    assert.match(await viewerEntry.text(), /LocationModelScene/);
    const viewerScene = await fetch(`${base}/location-model-viewer/scene.js`, { headers: { cookie } });
    assert.equal(viewerScene.status, 200, 'the viewer entry resolves its same-origin scene module');
    assert.equal(viewerScene.headers.get('cache-control'), 'no-store');
    assert.match(await viewerScene.text(), /GLTFLoader/);
    assert.equal((await fetch(`${base}/location-model-viewer/scene.js`, { headers: { cookie: engineerCookie } })).status, 404,
      'the scene implementation is not exposed to non-manager sessions');
    assert.equal((await fetch(`${base}/location-model/vendor/three/BufferGeometry.js`, { headers: { cookie } })).status, 404,
      'the edge exposes only the three explicitly needed vendor modules');
    assert.equal((await fetch(`${base}/api/catalogue`)).status, 401);
    assert.equal((await fetch(`${base}/api/catalogue`, { headers: { cookie } })).status, 200);
    const current = await (await fetch(`${base}/api/pipeline`, { headers: { cookie } })).json() as {
      pipeline: { version: number; nodes: unknown[] };
      saved: string[];
    };
    assert.equal(current.pipeline.version, 1);
    assert.equal((await fetch(`${base}/api/pipeline/reset`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/pipeline/save`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'regression' }),
    })).status, 200);
    const saved = await (await fetch(`${base}/api/pipeline`, { headers: { cookie } })).json() as { saved: string[] };
    assert.ok(saved.saved.includes('regression'));

    const applied = await fetch(`${base}/api/params/apply`, {
      method: 'POST', headers,
      body: JSON.stringify({ nodeId: 'occ-1', param: 'seatRadiusCm', value: 120 }),
    });
    assert.equal(applied.status, 200);
    const reverted = await fetch(`${base}/api/params/revert`, {
      method: 'POST', headers, body: JSON.stringify({ param: 'occupancy.seatRadiusCm' }),
    });
    assert.deepEqual(await reverted.json(), { ok: true });
    const audit = readFileSync(join(cfg.dataDir, 'algo', 'audit.jsonl'), 'utf8');
    assert.match(audit, /"action":"apply"/);
    assert.match(audit, /"action":"revert"/);

    const token = ((await (await fetch(`${base}/api/ws-token`, { headers: { cookie } })).json()) as { token: string }).token;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers: { cookie } });
    const initial = await new Promise<{ type: string; live: boolean }>((resolve, reject) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as { type: string; live: boolean }), { once: true });
      socket.addEventListener('error', () => reject(new Error('algo WebSocket failed to connect')), { once: true });
    });
    assert.deepEqual(initial, { type: 'pipeline_state', pipeline: current.pipeline, live: true });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    await handle.dispose();
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(runtime.listenerCount('raw'), 0);
    assert.equal(runtime.listenerCount('rgb'), 0);
    assert.equal(runtime.listenerCount('report'), 0);
  } finally {
    await handle.dispose();
    if (handle.server.listening) await close(handle.server);
    await runtime.stop();
  }
});
