import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { createConsole, startConsole, stopConsole } from '../src/edge/console.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { buildRegistry } from '../src/edge/registry.js';
import { CMD_IDENTIFY } from '../src/edge/protocol.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'security-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-console-security-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass',
    flashToken: 'flash-test-token', pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0,
    nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

const authorization = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;

async function websocketStatus(url: string, origin?: string): Promise<number> {
  const socket = new WebSocket(url, origin ? { origin } : {});
  return new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
    socket.once('open', () => { socket.terminate(); resolve(101); });
    socket.once('error', (error) => { if (!error.message.includes('before the connection was established')) reject(error); });
  });
}

test('legacy console protects imagery, provisioning, firmware, static UI and live token; authenticated JSON dispatch works', { timeout: 15000 }, async (t) => {
  const rt = runtime();
  const sent: unknown[][] = [];
  rt.ingest.sendCommand = async (...args) => { sent.push(args); return sent.length; };
  const server = startConsole(rt, { listen: false });
  t.after(async () => { await stopConsole(server); await new Promise<void>((resolve) => server.close(() => resolve())); await rt.stop(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ['/api/state', '/', '/api/layout', '/api/nodes/node-a/raw', '/api/nodes/node-a/rgb.jpg', '/api/provision/requests', '/api/firmware', '/api/ws-token']) {
    assert.equal((await fetch(base + path)).status, 401, `${path} needs admin credentials`);
  }
  const page = await fetch(base + '/', { headers: { authorization } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await page.text(), /TMedge/i);
  const path = base + '/api/nodes/node-a/command';
  const body = JSON.stringify({ op: 'identify', value: 7 });
  assert.equal((await fetch(path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body })).status, 403);
  assert.equal(sent.length, 0);
  const command = await fetch(path, { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-tm-console': '1' }, body });
  assert.equal(command.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ['node-a', CMD_IDENTIFY, 0, 7]);
  assert.equal((await fetch(base + '/api/provision/status/node-a')).status, 401);
  assert.equal((await fetch(base + '/api/provision/status/node-a', { headers: { authorization: 'Bearer flash-test-token' } })).status, 200);
  assert.equal((await fetch(base + '/api/demo/rgb/node-a', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([255, 216]) })).status, 403);
  assert.equal((await fetch(base + '/fw/not-an-image.bin')).status, 404);
  const wsBase = base.replace('http', 'ws');
  assert.equal(await websocketStatus(wsBase + '/ws'), 401);
  const tokenResponse = await fetch(base + '/api/ws-token', { headers: { authorization } });
  const { token } = await tokenResponse.json() as { token: string };
  assert.equal(await websocketStatus(wsBase + '/ws?token=' + encodeURIComponent(token), 'https://evil.example'), 401);
  assert.equal(await websocketStatus(wsBase + '/ws?token=' + encodeURIComponent(token), base), 101);
});

test('shared console owns one feed and cleanup while moved legacy port hides all UI APIs', { timeout: 10000 }, async (t) => {
  const rt = runtime();
  let disposed = 0;
  const core = createConsole(rt, { firmwareBuildJobs: {
    start: async () => true, status: async () => null, dispose: async () => { disposed += 1; },
  } });
  const server = startConsole(rt, core, { listen: false, uiMovedTo: () => 'http://localhost:3100/console' });
  t.after(async () => { await stopConsole(server); await new Promise<void>((resolve) => server.close(() => resolve())); await rt.stop(); });
  assert.equal(rt.listenerCount('raw'), 1);
  assert.equal(rt.listenerCount('rgb'), 1);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base + '/')).status, 200, 'deployment health probe compatibility');
  for (const path of ['/healthz', '/readyz']) {
    assert.equal((await fetch(base + path)).status, 401, `${path} requires admin authentication`);
  }
  const liveness = await fetch(base + '/healthz', { headers: { authorization } });
  assert.equal(liveness.status, 200);
  assert.deepEqual(await liveness.json(), { live: true });
  const readiness = await fetch(base + '/readyz', { headers: { authorization } });
  assert.equal(readiness.status, 200);
  const readyBody = await readiness.json() as { live: boolean; ready: boolean; components: { firmwareBuilds: unknown; persistence: { mode: string } } };
  assert.equal(readyBody.live, true);
  assert.equal(readyBody.ready, false);
  assert.equal(readyBody.components.persistence.mode, 'file');
  assert.equal(readyBody.components.firmwareBuilds, null);

  for (const path of ['/api/state', '/api/ws-token', '/api/firmware', '/api/provision/requests']) {
    assert.equal((await fetch(base + path, { headers: { authorization } })).status, 410);
  }
  assert.equal((await fetch(base + '/api/provision/status/node-a', { headers: { authorization: 'Bearer flash-test-token' } })).status, 200);
  await Promise.all([core.dispose(), stopConsole(server), core.dispose()]);
  assert.equal(disposed, 1);
  assert.equal(rt.listenerCount('raw'), 0);
  assert.equal(rt.listenerCount('rgb'), 0);
});
