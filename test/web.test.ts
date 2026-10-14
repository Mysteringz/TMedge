/**
 * Claims about the web tier: who can see what, and what students are shown
 * when data goes stale.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { buildRegistryFromLocationDocuments } from '../src/edge/registry.js';
import { parseCookies, RateLimiter, Sessions, turnstileCheck, UserStore } from '../src/web/auth.js';
import { createWebApp, loadWebConfig, missingAppAssets, safeNext } from '../src/web/main.js';
import { isSnapshot, SnapshotStore } from '../src/web/store.js';
import { SnapshotPublishers } from '../src/web/publishers.js';
import { FilePublishedModelStore } from '../src/web/published-model-store.js';
import { findGroup, searchSeats } from '../src/shared/seats.js';
import type { OccupancySnapshot, TableShape, TableState } from '../src/shared/types.js';
import { tableBounds } from '../src/shared/table-geometry.js';
import { makerspace } from './fixtures.js';

const TOKEN = 'edge-token-for-tests-0123456789';

test('web: publisher tokens cannot impersonate another edge or publish an unauthorized floor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publishers-'));
  const generatedForA = 'location_edge-a_00000000-0000-4000-8000-000000000001';
  const generatedAssetId = '00000000-0000-4000-8000-000000000010';
  const bytes = makeGlb({ asset: { version: '2.0' }, buffers: [] });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const web = createWebApp({ port: 0, host: '127.0.0.1', pushToken: TOKEN,
    publishers: new SnapshotPublishers({ version: 1, edges: {
      'edge-a': { token: '11'.repeat(32), floors: ['iw-maker-a'] },
      'edge-b': { token: '22'.repeat(32), floors: ['location_library', generatedForA] },
    } }),
    sessionSecret: Buffer.alloc(40, 1), usersPath: join(directory, 'users.json'),
    allowedDomains: [], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30000 });
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const push = (body: OccupancySnapshot, token: string) => fetch(`${base}/api/edge/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const upload = (locationId: string, token: string, edgeId = 'edge-a') => fetch(`${base}/api/edge/location-assets/${encodeURIComponent(locationId)}/${generatedAssetId}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-tm-edge-id': edgeId, 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary' }, body: bytes,
  });
  try {
    assert.equal((await push(snapshot('edge-a'), '11'.repeat(32))).status, 200);
    assert.equal((await push(snapshot('edge-b'), '11'.repeat(32))).status, 401);
    assert.equal((await push(snapshot('edge-b'), '22'.repeat(32))).status, 403);
    assert.equal((await push(snapshot('edge-a'), TOKEN)).status, 401);
    assert.equal((await upload('location_edge-a_00000000-0000-4000-8000-000000000002', '11'.repeat(32))).status, 201,
      'a generated floor is accepted for its authenticated edge');
    assert.equal((await upload('location_edge-a_00000000-0000-4000-8000-000000000002', '22'.repeat(32), 'edge-b')).status, 403,
      'another edge cannot upload into the generated namespace');
    assert.equal((await upload(generatedForA, '11'.repeat(32))).status, 403,
      'an explicit owner globally blocks the matching namespace exception');
    assert.equal((await upload(generatedForA, '22'.repeat(32), 'edge-b')).status, 200,
      'the explicit owner can upload; the globally immutable asset is already present from the prior accepted transfer');
    assert.equal((await upload('location_edge-a_not-a-uuid', '11'.repeat(32))).status, 403,
      'malformed dynamic IDs are denied');
    assert.equal((await upload('location_edge-a_00000000-0000-4000-8000-000000000003', TOKEN)).status, 401,
      'key-file mode does not fall back to the shared token');
  } finally {
    web.server.closeAllConnections();
    await web.dispose();
    await new Promise<void>(r => web.server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web: explicit floor ownership takes precedence over generated edge namespaces', () => {
  const generatedForA = 'location_edge-a_00000000-0000-4000-8000-000000000001';
  const publishers = new SnapshotPublishers({ version: 1, edges: {
    'edge-a': { token: '11'.repeat(32), floors: [] },
    'edge-b': { token: '22'.repeat(32), floors: ['location_library', generatedForA] },
  } });
  assert.equal(publishers.authorizesFloor('edge-a', generatedForA), false, 'explicit ownership blocks the matching implicit namespace');
  assert.equal(publishers.authorizesFloor('edge-b', generatedForA), true, 'the explicit owner remains authorized');
  assert.equal(publishers.authorizesFloor('edge-a', 'location_edge-a_00000000-0000-4000-8000-000000000002'), true);
  assert.equal(publishers.authorizesFloor('edge-b', 'location_edge-a_00000000-0000-4000-8000-000000000002'), false);
  assert.equal(publishers.authorizesFloor('edge-a', 'location_edge-a_extra_00000000-0000-4000-8000-000000000002'), false);
  assert.equal(publishers.authorizesFloor('edge-a', 'location_edge-a_not-a-uuid'), false);
  assert.equal(publishers.authorizesFloor('edge-b', 'location_library'), true);
  assert.equal(publishers.authorizesFloor('edge-a', 'location_library'), false);
  assert.equal(publishers.authenticate('edge-a', Buffer.from(TOKEN)), false, 'keyfile mode has no shared-token fallback');
});

test('web: uploaded models are immutable and student reads follow only the current winning snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'published-models-'));
  const usersPath = join(directory, 'users.json');
  const modelsPath = join(directory, 'published-models');
  const cfg = {
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath, publishedModelsDir: modelsPath,
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  };
  const bytes = makeGlb({ asset: { version: '2.0' }, buffers: [] });
  const changedBytes = makeGlb({ asset: { version: '2.0', generator: 'other' }, buffers: [] });
  const assetId = '00000000-0000-4000-8000-000000000091';
  const legacyAssetId = '00000000-0000-4000-8000-000000000092';
  let web = createWebApp(cfg);
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const cookie = await signup(base, 'model-reader@connect.hku.hk');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    assert.equal((await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } })).status, 404);
    const legacyUpload = await fetch(`${base}/api/edge/location-assets/location_library/${legacyAssetId}`, {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a', 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary',
      }, body: bytes,
    });
    assert.equal(legacyUpload.status, 201, 'shared-token mode retains existing legacy floor-ID acceptance');
    const upload = await fetch(`${base}/api/edge/location-assets/iw-maker-a/${assetId}`, {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a', 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary',
      }, body: bytes,
    });
    assert.equal(upload.status, 201);
    const retry = await fetch(`${base}/api/edge/location-assets/iw-maker-a/${assetId}`, {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a', 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary',
      }, body: bytes,
    });
    assert.equal(retry.status, 200, 'same ID and bytes are idempotent');
    const conflict = await fetch(`${base}/api/edge/location-assets/iw-maker-a/${assetId}`, {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a',
        'x-tm-sha256': createHash('sha256').update(changedBytes).digest('hex'), 'content-type': 'model/gltf-binary',
      }, body: changedBytes,
    });
    assert.equal(conflict.status, 409, 'different bytes never overwrite an immutable ID');

    const current = version2Snapshot();
    current.floors[0]!.model!.assetId = assetId;
    const pushed = await fetch(`${base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(current),
    });
    assert.equal(pushed.status, 200);
    const visible = await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } });
    assert.equal(visible.status, 200);
    assert.equal(visible.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(visible.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(visible.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await visible.arrayBuffer()), bytes);

    writeFileSync(join(modelsPath, `${assetId}.glb`), changedBytes);
    assert.equal((await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } })).status, 503,
      'a structurally valid file changed after durable ingest fails the stored digest/length check');

    const noModel = await fetch(`${base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(snapshot()),
    });
    assert.equal(noModel.status, 200);
    assert.equal((await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } })).status, 404);
  } finally {
    web.server.closeAllConnections();
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
  }

  web = createWebApp({ ...cfg, signupOpen: false });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const restarted = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${restarted}/api/models/${assetId}`, { headers: { cookie } })).status, 404,
      'persistent bytes do not become readable until a current snapshot references them after restart');
    const current = version2Snapshot();
    current.floors[0]!.model!.assetId = assetId;
    assert.equal((await fetch(`${restarted}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(current),
    })).status, 200);
    assert.equal((await fetch(`${restarted}/api/models/${assetId}`, { headers: { cookie } })).status, 503,
      'restarting the receiver does not adopt changed bytes as a new trusted digest');
  } finally {
    web.server.closeAllConnections();
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web: furniture refs authorize globally keyed bytes only while at least one current composite winner references them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'published-furniture-authority-'));
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('f'.repeat(40)),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const cookie = await signup(base, 'furniture-reader@connect.hku.hk');
  const assetId = '00000000-0000-4000-8000-000000000095';
  const bytes = makeGlb({ asset: { version: '2.0', generator: 'published-shared-furniture' }, buffers: [] });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const upload = () => fetch(`${base}/api/edge/location-assets/location_edge-a_00000000-0000-4000-8000-000000000095/${assetId}`, {
    method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a', 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary' }, body: bytes,
  });
  const push = (snapshotValue: OccupancySnapshot) => fetch(`${base}/api/edge/snapshot`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(snapshotValue),
  });
  const furnitureSnapshot = () => {
    const value = version2Snapshot();
    value.version = 3;
    value.floors[0]!.model = null;
    value.floors[0]!.tables[0]!.furnitureOverrides = {
      chair: { assetId, scale: 1.5, yawDeg: -45, elevationM: 0.1 },
    };
    return value;
  };
  try {
    assert.equal((await upload()).status, 201);
    const first = furnitureSnapshot();
    assert.equal(isSnapshot(first), true);
    assert.equal((await push(first)).status, 200);
    const visible = await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } });
    assert.equal(visible.status, 200, 'an override reference authorizes shared furniture GLB bytes through the existing student route');
    assert.deepEqual(Buffer.from(await visible.arrayBuffer()), bytes);

    const secondSite = structuredClone(first);
    secondSite.edgeId = 'edge-b';
    secondSite.site = { id: 'site-b', name: 'Other site' };
    assert.equal((await push(secondSite)).status, 200);
    const withdrawnFirst = structuredClone(first);
    withdrawnFirst.generatedAt += 1;
    delete withdrawnFirst.floors[0]!.tables[0]!.furnitureOverrides;
    assert.equal((await push(withdrawnFirst)).status, 200);
    assert.equal((await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } })).status, 200,
      'another composite current winner continues to authorize the globally keyed asset');

    const withdrawnSecond = structuredClone(secondSite);
    withdrawnSecond.generatedAt += 1;
    delete withdrawnSecond.floors[0]!.tables[0]!.furnitureOverrides;
    assert.equal((await push(withdrawnSecond)).status, 200);
    assert.equal((await fetch(`${base}/api/models/${assetId}`, { headers: { cookie } })).status, 404,
      'once no current winning floor references the furniture, stored bytes are unreadable');
  } finally {
    web.server.closeAllConnections();
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web: legacy published GLBs are inventoried once and receipt loss fails closed after cutover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'published-model-integrity-baseline-'));
  const modelsPath = join(directory, 'published-models');
  const bytes = makeGlb({ asset: { version: '2.0', generator: 'legacy-stored-model' }, buffers: [] });
  const changedBytes = makeGlb({ asset: { version: '2.0', generator: 'changed-after-baseline' }, buffers: [] });
  const assetId = '00000000-0000-4000-8000-000000000094';
  const digest = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(modelsPath, { recursive: true });
  writeFileSync(join(modelsPath, `${assetId}.glb`), bytes);
  try {
    const firstBoot = new FilePublishedModelStore(modelsPath);
    assert.deepEqual(await firstBoot.read(assetId), { bytes, sha256: digest },
      'first boot validates and records the current legacy file before serving it');
    assert.equal(readFileSync(join(modelsPath, '.integrity-baseline-v1'), 'utf8'), '{"schemaVersion":1}');
    assert.deepEqual(JSON.parse(readFileSync(join(modelsPath, `${assetId}.meta`), 'utf8')), { sha256: digest, byteLength: bytes.byteLength });

    unlinkSync(join(modelsPath, `${assetId}.meta`));
    const secondBoot = new FilePublishedModelStore(modelsPath);
    await assert.rejects(secondBoot.read(assetId), /durable metadata/,
      'once the cutover marker exists, a missing receipt is never silently adopted on read');
    assert.equal(await secondBoot.put(assetId, digest, bytes), 'already-present',
      'an authenticated retry repairs only an unreceipted file that matches its supplied digest and length');
    assert.deepEqual(await secondBoot.read(assetId), { bytes, sha256: digest });

    writeFileSync(join(modelsPath, `${assetId}.glb`), changedBytes);
    await assert.rejects(new FilePublishedModelStore(modelsPath).read(assetId), /do not match their durable metadata/,
      'a later process still detects changed valid GLB bytes against the baseline receipt');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('web: integrity baseline waits for a live initializer and recovers an exact stale owner lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'published-model-baseline-lock-'));
  const lockPath = join(directory, '.integrity-baseline-v1.lock');
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['-e', [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { randomUUID } = require('node:crypto');",
      "const lock = path.join(process.argv[1], '.integrity-baseline-v1.lock');",
      "fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 });",
      "process.stdout.write('lock-ready\\n');",
      "process.stdin.once('data', () => { fs.unlinkSync(lock); process.stdout.write('lock-released\\n'); });",
    ].join(' '), directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    await waitForChildText(child, 'lock-ready');
    let initializationFinished = false;
    const waitingInitialization = new FilePublishedModelStore(directory).ensureInitialized().then(() => { initializationFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(initializationFinished, false, 'a live foreign owner keeps startup behind the baseline barrier');
    child.stdin?.end('release');
    await waitingInitialization;
    await waitForChildExit(child);
    child = undefined;
    assert.equal(readFileSync(join(directory, '.integrity-baseline-v1'), 'utf8'), '{"schemaVersion":1}');
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.lock.tmp')), false,
      'successful initialization removes its temporary hardlink');

    unlinkSync(join(directory, '.integrity-baseline-v1'));
    const deadOwner = spawn(process.execPath, ['-e', "process.stdout.write(String(process.pid))"], { stdio: ['ignore', 'pipe', 'pipe'] });
    const deadOwnerPid = Number(await readChildOutput(deadOwner));
    await waitForChildExit(deadOwner);
    writeFileSync(lockPath, JSON.stringify({ pid: deadOwnerPid, nonce: '00000000-0000-4000-8000-000000000001' }), { mode: 0o600 });
    await new FilePublishedModelStore(directory).ensureInitialized();
    assert.equal(readFileSync(join(directory, '.integrity-baseline-v1'), 'utf8'), '{"schemaVersion":1}',
      'a dead process owner is reclaimed and the inventory barrier completes');
    assert.equal(readdirSync(directory).includes('.integrity-baseline-v1.lock'), false, 'the stale lock is removed');
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.lock.tmp')), false, 'stale recovery leaves no temporary hardlinks');
  } finally {
    if (child && child.exitCode === null) {
      child.stdin?.end('release');
      child.kill();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web: model authorization is rechecked after the asynchronous byte read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'published-model-race-'));
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('r'.repeat(40)),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const cookie = await signup(base, 'winner-race@connect.hku.hk');
  const assetId = '00000000-0000-4000-8000-000000000093';
  const bytes = makeGlb({ asset: { version: '2.0' }, buffers: [] });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const originalRead = FilePublishedModelStore.prototype.read;
  let markReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  try {
    const upload = await fetch(`${base}/api/edge/location-assets/iw-maker-a/${assetId}`, {
      method: 'PUT', headers: {
        authorization: `Bearer ${TOKEN}`, 'x-tm-edge-id': 'edge-a', 'x-tm-sha256': digest, 'content-type': 'model/gltf-binary',
      }, body: bytes,
    });
    assert.equal(upload.status, 201);
    const current = version2Snapshot();
    current.floors[0]!.model = { assetId, transform: current.floors[0]!.model!.transform };
    assert.equal((await fetch(`${base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(current),
    })).status, 200);
    FilePublishedModelStore.prototype.read = async function (requestedId) {
      assert.equal(requestedId, assetId);
      markReadStarted();
      await readGate;
      return { bytes: Buffer.from(bytes), sha256: digest };
    };
    const responsePromise = fetch(`${base}/api/models/${assetId}`, { headers: { cookie } });
    await readStarted;
    const withdrawn = structuredClone(current);
    withdrawn.generatedAt += 1;
    withdrawn.floors[0]!.model = null;
    assert.equal((await fetch(`${base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(withdrawn),
    })).status, 200);
    releaseRead();
    assert.equal((await responsePromise).status, 404, 'a descriptor withdrawn while disk bytes were loading is not sent to the student');
  } finally {
    FilePublishedModelStore.prototype.read = originalRead;
    releaseRead?.();
    web.server.closeAllConnections();
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start() {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  return {
    ...web,
    base,
    close: async () => {
      await web.dispose();
      await new Promise<void>((resolve) => web.server.close(() => resolve()));
    },
  };
}

/** What an edge publishes: public floors only (see EdgeRuntime.publicSnapshot). */
function snapshot(edgeId = 'edge-a'): OccupancySnapshot {
  const s = new OccupancyEngine(makerspace(), edgeId).snapshot(Date.now());
  return { ...s, floors: s.floors.filter((f) => f.id === 'iw-maker-a') };
}

