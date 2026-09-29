/**
 * Claims about the console's live feed. Raw thermal frames and RGB are sent
 * only to a console that asked for that node, and the cap on how many nodes
 * one console may watch has to be above the number a site actually has --
 * otherwise the nodes past the limit go blank with nothing to show for it,
 * which is how the real hardware disappeared behind twenty simulated ones.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { startConsole } from '../src/edge/console.js';
import { buildRegistry } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { FirmwareBuildJobs } from '../src/modules/firmware/application/firmware-build-jobs.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null, pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return new EdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

const frame = (uid: string) => ({ uid, frame: 1, tMin: 20, step: 0.05, pixels: Array(768).fill(120), receivedAt: Date.now() });

/** Open the console's live socket the way the page does. */
async function live(base: string, auth: string) {
  const token = ((await (await fetch(`${base}/api/ws-token`, { headers: { authorization: auth } })).json()) as { token: string }).token;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const seen: { type: string; uid?: string }[] = [];
  ws.addEventListener('message', (e) => seen.push(JSON.parse(String(e.data)) as { type: string; uid?: string }));
  await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }));
  return { ws, seen, close: () => ws.close() };
}

test('a console sees raw frames from every node it asks for, well past a site full of nodes', async () => {
  const rt = runtime();
  const server = startConsole(rt);
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const { ws, seen, close } = await live(base, auth);
  try {
    // Thirty nodes: more than any one site has, and well past the old limit
    // of sixteen that quietly hid the real hardware.
    const uids = Array.from({ length: 30 }, (_, i) => `02:00:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`);
    const last = uids[uids.length - 1] ?? '';
    ws.send(JSON.stringify({ type: 'subscribe', uids }));
    await new Promise((r) => setTimeout(r, 80));

    rt.emit('raw', frame(last));
    rt.emit('rgb', last, Buffer.from([0xff, 0xd8, 0xff]), Date.now());
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(seen.some((m) => m.type === 'raw' && m.uid === last), 'the last node subscribed still gets through');
    assert.ok(seen.some((m) => m.type === 'rgb' && m.uid === last), 'and so does its RGB');
  } finally {
    close();
    server.close();
    await rt.stop();
  }
});

test('a console is never sent frames from a node it did not ask for', async () => {
  const rt = runtime();
  const server = startConsole(rt);
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const { ws, seen, close } = await live(base, auth);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', uids: ['02:00:00:00:00:01'] }));
    await new Promise((r) => setTimeout(r, 80));
    rt.emit('raw', frame('30:ed:a0:cb:f5:f8'));
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!seen.some((m) => m.type === 'raw'), 'raw frames stay with the consoles that asked');
  } finally {
    close();
    server.close();
    await rt.stop();
  }
});

test('legacy firmware routes preserve auth, mutation guard, and polling shape', async () => {
  const rt = runtime();
  const server = startConsole(rt);
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const mutating = { authorization: auth, 'x-tm-console': '1' };
  try {
    assert.equal((await fetch(`${base}/api/firmware`)).status, 401, 'firmware status remains admin-only');
    const firmware = await fetch(`${base}/api/firmware`, { headers: { authorization: auth } });
    assert.equal(firmware.status, 200);
    const firmwareBody = await firmware.json() as { builds: unknown[]; building: unknown; rollout: unknown; history: unknown[] };
    assert.ok(Array.isArray(firmwareBody.builds));
    assert.equal(firmwareBody.building, null);
    assert.ok(Array.isArray(firmwareBody.history));
    assert.equal((await fetch(`${base}/api/nodes/30:ed:a0:cb:f5:f8/raw`, { headers: { authorization: auth } })).status, 404);
    assert.equal((await fetch(`${base}/api/firmware/uploads`, { method: 'POST', headers: { authorization: auth } })).status, 403);
    assert.equal((await fetch(`${base}/api/firmware/uploads`, { method: 'POST', headers: mutating })).status, 200);
  } finally {
    server.close();
    await rt.stop();
  }
});

test('firmware build failures retain the legacy polling error payload and allow a retry', async () => {
  const rt = runtime();
  let calls = 0;
  const jobs = new FirmwareBuildJobs({
      execute: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('build failed (pio exit 1)'), { log: ['compiler error'] });
        return { artifact: { id: 'image-a', sha256: 'a'.repeat(64), size: 10, version: '1.0.0' }, stagedOutputId: 'image-a', log: [] };
    },
  });
  const server = startConsole(rt, { firmwareBuildJobs: jobs });
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const headers = { authorization: auth, 'x-tm-console': '1' };
  try {
    assert.equal((await fetch(`${base}/api/firmware/uploads/first/build`, { method: 'POST', headers })).status, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const status = await (await fetch(`${base}/api/firmware`, { headers: { authorization: auth } })).json() as {
      building: { startedAt: number; error?: string; log: string[] } | null;
    };
    assert.ok(status.building);
    assert.equal(Number.isFinite(status.building.startedAt), true);
    assert.equal(status.building.error, 'build failed (pio exit 1)');
    assert.deepEqual(status.building.log, ['compiler error']);
    assert.equal((await fetch(`${base}/api/firmware/uploads/retry/build`, { method: 'POST', headers })).status, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await (await fetch(`${base}/api/firmware`, { headers: { authorization: auth } })).json() as { building: unknown }).building, null);
  } finally {
    server.close();
    await rt.stop();
  }
});

test('firmware HTTP build endpoint rejects a second active request with the legacy conflict response', async () => {
  const rt = runtime();
  const jobs = new FirmwareBuildJobs({
    execute: async () => new Promise<{ artifact: { id: string; sha256: string; size: number; version: string }; stagedOutputId: string; log: string[] }>(() => {}),
  });
  const server = startConsole(rt, { firmwareBuildJobs: jobs });
  await new Promise<void>((r) => server.listening ? r() : server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`,
    'x-tm-console': '1',
  };
  try {
    const first = await fetch(`${base}/api/firmware/uploads/first/build`, { method: 'POST', headers });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { ok: true });
    const duplicate = await fetch(`${base}/api/firmware/uploads/second/build`, { method: 'POST', headers });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'a build is already running' });
  } finally {
    server.close();
    await rt.stop();
  }
});
