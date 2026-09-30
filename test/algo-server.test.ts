import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function createRuntime() {
  const cfg: EdgeConfig = {
    edgeId: 'algo-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-algo-')), recordRaw: false,
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
  const handle = startAlgo(runtime, 0, '127.0.0.1', { dataDir: cfg.dataDir });
  await new Promise<void>((resolve) => handle.server.once('listening', () => resolve()));
  const port = (handle.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const headers = { authorization: auth, 'content-type': 'application/json', 'x-tm-algo': '1' };
  try {
    assert.equal((await fetch(`${base}/api/catalogue`)).status, 401);
    assert.equal((await fetch(`${base}/api/catalogue`, { headers: { authorization: auth } })).status, 200);
    const current = await (await fetch(`${base}/api/pipeline`, { headers: { authorization: auth } })).json() as {
      pipeline: { version: number; nodes: unknown[] };
      saved: string[];
    };
    assert.equal(current.pipeline.version, 1);
    assert.equal((await fetch(`${base}/api/pipeline/reset`, { method: 'POST', headers: { authorization: auth } })).status, 403);
    assert.equal((await fetch(`${base}/api/pipeline/save`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'regression' }),
    })).status, 200);
    const saved = await (await fetch(`${base}/api/pipeline`, { headers: { authorization: auth } })).json() as { saved: string[] };
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

    const token = ((await (await fetch(`${base}/api/ws-token`, { headers: { authorization: auth } })).json()) as { token: string }).token;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const initial = await new Promise<{ type: string; live: boolean }>((resolve, reject) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as { type: string; live: boolean }), { once: true });
      socket.addEventListener('error', () => reject(new Error('algo WebSocket failed to connect')), { once: true });
    });
    assert.deepEqual(initial, { type: 'pipeline_state', pipeline: current.pipeline, live: true });
    await handle.dispose();
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
