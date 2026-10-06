import { connect } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { FrameReader, frame, helloMac, T_HELLO, T_WELCOME, T_DENY } from '../src/edge/gwlink.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AlgoUsers } from '../src/algo/auth.js';
import { FirmwareBuildJobs } from '../src/modules/firmware/application/firmware-build-jobs.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEdgeApplication, createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { DeviceKeys, GatewayKeys, deriveKey, decryptPayload, secureHeader, encryptPacket } from '../src/edge/secure.js';
import { buildReport } from '../src/edge/protocol.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

const uid = '30:ed:a0:cb:f5:f8';
function config(): EdgeConfig {
  return {
    edgeId: 'composition-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-composition-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
}

test('production composition accepts encrypted telemetry and retains replay and command cursors across recreation', async () => {
  const cfg = config();
  cfg.devices = new DeviceKeys({ version: 2, nodes: { [uid]: { current: { id: 7, secret: '11'.repeat(32) } } } });
  const packet = encryptPacket(buildReport({ uid, boot: 1, seq: 100, key: KEY }, 1000,
    { frame: 1, ta: 22, sceneMin: 21, sceneMax: 30, bgMean: 23, flags: 1, detections: [] }),
    { id: 7, master: Buffer.alloc(32, 0x11) }, 70000, Buffer.alloc(16, 0x22), 'uplink');
  const first = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  let sequence: number;
  try {
    assert.equal((await first.ingest.handleDurable(packet, '127.0.0.1')).ok, true);
    sequence = first.ingest.allocateCommandSeq();
  } finally { await first.stop(); }
  const second = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  try {
    assert.equal((await second.ingest.handleDurable(packet, '127.0.0.1')).ok, false);
    assert.equal(second.ingest.allocateCommandSeq(), sequence! + 1);
  } finally { await second.stop(); }
});

// Exercise the production application rather than manually sharing a console core.
test('production application mounts one session-protected console and disposes injected build work once', { timeout: 15000 }, async () => {
  const cfg = config();
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  cfg.algoPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const usersPath = join(cfg.dataDir, 'algo-users.json');
  await new AlgoUsers(usersPath).add('alice', 'correct horse battery');
  const previousSecret = process.env.SESSION_SECRET, previousUsers = process.env.ALGO_USERS_FILE;
  process.env.SESSION_SECRET = 'x'.repeat(40);
  process.env.ALGO_USERS_FILE = usersPath;
  let disposed = 0;
  let finish: (() => void) | undefined;
  const jobs = new FirmwareBuildJobs({
    execute: async () => new Promise(resolve => { finish = () => resolve({
      artifact: { id: 'test', sha256: 'a'.repeat(64), size: 1, version: '1.0' }, stagedOutputId: 'test', log: [],
    }); }),
    dispose: async () => { disposed++; finish?.(); },
  });
  const app = createEdgeApplication(cfg, buildRegistry(siteJson(), nodesJson()), { firmwareBuildJobs: jobs });
  try {
    assert.equal(app.consoleServer.listening, false);
    await app.start();
    const oldBase = `http://127.0.0.1:${(app.consoleServer.address() as AddressInfo).port}`;
    const base = `http://127.0.0.1:${cfg.algoPort}`;
    assert.equal((await fetch(oldBase + '/api/state')).status, 410);
    assert.equal(app.runtime.listenerCount('snapshot'), 1, 'the listeners share one console feed');
    const oldFeedStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(oldBase.replace('http', 'ws') + '/ws?token=unused');
      socket.on('error', () => {});
      socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode!); });
      socket.on('open', () => { socket.terminate(); reject(new Error('legacy feed unexpectedly opened')); });
    });
    assert.equal(oldFeedStatus, 401);
    assert.match(await (await fetch(oldBase + '/')).text(), /console/);
    assert.equal((await fetch(oldBase + '/healthz')).status, 401);
    assert.equal((await fetch(oldBase + '/healthz', { headers: { authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}` } })).status, 200);
    assert.equal((await fetch(base + '/console-app/api/state')).status, 401);
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct horse battery' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, 'x-tm-console': '1', 'x-tm-algo': '1' };
    assert.equal((await fetch(base + '/console-app/api/state', { headers })).status, 200);
    const build = await fetch(base + '/console-app/api/firmware/uploads/test/build', { method: 'POST', headers });
    assert.equal(build.status, 202);
    assert.ok(jobs.status(), 'the mounted route uses the injected service');
    const tokenResponse = await fetch(base + '/console-app/api/ws-token', { headers });
    const { token } = await tokenResponse.json() as { token: string };
    const ws = new WebSocket(base.replace('http', 'ws') + '/console-app/ws?token=' + token, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    await fetch(base + '/auth/logout', { method: 'POST', headers });
    await closed;
    await app.stop(); await app.stop();
    assert.equal(disposed, 1);
    assert.equal(app.runtime.listenerCount('raw'), 0);
  } finally {
    await app.stop();
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    if (previousUsers === undefined) delete process.env.ALGO_USERS_FILE; else process.env.ALGO_USERS_FILE = previousUsers;
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('production direct listener authenticates device keys, durably admits telemetry and refuses plaintext firmware downgrade', { timeout: 10000 }, async () => {
  const cfg = config(); cfg.nodePort = await freePort();
  cfg.devices = new DeviceKeys({ version: 2, nodes: { [uid]: { current: { id: 7, secret: '11'.repeat(32) } } } });
  const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  let client: WebSocket | undefined;
  let controlRoot: Buffer;
  let ready!: () => void, acknowledged!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const ack = new Promise<void>(resolve => { acknowledged = resolve; });
  try {
    await runtime.direct!.listen();
    client = new WebSocket(`ws://127.0.0.1:${cfg.nodePort}/tmnode`, 'tmnode.v1');
    client.on('error', () => {});
    client.on('message', (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      if (!binary) {
        const challenge = JSON.parse(bytes.toString()) as { nonce: string };
        controlRoot = deriveKey(Buffer.alloc(32, 0x11), uid, 7, 'control', Buffer.from(challenge.nonce, 'hex'));
        const mac = createHmac('sha256', deriveKey(Buffer.alloc(32, 0x11), uid, 7, 'auth')).update(`tmnode1|${uid}|${challenge.nonce}`).digest('hex');
        client!.send(JSON.stringify({ type: 'auth', v: 1, uid, nonce: challenge.nonce, mac }));
      } else {
        const header = secureHeader(bytes);
        const message = JSON.parse(decryptPayload(bytes, deriveKey(controlRoot, uid, 7, 'control-message', header.epoch)).payload.toString()) as { type: string; seq: number };
        if (message.type === 'ready') ready();
        if (message.type === 'ack') { assert.equal(message.seq, 100); acknowledged(); }
      }
    });
    await connected;
    const packet = encryptPacket(buildReport({ uid, boot: 1, seq: 100, key: KEY }, 1000,
      { frame: 1, ta: 22, sceneMin: 21, sceneMax: 30, bgMean: 23, flags: 1, detections: [] }),
      { id: 7, master: Buffer.alloc(32, 0x11) }, 70000, Buffer.alloc(16, 0x22), 'uplink');
    client.send(packet);
    await ack;
    assert.equal(runtime.ingest.links.get(uid)?.secureId, 7);
    // Hydrate a real verified artifact with an older version, as durable startup does.
    const bytes = Buffer.alloc(1024, 7), sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = { id: sha256.slice(0, 16), sha256, size: bytes.length, version: 'tmsense-1.6' };
    writeFileSync(join(cfg.dataDir, 'firmware', 'artifacts', artifact.id + '.bin'), bytes);
    runtime.firmware.hydrateDurableArtifacts([artifact], [{ lifecycle: 'succeeded', actor: { id: 'test' }, startedAt: 1, finishedAt: 2, artifact, log: [] }]);
    assert.throws(() => runtime.rollouts.start(artifact.id, { kind: 'node', uid }, 'test'), /plaintext downgrade refused/);
  } finally { client?.terminate(); await runtime.stop(); }
  const restarted = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  try {
    const packet = encryptPacket(buildReport({ uid, boot: 1, seq: 100, key: KEY }, 1000,
      { frame: 1, ta: 22, sceneMin: 21, sceneMax: 30, bgMean: 23, flags: 1, detections: [] }),
      { id: 7, master: Buffer.alloc(32, 0x11) }, 70000, Buffer.alloc(16, 0x22), 'uplink');
    assert.equal((await restarted.ingest.handleDurable(packet, '127.0.0.1')).ok, false, 'ACK followed durable cursor storage');
  } finally { await restarted.stop(); }
});

test('production gateway activates per-identity credentials, defaults raw TCP off and retains HELLO replay history', { timeout: 10000 }, async () => {
  const cfg = config(); cfg.gatewayPort = await freePort();
  cfg.gatewayKeys = new GatewayKeys({ version: 1, gateways: { test: { current: '55'.repeat(32) } } });
  let runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  try {
    assert.ok(runtime.gateways);
    await runtime.gateways.listen();
    const socket = connect(cfg.gatewayPort, '127.0.0.1'); socket.on('error', () => {});
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.write(frame(T_HELLO, Buffer.from('{}'))); await closed;
    assert.equal(runtime.gateways.gateways().length, 0);
  } finally { await runtime.stop(); }
  cfg.gatewayAllowRawTcp = true;
  const ts = Date.now(), nonce = 'composition-replay';
  async function hello(expected: number): Promise<void> {
    const socket = connect(cfg.gatewayPort, '127.0.0.1'); socket.on('error', () => {});
    const reader = new FrameReader();
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HELLO response timed out')), 2000);
        socket.on('data', bytes => reader.push(bytes, type => { clearTimeout(timeout); try { assert.equal(type, expected); resolve(); } catch (error) { reject(error); } }));
        socket.write(frame(T_HELLO, Buffer.from(JSON.stringify({ v: 1, gatewayId: 'test', ts, nonce, mac: helloMac(Buffer.from('55'.repeat(32)), 'test', ts, nonce) }))));
      });
    } finally { socket.destroy(); }
  }
  runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  try { await runtime.gateways!.listen(); await hello(T_WELCOME); } finally { await runtime.stop(); }
  runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
  try { await runtime.gateways!.listen(); await hello(T_DENY); } finally { await runtime.stop(); }
});
