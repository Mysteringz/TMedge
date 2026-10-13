/**
 * Claims about who a firmware record names. An update reaches every sensor
 * on a floor, so "who built this image" and "who started, or stopped, this
 * rollout" have to be answerable afterwards. Each account signed in to the
 * algo console is named on what it did; the standalone console has one
 * shared password and nobody to name, so there the answer is "console".
 *
 * Everything runs through HTTP, the way module 04 does it. Only the compiler
 * is faked: the worker "builds" fixed bytes and the store promotes them as it
 * would a real image.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { createConsole, startConsole } from '../src/edge/console.js';
import { buildRegistry } from '../src/edge/registry.js';
import type { EdgeRuntime } from '../src/edge/runtime.js';
import { FirmwareStoreExecutor } from '../src/infrastructure/firmware-build/firmware-store-executor.js';
import { FirmwareBuildJobs } from '../src/modules/firmware/application/firmware-build-jobs.js';
import { identity, KEY, nodesJson, report, siteJson } from './fixtures.js';

interface FirmwareView {
  builds: { id: string; uploadedBy: string }[];
  rollout: { startedBy: string; stage: string; note: string } | null;
}
type Call = (path: string, init?: { method?: string; body?: string | Buffer; type?: string }) => Promise<Response>;

function runtime(): EdgeRuntime {
  const cfg: EdgeConfig = {
    edgeId: 'actor-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', persistenceMode: 'file', postgres: null,
    dataDir: mkdtempSync(join(tmpdir(), 'tmedge-actor-')), recordRaw: false,
    consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
  };
  return createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

function builds(rt: EdgeRuntime): FirmwareBuildJobs {
  return new FirmwareBuildJobs(new FirmwareStoreExecutor(rt.firmware, {
    build: async () => ({ exitCode: 0, artifact: Buffer.from('a firmware image'), log: [] }),
    dispose: async () => {},
  }));
}

/** One sensor with an open session of its own, so a rollout has somewhere to go and nothing leaves the machine. */
function oneSensorOnline(rt: EdgeRuntime): string {
  const uid = [...rt.reg.nodes.keys()][0];
  assert.ok(uid);
  const session = { uid, sessionId: 'test-session', key: KEY, send: () => true, grantOta: () => true, admit: () => null };
  assert.equal(rt.ingest.handle(report(identity(uid), [], 1), { kind: 'direct', address: `ws:${uid}:test-session`, session }).ok, true);
  return uid;
}

/** Upload a project and build it as `builder`, start a rollout as `starter`, stop it as `stopper`. */
async function updateOnce(rt: EdgeRuntime, builder: Call, starter: Call, stopper: Call): Promise<{ uploadedBy: string; startedBy: string; note: string }> {
  const uid = oneSensorOnline(rt);
  const view = async () => await (await builder('/api/firmware')).json() as FirmwareView;

  const started = await builder('/api/firmware/uploads', { method: 'POST' });
  assert.equal(started.status, 200, await started.clone().text());
  const { uploadId } = await started.json() as { uploadId: string };
  const file = await builder(`/api/firmware/uploads/${uploadId}/files?path=platformio.ini`, {
    method: 'POST', body: Buffer.from('[env:tmflash]\n'), type: 'application/octet-stream',
  });
  assert.equal(file.status, 200, await file.clone().text());
  assert.equal((await builder(`/api/firmware/uploads/${uploadId}/build`, { method: 'POST' })).status, 202);
  let built = await view();
  for (let waited = 0; built.builds.length === 0 && waited < 200; waited++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    built = await view();
  }
  const build = built.builds[0];
  assert.ok(build, 'the build finished');

  const rollout = await starter('/api/firmware/rollout', {
    method: 'POST', body: JSON.stringify({ buildId: build.id, target: { kind: 'node', uid } }), type: 'application/json',
  });
  assert.equal(rollout.status, 200, await rollout.clone().text());
  const running = (await view()).rollout;
  assert.equal(running?.stage, 'pilot', 'the rollout is still running when it is stopped');
  assert.equal((await stopper('/api/firmware/rollout/cancel', { method: 'POST' })).status, 200);
  const stopped = (await view()).rollout;
  assert.equal(stopped?.stage, 'stopped');
  return { uploadedBy: build.uploadedBy, startedBy: running.startedBy, note: stopped.note };
}

test('an image and a rollout name the account that built, started and stopped them', async () => {
  const rt = runtime();
  const usersPath = join(rt.cfg.dataDir, 'algo-users.json');
  const users = new AlgoUsers(usersPath);
  for (const name of ['alice', 'bob', 'carol']) await users.add(name, 'a long test password', 'engineer');
  const handle = startAlgo(rt, 0, '127.0.0.1',
    loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, rt.cfg.adminPassword),
    createConsole(rt, { firmwareBuildJobs: builds(rt) }));
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  const as = async (username: string): Promise<Call> => {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'a long test password' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return (path, init = {}) => fetch(`${base}/console-app${path}`, {
      method: init.method, body: init.body,
      headers: { cookie, 'x-tm-console': '1', ...(init.type ? { 'content-type': init.type } : {}) },
    });
  };
  try {
    // Three people, so a name that only followed whoever acted first or last would be caught.
    assert.deepEqual(await updateOnce(rt, await as('alice'), await as('bob'), await as('carol')), {
      uploadedBy: 'algo:alice', startedBy: 'algo:bob', note: 'cancelled by algo:carol',
    });
  } finally {
    await handle.dispose();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await rt.stop();
  }
});

test('the standalone console has one shared password, so its records say console', async () => {
  const rt = runtime();
  const server = startConsole(rt, { firmwareBuildJobs: builds(rt) });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Whatever is typed as the username is not an identity: only the password is checked.
  const call: Call = (path, init = {}) => fetch(`${base}${path}`, {
    method: init.method, body: init.body,
    headers: {
      authorization: `Basic ${Buffer.from('alice:admin-pass').toString('base64')}`,
      'x-tm-console': '1', ...(init.type ? { 'content-type': init.type } : {}),
    },
  });
  try {
    assert.deepEqual(await updateOnce(rt, call, call, call), {
      uploadedBy: 'console', startedBy: 'console', note: 'cancelled by console',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
  }
});