function version2Snapshot(shape?: TableShape): OccupancySnapshot {
  const current = structuredClone(snapshot());
  current.version = 2;
  const floor = current.floors[0];
  assert.ok(floor);
  const table = floor.tables[0];
  assert.ok(table);
  const tableShape = shape ?? { type: 'rect', x: table.rect.x, y: table.rect.y, width: table.rect.width, height: table.rect.height };
  table.shape = tableShape;
  table.rect = tableBounds(tableShape);
  floor.model = {
    assetId: '00000000-0000-4000-8000-000000000001',
    transform: {
      scale: { x: 1, y: 1, z: 1 },
      rotationDeg: { x: 0, y: 15, z: 0 },
      positionM: { x: 0, y: 0.2, z: 0 },
    },
  };
  return current;
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

test('snapshot store separates same-ID floors by site and preserves latest-receipt handoff semantics', () => {
  const store = new SnapshotStore(30_000);
  const first = snapshot('edge-first');
  first.site = { id: 'site-a', name: 'Site A' };
  store.put(first, 1_000);

  const olderSameSite = structuredClone(first);
  olderSameSite.edgeId = 'edge-older';
  store.put(olderSameSite, 900);

  const otherSite = snapshot('edge-other-site');
  otherSite.site = { id: 'site-b', name: 'Site B' };
  store.put(otherSite, 1_100);

  let floors = store.view(1_200).floors;
  assert.equal(floors.length, 2, 'equal floor IDs at different sites remain separate');
  assert.equal(floors.find((floor) => floor.siteId === 'site-a')?.edgeId, 'edge-first');
  assert.equal(floors.find((floor) => floor.siteId === 'site-b')?.edgeId, 'edge-other-site');
  assert.equal(new Set(floors.map((floor) => floor.key)).size, 2);

  floors = store.view(40_000).floors;
  const staleWinner = floors.find((floor) => floor.siteId === 'site-a');
  assert.equal(staleWinner?.edgeId, 'edge-first', 'viewing later does not promote an older stored loser');
  assert.equal(staleWinner?.stale, true);
  assert.ok(staleWinner?.tables.every((table) => table.status === 'unknown' && table.free === null));

  const laterHandoff = structuredClone(olderSameSite);
  laterHandoff.generatedAt += 1;
  store.put(laterHandoff, 41_000);
  assert.equal(store.view(41_100).floors.find((floor) => floor.siteId === 'site-a')?.edgeId, 'edge-older',
    'a newly received snapshot from the previous loser can become the winner');
});

test('snapshot v2 accepts explicit no-model while v1 still rejects the model extension', () => {
  const authored2d = version2Snapshot();
  authored2d.floors[0]!.model = null;
  assert.equal(isSnapshot(authored2d), true);

  const legacy = snapshot();
  legacy.version = 1;
  Object.assign(legacy.floors[0]!, { model: null });
  assert.equal(isSnapshot(legacy), false);
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
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
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

test('web: v2 snapshot ingress preserves strict shape and model fields while keeping v1 compatible', async () => {
  const legacy = snapshot();
  const current = version2Snapshot();
  assert.equal(isSnapshot(legacy), true, 'legacy publishers remain accepted');
  assert.equal(isSnapshot(current), true, 'v2 geometry and model fields are accepted');
  assert.equal(isSnapshot(version2Snapshot({ type: 'circle', cx: 300, cy: 300, radius: 40 })), true, 'bounded circle geometry is accepted');
  assert.equal(isSnapshot(version2Snapshot({ type: 'polygon', points: [[200, 200], [300, 200], [300, 300], [200, 300]] })), true, 'simple polygon geometry is accepted');
  const withoutShape = structuredClone(current);
  delete withoutShape.floors[0]!.tables[0]!.shape;
  assert.equal(isSnapshot(withoutShape), true, 'v2 shape remains optional for compatible senders');
  const withoutModel = structuredClone(current);
  delete withoutModel.floors[0]!.model;
  assert.equal(isSnapshot(withoutModel), true, 'v2 model remains optional for compatible senders');

  const legacyOutOfBounds = structuredClone(legacy);
  legacyOutOfBounds.floors[0]!.tables[0]!.rect.x = 1_000_000;
  assert.equal(isSnapshot(legacyOutOfBounds), true, 'v1 retains its prior geometry validation behavior');
  const legacySeatOutsideFloor = structuredClone(legacy);
  legacySeatOutsideFloor.floors[0]!.tables[0]!.seats[0]!.x = 1_000_000;
  assert.equal(isSnapshot(legacySeatOutsideFloor), true, 'v1 retains its prior seat-coordinate validation behavior');
  const legacyDegenerateFloorPolygon = structuredClone(legacy);
  legacyDegenerateFloorPolygon.floors[0]!.outline = [[0, 0], [1, 1], [2, 2]];
  assert.equal(isSnapshot(legacyDegenerateFloorPolygon), true, 'v1 retains its prior polygon validation behavior');
  const legacyV2Envelope = structuredClone(legacy);
  legacyV2Envelope.version = 2;
  const legacyV2Floor = legacyV2Envelope.floors[0]!;
  legacyV2Floor.outline = [[0, 0], [1, 1], [2, 2]];
  legacyV2Floor.zones[0]!.polygon = [[-10, -10], [legacyV2Floor.width + 10, -10], [legacyV2Floor.width + 10, legacyV2Floor.height + 10]];
  legacyV2Floor.tables[0]!.rect.x = 1_000_000;
  legacyV2Floor.tables[0]!.seats[0]!.x = 1_000_000;
  assert.equal(isSnapshot(legacyV2Envelope), true, 'shape-less v2 snapshots preserve the existing geometry envelope');

  const legacyWithV2Fields = structuredClone(current);
  legacyWithV2Fields.version = 1;
  assert.equal(isSnapshot(legacyWithV2Fields), false, 'v1 cannot smuggle fields that belong to v2');

  const invalidSnapshots: [string, OccupancySnapshot][] = [
    ['zero-area polygon', version2Snapshot({ type: 'polygon', points: [[0, 0], [1, 1], [2, 2]] })],
    ['self-intersecting polygon', version2Snapshot({ type: 'polygon', points: [[0, 0], [4, 0], [1, 4], [3, 0], [4, 4]] })],
    ['polygon beyond the canonical point limit', version2Snapshot({ type: 'polygon', points: Array.from({ length: 257 }, (_, index): [number, number] => [200 + 100 * Math.cos(index * 2 * Math.PI / 257), 200 + 100 * Math.sin(index * 2 * Math.PI / 257)]) })],
  ];
  const outOfFloorRectangle = structuredClone(current);
  outOfFloorRectangle.floors[0]!.tables[0]!.shape = { type: 'rect', x: -1, y: 200, width: 50, height: 50 };
  invalidSnapshots.push(['out-of-floor rectangle shape', outOfFloorRectangle]);
  const outOfFloorCircle = structuredClone(current);
  outOfFloorCircle.floors[0]!.tables[0]!.shape = { type: 'circle', cx: 10, cy: 200, radius: 20 };
  invalidSnapshots.push(['out-of-floor circle shape', outOfFloorCircle]);
  const outOfFloorPolygon = structuredClone(current);
  outOfFloorPolygon.floors[0]!.tables[0]!.shape = { type: 'polygon', points: [[-1, 0], [10, 0], [10, 10]] };
  invalidSnapshots.push(['out-of-floor polygon shape', outOfFloorPolygon]);
  const mismatchedBounds = structuredClone(current);
  mismatchedBounds.floors[0]!.tables[0]!.rect.x += 1;
  invalidSnapshots.push(['shape and compatibility rect mismatch', mismatchedBounds]);
  const unknownShapeKey = structuredClone(current);
  unknownShapeKey.floors[0]!.tables[0]!.shape = { type: 'rect', x: 200, y: 200, width: 50, height: 50, privateField: true } as unknown as TableShape;
  invalidSnapshots.push(['unknown shape key', unknownShapeKey]);
  const outOfFloorRectWithoutShape = structuredClone(current);
  delete outOfFloorRectWithoutShape.floors[0]!.tables[0]!.shape;
  outOfFloorRectWithoutShape.floors[0]!.tables[0]!.rect.x = 1_000_000;
  assert.equal(isSnapshot(outOfFloorRectWithoutShape), true, 'shape-less v2 rects keep established envelope behavior');
  const outOfFloorSeat = structuredClone(current);
  outOfFloorSeat.floors[0]!.tables[0]!.seats[0]!.x = outOfFloorSeat.floors[0]!.width + 1;
  invalidSnapshots.push(['out-of-floor seat coordinate', outOfFloorSeat]);

  for (const [label, invalid] of invalidSnapshots) assert.equal(isSnapshot(invalid), false, `v2 rejects ${label}`);

  const invalidModelValues: [string, (snapshot: OccupancySnapshot) => void][] = [
    ['scale above maximum', (value) => { value.floors[0]!.model!.transform.scale.x = 10001; }],
    ['scale below minimum', (value) => { value.floors[0]!.model!.transform.scale.x = 0.0000001; }],
    ['rotation above maximum', (value) => { value.floors[0]!.model!.transform.rotationDeg.y = 3601; }],
    ['rotation below minimum', (value) => { value.floors[0]!.model!.transform.rotationDeg.y = -3601; }],
    ['position above maximum', (value) => { value.floors[0]!.model!.transform.positionM.z = 100001; }],
    ['position below minimum', (value) => { value.floors[0]!.model!.transform.positionM.z = -100001; }],
    ['non-finite model vector', (value) => { value.floors[0]!.model!.transform.positionM.x = Number.POSITIVE_INFINITY; }],
  ];
  for (const [label, mutate] of invalidModelValues) {
    const invalid = structuredClone(current);
    mutate(invalid);
    assert.equal(isSnapshot(invalid), false, `v2 rejects ${label}`);
  }

  const w = await start();
  try {
    const accepted = await fetch(`${w.base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(current),
    });
    assert.equal(accepted.status, 200, 'the existing edge ingress accepts a v2 publication');
    const stored = w.store.view().floors.find((floor) => floor.id === current.floors[0]?.id);
    assert.deepEqual(stored?.tables[0]?.shape, current.floors[0]?.tables[0]?.shape);
    assert.deepEqual(stored?.model, current.floors[0]?.model);

    for (const invalid of [invalidSnapshots[0]![1], (() => {
      const invalid = structuredClone(current);
      invalid.floors[0]!.model!.transform.scale.x = 10001;
      return invalid;
    })()]) {
      const rejected = await fetch(`${w.base}/api/edge/snapshot`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400, 'malformed v2 geometry and model transforms are rejected by the live route');
    }

    const stale = w.store.view(Date.now() + 31_000).floors.find((floor) => floor.id === current.floors[0]?.id);
    assert.deepEqual(stale?.tables[0]?.shape, current.floors[0]?.tables[0]?.shape);
    assert.deepEqual(stale?.model, current.floors[0]?.model, 'stale-state blanking preserves public model metadata');
  } finally { await w.close(); }
});

test('web: strict v3 snapshot ingress preserves only complete furniture references while v1/v2 stay unchanged', async () => {
  const current = version2Snapshot();
  const v3 = structuredClone(current);
  v3.version = 3;
  v3.floors[0]!.furnitureDefaults = { table: { assetId: '00000000-0000-4000-8000-000000000096', scale: 1, yawDeg: 0, elevationM: 0 } };
  v3.floors[0]!.tables[0]!.furnitureOverrides = { chair: { assetId: '00000000-0000-4000-8000-000000000097', scale: 2, yawDeg: 90, elevationM: 0.5 } };
  assert.equal(isSnapshot(v3), true);

  const v2WithFurniture = structuredClone(current);
  v2WithFurniture.floors[0]!.furnitureDefaults = structuredClone(v3.floors[0]!.furnitureDefaults);
  assert.equal(isSnapshot(v2WithFurniture), false, 'v2 cannot accept v3-only floor keys');
  const v1WithFurniture = structuredClone(snapshot());
  v1WithFurniture.floors[0]!.furnitureDefaults = structuredClone(v3.floors[0]!.furnitureDefaults);
  assert.equal(isSnapshot(v1WithFurniture), false, 'v1 cannot accept v3-only floor keys');

  const invalid: OccupancySnapshot[] = [];
  for (const change of [
    (value: OccupancySnapshot) => { value.floors[0]!.furnitureDefaults = {}; },
    (value: OccupancySnapshot) => { value.floors[0]!.furnitureDefaults = { table: { assetId: '00000000-0000-4000-8000-000000000096', scale: 1, yawDeg: 0 } } as never; },
    (value: OccupancySnapshot) => { value.floors[0]!.furnitureDefaults = { table: { assetId: '00000000-0000-4000-8000-000000000096', scale: 101, yawDeg: 0, elevationM: 0 } }; },
    (value: OccupancySnapshot) => { value.floors[0]!.furnitureDefaults = { table: { assetId: '00000000-0000-4000-8000-000000000096', scale: 1, yawDeg: 0, elevationM: 0 }, private: {} } as never; },
    (value: OccupancySnapshot) => { value.floors[0]!.tables[0]!.furnitureOverrides = null as never; },
  ]) {
    const value = structuredClone(v3);
    change(value);
    invalid.push(value);
  }
  for (const value of invalid) assert.equal(isSnapshot(value), false, 'v3 rejects empty, partial, out-of-range, unknown, and null furniture assignments');

  const web = await start();
  try {
    const accepted = await fetch(`${web.base}/api/edge/snapshot`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(v3),
    });
    assert.equal(accepted.status, 200);
    const campusFloor = web.store.view().floors[0];
    assert.deepEqual(campusFloor?.furnitureDefaults, v3.floors[0]!.furnitureDefaults);
    assert.deepEqual(campusFloor?.tables[0]?.furnitureOverrides, v3.floors[0]!.tables[0]!.furnitureOverrides);
    const stale = web.store.view(Date.now() + 31_000).floors[0];
    assert.deepEqual(stale?.furnitureDefaults, v3.floors[0]!.furnitureDefaults, 'stale occupancy blanking retains safe render references');
  } finally { await web.close(); }
});

test('web: emitted v2 snapshots keep legacy zones and perimeter seats without synthesized shapes', () => {
  const site = {
    site: { id: 'legacy-site', name: 'Legacy site' },
    floors: [{
      id: 'legacy-floor', building: 'Legacy building', name: 'Legacy floor', width: 100, height: 100,
      outline: [[0, 0], [100, 0], [100, 100]],
      zones: [{ id: 'legacy-zone', name: 'Legacy zone', polygon: [[-10, -10], [110, -10], [100, 100]] }],
      tables: [{ id: 'legacy-table', name: 'Legacy table', zone: 'legacy-zone', x: 0, y: 20, width: 30, height: 40, capacity: 2 }],
    }],
  };
  const registry = buildRegistryFromLocationDocuments(site, { nodes: [] }, []);
  const table = registry.floors[0]?.tables[0];
  assert.ok(table);
  assert.equal(table.shapeAuthored, false);
  assert.ok(table.seats.some((seat) => seat.x === -35), 'the legacy table has its generated perimeter seat outside the floor');

  const emitted = new OccupancyEngine(registry, 'legacy-edge').snapshot(1234);
  const floor = emitted.floors[0];
  assert.equal(emitted.version, 2);
  assert.ok(floor);
  assert.deepEqual(floor.zones[0]?.polygon, [[-10, -10], [110, -10], [100, 100]]);
  assert.ok(floor.tables[0]?.seats.some((seat) => seat.x === -35));
  assert.equal(Object.hasOwn(floor.tables[0]!, 'shape'), false, 'a synthesized legacy rectangle has no authored shape tag');
  assert.equal(isSnapshot(emitted), true, 'the actual edge-emitted v2 snapshot remains within the legacy envelope');
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

test('web: site-scoped seat search requires the floor ID and resolves duplicate floor IDs by site', async () => {
  const w = await start();
  try {
    const cookie = await signup(w.base, 'composite-search@connect.hku.hk');
    const first = snapshot('edge-search-a');
    const second = snapshot('edge-search-b');
    first.site = { id: 'site-a', name: 'Site A' };
    second.site = { id: 'site-b', name: 'Site B' };
    first.floors[0]!.id = 'shared-room';
    second.floors[0]!.id = 'shared-room';
    assert.equal(w.store.put(first), true);
    assert.equal(w.store.put(second), true);

    const siteWithoutFloor = await fetch(`${w.base}/api/search?seats=1&siteId=site-a`, { headers: { cookie } });
    assert.equal(siteWithoutFloor.status, 400);
    assert.deepEqual(await siteWithoutFloor.json(), { error: 'siteId and floor must be valid identifiers and supplied together' });

    const ambiguous = await fetch(`${w.base}/api/search?seats=1&floor=shared-room`, { headers: { cookie } });
    assert.equal(ambiguous.status, 409);

    const scoped = await fetch(`${w.base}/api/search?seats=1&floor=shared-room&siteId=site-b`, { headers: { cookie } });
    assert.equal(scoped.status, 200);
    const body = await scoped.json() as { results: { siteId: string; floorId: string; key: string }[] };
    assert.ok(body.results.every((result) => result.siteId === 'site-b' && result.floorId === 'shared-room'));
  } finally { await w.close(); }
});

test('with WEB_PORT unset or empty, the web tier listens on 8080, where the edge, compose and production expect it', () => {
  const env = { WEB_PUSH_TOKEN: 'x'.repeat(20), SESSION_SECRET: 'y'.repeat(40) };
  assert.equal(loadWebConfig(env).port, 8080);
  assert.equal(loadWebConfig({ ...env, WEB_PORT: '' }).port, 8080);
  assert.equal(loadWebConfig({ ...env, WEB_PORT: '9090' }).port, 9090);
});

function makeGlb(root: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(root), 'utf8');
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const output = Buffer.alloc(20 + jsonLength, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}

function waitForChildText(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Child process did not write ${expected}.`)), 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (!output.includes(expected)) { clearTimeout(timer); reject(new Error(`Child exited before writing ${expected} (code ${code}).`)); }
    });
  });
}

function readChildOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stdout?.once('end', () => resolve(output));
    child.once('error', reject);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(`Child exited with code ${child.exitCode}.`));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Child exited with code ${code}.`)));
  });
}
