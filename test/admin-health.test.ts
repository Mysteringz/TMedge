import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { ReadOperationalHealth } from '../src/modules/algo-admin/use-cases/read-operational-health.js';
import type { OperationalQueries } from '../src/modules/algo-admin/repositories/operational-queries.js';
import { RuntimeOperationalQueries } from '../src/infrastructure/algo-admin/runtime-operational-queries.js';
import { projectFirmware } from '../src/infrastructure/algo-admin/project-firmware-health.js';
import { createHealthRouter } from '../src/modules/algo-admin/controllers/health-controller.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { KEY, nodesJson, siteJson, identity, report } from './fixtures.js';
import { JobStore, type TrainJob } from '../src/algo/train/store.js';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createConsole } from '../src/edge/console.js';

function query(): OperationalQueries {
  return { sensors: () => ({ total: 0, offline: 0, unknown: 0, rows: [] }), training: () => null,
    firmware: () => null, parameters: () => ({ total: 0, rows: [] }) };
}
test('health isolates errors, distinguishes disabled from zero and forwards only current owner', async () => {
  const queries = query(); let owner = '';
  queries.training = (name) => { owner = name; return { total: 0, failed: 0, rows: [] }; };
  queries.sensors = () => { throw new Error('secret path/key'); };
  const result = await new ReadOperationalHealth(queries, () => 100).execute('alice');
  assert.equal(owner, 'alice'); assert.equal(result.generatedAt, 100);
  assert.deepEqual(result.sensors, { state: 'unavailable', observedAt: null, staleAfterMs: 15000, data: null });
  assert.equal(result.training.state, 'available'); assert.equal(result.firmware.state, 'disabled');
  assert.equal(result.parameters.data?.total, 0); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('a hung source times out independently and subsequent polling cannot accumulate queries', async () => {
  let calls = 0;
  const queries = query(); queries.training = () => { calls++; return new Promise(() => undefined); };
  const useCase = new ReadOperationalHealth(queries);
  const result = await useCase.execute('alice');
  assert.equal(result.training.state, 'unavailable'); assert.equal(result.sensors.state, 'available');
  await useCase.execute('alice'); assert.equal(calls, 1);
});
function cfg(dataDir: string): EdgeConfig {
  return { edgeId: 'health-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
}
function job(user: string, status: TrainJob['status'], updatedAt: number): TrainJob {
  return { id: `${user}-${updatedAt}`, user, status, updatedAt, createdAt: updatedAt, submittedAt: null, startedAt: null, endedAt: null,
    lastPolledAt: null, slurmJobId: null, remoteDir: 'PRIVATE', exitCode: null, slurmState: null, elapsedSeconds: null, node: 'PRIVATE', message: 'PRIVATE', sbatch: 'PRIVATE',
    code: { kind: 'py', filename: 'PRIVATE', bytes: 1, sha256: 'PRIVATE', unpackedBytes: 1, fileCount: 1, py: [] },
    spec: { name: 'job name', partition: 'cpu', cpusPerTask: 1, memGb: 1, gpus: 0, timeLimit: '1:00:00', modules: [], condaEnv: null, entrypoint: 'PRIVATE', args: [], env: {}, notifyEmail: false } };
}
test('runtime adapter keeps report freshness separate, bounds rows, uses owner-only jobs and sanitizes pending values', async () => {
  const runtime = createEdgeRuntime(cfg(mkdtempSync(join(tmpdir(), 'tm-health-'))), buildRegistry(siteJson(), nodesJson()));
  try {
    const uid = [...runtime.reg.nodes.keys()][0]; assert.ok(uid);
    runtime.ingest.handle(report(identity(uid), [], 1), '192.168.1.9:9000');
    const fresh = runtime.nodes(Date.now()).find((n) => n.uid === uid); assert.ok(fresh?.reportReceivedAt);
    assert.equal(fresh.online, true);
    const jobs = [job('alice', 'RUNNING', 500), ...Array.from({ length: 30 }, (_, n) => job('alice', 'FAILED', n)), job('bob', 'FAILED', 999)];
    const adapter = new RuntimeOperationalQueries({ runtime, listJobs: (owner) => jobs.filter((j) => j.user === owner),
      broker: { changes: () => [{ uid, nodeId: 'secret', param: 'fps', binding: 'device', from: 3, to: 4, at: 2, revertAt: 10,
        confirmedAt: null, cmdSeq: 4, restoring: true }] } });
    const sensors = adapter.sensors(fresh.reportReceivedAt + 10001);
    assert.ok(sensors.offline > 0); assert.ok(sensors.unknown >= 0);
    assert.equal(sensors.rows.find((n) => n.uid === uid)?.reportReceivedAt, fresh.reportReceivedAt);
    const training = adapter.training('alice'); assert.equal(training?.total, 31); assert.equal(training?.failed, 30);
    assert.equal(training?.rows.length, 10); assert.equal(training?.rows[0]?.status, 'FAILED');
    assert.ok(training?.rows.every((j) => !j.id.startsWith('bob')));
    const output = JSON.stringify({ sensors, training, parameters: adapter.parameters() });
    for (const privateValue of ['192.168.1.9', 'PRIVATE', 'cmdSeq', 'nodeId', '"from"', '"to"']) assert.ok(!output.includes(privateValue));
    assert.equal(adapter.parameters().rows[0]?.restoring, true);
  } finally { await runtime.stop(); }
});
test('firmware projection preserves historical completion and uncertain recovery without raw details', () => {
  const rollout = { id: 'r', version: 'v1', stage: 'stopped', startedAt: 1, finishedAt: 2, recoveryState: 'interrupted',
    note: 'PRIVATE', nodes: Array.from({ length: 25 }, (_, i) => ({ uid: String(i), label: 'sensor', state: i === 0 ? 'failed' : 'confirmed',
      percent: 100, updatedAt: 2, outcomeUncertain: i === 0, address: 'PRIVATE', error: 'PRIVATE' })) };
  const result = projectFirmware({ startedAt: 1, lifecycle: 'interrupted', error: 'PRIVATE', log: ['PRIVATE'] }, null, [rollout]);
  assert.equal(result.build.state, 'failed'); assert.equal(result.rollout?.finishedAt, 2); assert.equal(result.rollout?.interrupted, true);
  assert.equal(result.rollout?.uncertain, 1); assert.equal(result.rollout?.rows.length, 20); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.throws(() => projectFirmware({}, null, []));
  assert.throws(() => projectFirmware({ startedAt: 9e15 }, null, []));
});
test('malformed persisted job and parameter timestamps isolate sources instead of crashing Home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-health-invalid-'));
  const bad = { ...job('alice', 'FAILED', 1), id: '11111111-1111-4111-8111-111111111111', updatedAt: undefined };
  writeFileSync(join(root, 'jobs.json'), JSON.stringify([bad]));
  const store = new JobStore(root);
  assert.equal(store.error, null, 'legacy store accepts missing timestamp');
  const runtime = createEdgeRuntime(cfg(root), buildRegistry(siteJson(), nodesJson()));
  try {
    const adapter = new RuntimeOperationalQueries({ runtime, listJobs: (owner) => store.list(owner),
      broker: { changes: () => [{ uid: 'a', nodeId: 'a', param: 'fps', binding: 'device', from: 1, to: 2, at: 1,
        revertAt: 9e15, confirmedAt: null, cmdSeq: null }] } });
    const result = await new ReadOperationalHealth(adapter).execute('alice');
    assert.equal(result.training.state, 'unavailable'); assert.equal(result.parameters.state, 'unavailable');
    assert.equal(result.sensors.state, 'available');
    const invalidRemote = { ...job('alice', 'RUNNING', 10), lastPolledAt: -1 };
    assert.throws(() => new RuntimeOperationalQueries({ runtime, listJobs: () => [invalidRemote], broker: { changes: () => [] } }).training('alice'));
  } finally { await runtime.stop(); }
});
test('controller reads are allowed for each role, deny missing authority and owner cannot be supplied by query', async () => {
  const app = express(); let owner = '';
  app.use((req, res, next) => { const name = req.get('x-test-principal'); if (name) res.locals.principal = name === 'denied' ? { ...principal(name, 'viewer'), capabilities: [] } : principal(name, name === 'admin' ? 'admin' : name === 'engineer' ? 'engineer' : 'viewer'); next(); });
  const queries = query(); queries.training = (name) => { owner = name; return null; };
  app.use('/api/admin/health', createHealthRouter(new ReadOperationalHealth(queries)));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/health`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { 'x-test-principal': 'denied' } })).status, 403);
    for (const role of ['viewer', 'engineer', 'admin']) {
      const response = await fetch(`${base}?owner=bob`, { headers: { 'x-test-principal': role } });
      assert.equal(response.status, 200); assert.equal(owner, role); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
test('composed authenticated endpoint uses live sources for every role and rejects old disabled sessions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-health-api-')), usersPath = join(dataDir, 'users.json');
  const previousDataDir = process.env.DATA_DIR, previousHpcConfig = process.env.HPC_CONFIG;
  process.env.DATA_DIR = dataDir; process.env.HPC_CONFIG = join(dataDir, 'hpc.json');
  writeFileSync(process.env.HPC_CONFIG, JSON.stringify({ verified: false, source: 'test', backend: 'none', partitions: [{ name: 'cpu', maxTime: '2-00:00:00', gpu: false }], defaultPartition: 'cpu', modules: [], maxUploadMb: 2, maxUnpackedMb: 4, quotaMb: 64 }));
  const jobRoot = join(dataDir, 'algo', 'train'); mkdirSync(jobRoot, { recursive: true });
  writeFileSync(join(jobRoot, 'jobs.json'), JSON.stringify(['viewer', 'engineer', 'admin', 'bob'].map((owner, i) => ({
    ...job(owner, 'FAILED', 10 + i), id: `11111111-1111-4111-8111-11111111111${i}`, spec: { ...job(owner, 'FAILED', 10).spec, name: `${owner} private job` },
  }))));
  const users = new AlgoUsers(usersPath);
  for (const role of ['viewer', 'engineer', 'admin'] as const) await users.add(role, 'a long test password', role);
  const runtime = createEdgeRuntime(cfg(dataDir), buildRegistry(siteJson(), nodesJson()));
  const core = createConsole(runtime);
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'x'.repeat(40), ALGO_USERS_FILE: usersPath }, 'test-only'), core);
  await new Promise<void>((done) => handle.server.once('listening', done));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/admin/health`)).status, 401);
    for (const role of ['viewer', 'engineer', 'admin']) {
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: role, password: 'a long test password' }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const response = await fetch(`${base}/api/admin/health?owner=bob`, { headers: { cookie } }); assert.equal(response.status, 200);
      const body = await response.json() as { data: { sensors: { state: string; data: { total: number; unknown: number } }; firmware: { state: string }; training: { data: { total: number; rows: { name: string }[] } } } };
      assert.equal(body.data.sensors.state, 'available'); assert.equal(body.data.sensors.data.total, runtime.nodes().length);
      assert.equal(body.data.sensors.data.unknown, runtime.nodes().length); assert.equal(body.data.firmware.state, 'available');
      assert.equal(body.data.training.data.total, 1); assert.equal(body.data.training.data.rows[0]?.name, `${role} private job`);
      if (role === 'viewer') { users.update(role, { disabled: true }); assert.equal((await fetch(`${base}/api/admin/health`, { headers: { cookie } })).status, 401); }
    }
  } finally {
    await handle.dispose(); await new Promise<void>((done) => handle.server.close(() => done())); await runtime.stop();
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    if (previousHpcConfig === undefined) delete process.env.HPC_CONFIG; else process.env.HPC_CONFIG = previousHpcConfig;
  }
});
