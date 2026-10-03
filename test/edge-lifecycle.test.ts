import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEdgeApplication } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { FirmwareBuildJobs } from '../src/modules/firmware/application/firmware-build-jobs.js';
import { buildRegistry } from '../src/edge/registry.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

function config(): EdgeConfig {
  return {
    edgeId: 'lifecycle-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-lifecycle-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60_000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS,
    nodeTls: null,
  };
}

function registry() {
  return buildRegistry(siteJson(), nodesJson());
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('edge startup bind failure rejects and rolls back already-bound listeners', async () => {
  const occupied = createServer();
  const busyPort = await listen(occupied);
  const cfg = config();
  cfg.consolePort = busyPort;
  const app = createEdgeApplication(cfg, registry());
  try {
    await assert.rejects(app.start(), /EADDRINUSE|address already in use/i);
    await app.stop();
    await app.stop();
  } finally {
    await close(occupied);
  }
});

test('debugger bind failure closes the console listener and partially composed app', async () => {
  const occupied = createServer();
  const busyPort = await listen(occupied);
  const cfg = config();
  cfg.algoPort = busyPort;
  const app = createEdgeApplication(cfg, registry());
  try {
    await assert.rejects(app.start(), /EADDRINUSE|address already in use/i);
    assert.equal(app.consoleServer.listening, false);
    assert.equal(app.runtime.isStarted, false);
    await app.stop();
  } finally {
    await close(occupied);
  }
});

test('edge shutdown closes live console sockets, stops a build, and flushes recording', async () => {
  let markBuildStarted: (() => void) | null = null;
  let finishBuild: (() => void) | null = null;
  let disposedBuilds = 0;
  const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
  const jobs = new FirmwareBuildJobs({
    execute: async () => new Promise((resolve) => {
      markBuildStarted?.();
      finishBuild = () => resolve({
        artifact: { id: 'image', sha256: 'a'.repeat(64), size: 1, version: '1.0' },
        stagedOutputId: 'image', log: [],
      });
    }),
    dispose: async () => {
      disposedBuilds += 1;
      finishBuild?.();
    },
  });
  const cfg = config();
  cfg.algoPort = await availablePort();
  const app = createEdgeApplication(cfg, registry(), { firmwareBuildJobs: jobs });
  await app.start();
  assert.equal(app.runtime.isStarted, true);
  assert.ok(app.debuggerServer?.server.listening);
  const port = (app.consoleServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
  const token = ((await (await fetch(`${base}/api/ws-token`, { headers: { authorization: auth } })).json()) as { token: string }).token;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('console websocket failed to connect')), { once: true });
  });
  try {
    assert.equal(jobs.start('pending-upload', { id: 'test', kind: 'system' }), true);
    await buildStarted;
    app.runtime.recorder.snapshot(app.runtime.latest);
    await app.stop();
    await app.stop();
    assert.equal(app.runtime.isStarted, false);
    assert.equal(disposedBuilds, 1);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.equal(app.consoleServer.listening, false);
    assert.equal(app.debuggerServer?.server.listening, false);
    assert.equal(app.runtime.listenerCount('raw'), 0);
    const day = new Date(app.runtime.latest.generatedAt).toISOString().slice(0, 10);
    assert.match(readFileSync(join(cfg.dataDir, 'occupancy', `${day}.jsonl`), 'utf8'), /"tables"/);
  } finally {
    if (app.consoleServer.listening) await app.stop();
  }
});
