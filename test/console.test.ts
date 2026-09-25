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
import type { EdgeConfig } from '../src/edge/config.js';
import { startConsole } from '../src/edge/console.js';
import { buildRegistry } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
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
