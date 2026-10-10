/**
 * Claims about the Analytics endpoint of the algo console (module 05): who
 * may read it, and that a source which has gone quiet is reported as unknown
 * instead of as nothing happening.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { AlgoUsers, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { createConsole } from '../src/edge/console.js';
import { buildRegistry } from '../src/edge/registry.js';
import type { DiskUsage } from '../src/infrastructure/analytics/host-probe.js';
import { HostProbe } from '../src/infrastructure/analytics/host-probe.js';
import { runtimeAnalyticsSource } from '../src/infrastructure/analytics/runtime-analytics-source.js';
import { WebUsageClient } from '../src/infrastructure/analytics/web-usage-client.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';
import { EdgeAnalyticsCollector, type EdgeAnalyticsSource } from '../src/modules/analytics/application/edge-analytics-collector.js';
import { ReadAnalytics } from '../src/modules/analytics/application/read-analytics.js';
import type { AnalyticsSnapshot, PipelineStatus } from '../src/modules/analytics/domain/analytics-snapshot.js';
import { createAnalyticsRouter } from '../src/modules/analytics/routes/analytics-router.js';
import { createWebApp } from '../src/web/main.js';
import { identity, KEY, nodesJson, report, siteJson } from './fixtures.js';

const TOKEN = 'edge-token-for-tests-0123456789';
const T0 = Date.UTC(2026, 9, 10, 4, 0, 0);
const GB = 1024 ** 3;

function cfg(dataDir: string, pushUrls: string[] = []): EdgeConfig {
  return { edgeId: 'analytics-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null,
    pushUrls, pushToken: pushUrls.length ? TOKEN : '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
}

const pipeline = (over: Partial<PipelineStatus> = {}): PipelineStatus => ({
  packetsPerSec: 12, bytesPerSec: 900, rejectedPerMin: 0, rejectReasons: [],
  nodes: { registered: 4, online: 4, real: 1, realOnline: 1 },
  publish: [{ target: '127.0.0.1:8080', ok: true, tried: true, lastOkAt: T0 }], gateways: 1, directSessions: null,
  recorder: { bytesToday: 5_000_000, rawEnabled: false, healthy: true }, ...over,
});

function harness(source: Partial<EdgeAnalyticsSource> = {}, extra: { usage?: ConstructorParameters<typeof ReadAnalytics>[0]['usage']; disks?: () => DiskUsage[]; hasDatabase?: boolean; shareMs?: number } = {}) {
  let now = T0;
  const collector = new EdgeAnalyticsCollector({
    pipeline: () => pipeline(), floors: () => [], databaseAvailable: null, ...source,
  }, {
    dataDir: tmpdir(), historyDir: null, now: () => now, host: new HostProbe(() => null),
    disks: async () => extra.disks?.() ?? [{ id: 'system', label: 'System and data volume', path: '/', totalBytes: 20 * GB, usedBytes: 10 * GB, freeBytes: 10 * GB, usedPercent: 50 }],
  });
  const read = new ReadAnalytics({
    collector, usage: extra.usage ?? null, units: { supported: false, read: async () => null }, directoryUsage: { read: () => null },
    identity: { edgeId: 'analytics-test', version: '1.0.0', release: null, persistence: 'file', hasDatabase: extra.hasDatabase ?? false },
    timeZone: 'Asia/Hong_Kong', now: () => now, shareMs: extra.shareMs ?? 0,
  });
  return { collector, read, advance: (ms: number) => { now += ms; }, now: () => now };
}

const last = (values: (number | null)[] | undefined) => values?.[values.length - 1];

test('analytics: a floor no sensor is covering is unknown on the tile and a gap on the chart, never empty', async () => {
  const runtime = createEdgeRuntime(cfg(mkdtempSync(join(tmpdir(), 'tm-an-rt-'))), buildRegistry(siteJson(), nodesJson()));
  try {
    const source = runtimeAnalyticsSource(runtime);
    const silent = source.floors(Date.now());
    assert.ok(silent.length > 0);
    for (const floor of silent) {
      assert.equal(floor.unknownSeats, floor.seats, 'nothing has reported yet');
      assert.equal(floor.occupied, null, 'so "seats taken" has no value, not 0');
      assert.equal(floor.free, null);
    }
    const h = harness({ floors: () => silent });
    await h.collector.sample();
    const quiet = await h.read.execute('1h');
    assert.equal(last(quiet.occupancy.data?.occupancy.series.at(-1)?.values), null);
    assert.ok(quiet.occupancy.data?.weekly.values.flat().every((cell) => cell === null));

    // One sensor reports an empty room: its tables are now known, and known to be free.
    const uid = [...runtime.reg.nodes.keys()][0]!;
    // Enough frames for the seats to be decided; until then the table is still unknown.
    const sensor = identity(uid);
    for (let frame = 1; frame <= 40; frame++) runtime.ingest.handle(report(sensor, [], frame), '192.168.1.9:9000');
    runtime.tick(Date.now());
    const seen = source.floors(Date.now());
    const covered = seen.find((floor) => floor.unknownSeats < floor.seats);
    assert.ok(covered, 'the reporting sensor covers some seats');
    assert.equal(covered.occupied, 0);
    const pipe = source.pipeline(Date.now());
    assert.equal(pipe.nodes.online, 1);
    assert.ok(pipe.nodes.registered > 1);
    assert.ok(!JSON.stringify(pipe).includes('192.168.1.9'), 'sensor addresses stay out of analytics');
  } finally { await runtime.stop(); }
});

test('analytics: the occupancy share is of the seats that are known, so an offline sensor does not lower it', async () => {
  const h = harness({ floors: () => [
    { id: 'a', name: 'Maker space A', seats: 60, occupied: 15, free: 15, unknownSeats: 30 },
    { id: 'b', name: 'Open Event Area', seats: 40, occupied: null, free: null, unknownSeats: 40 },
  ] });
  await h.collector.sample();
  const snapshot = await h.read.execute('1h');
  const series = Object.fromEntries((snapshot.occupancy.data?.occupancy.series ?? []).map((s) => [s.label, last(s.values)]));
  assert.deepEqual(series, { 'Maker space A': 50, 'Open Event Area': null, 'All floors': 50 });
  assert.equal(snapshot.occupancy.data?.weekly.values[5]?.[12], 50, 'Saturday 12:00 in Hong Kong');
  assert.equal(snapshot.occupancy.data?.weekly.days, 1);
});

test('analytics: a web tier that cannot be reached leaves usage unavailable while the host figures still arrive', async () => {
  const dead = new WebUsageClient(['http://127.0.0.1:9'], TOKEN, 'analytics-test', { timeoutMs: 300 });
  const h = harness({ pipeline: () => pipeline({ publish: [{ target: '127.0.0.1:9', ok: false, tried: true, lastOkAt: null }] }) }, { usage: dead });
  await h.collector.sample();
  h.advance(20_000);
  await h.collector.sample();
  const snapshot = await h.read.execute('1h');
  assert.deepEqual(snapshot.usage, { state: 'unavailable', observedAt: null, data: null }, 'no report is not a report of zero students');
  assert.equal(snapshot.host.state, 'available');
  assert.equal(snapshot.storage.data?.disks[0]?.usedPercent, 50);
  assert.equal(last(snapshot.charts.memory.series[0]?.values) !== null, true);
  const web = snapshot.services.data?.find((row) => row.id === 'web');
  assert.equal(web?.status, 'err');
  assert.equal(web?.days.at(-1)?.health, 'err', 'today is marked down for the web tier');
  assert.equal(snapshot.services.data?.find((row) => row.id === 'edge')?.days.at(-1)?.health, 'ok');
});

test('analytics: a restart is not an outage -- the first seconds, when nothing can have reported yet, are not recorded as zero', async () => {
  let online = 0, tried = false;
  const h = harness({ pipeline: () => pipeline({ nodes: { registered: 4, online, real: 1, realOnline: 0 }, packetsPerSec: online * 3, publish: [{ target: '127.0.0.1:8080', ok: tried, tried, lastOkAt: tried ? T0 : null }] }) });
  await h.collector.sample();
  const starting = await h.read.execute('1h');
  const row = (snapshot: AnalyticsSnapshot, id: string) => snapshot.services.data?.find((r) => r.id === id);
  assert.equal(row(starting, 'sensors')?.statusText, 'Starting up');
  assert.equal(row(starting, 'web')?.statusText, 'Starting up');
  assert.equal(row(starting, 'sensors')?.days.at(-1)?.health, 'none', 'no mark against today for a moment in which nothing could report');
  assert.equal(row(starting, 'web')?.days.at(-1)?.health, 'none');
  assert.equal(last(starting.charts.sensors.series[0]?.values), null);
  assert.equal(row(starting, 'edge')?.days.at(-1)?.health, 'ok', 'the edge itself is plainly up');
  online = 4; tried = true;
  h.advance(20_000);
  await h.collector.sample();
  const settled = await h.read.execute('1h');
  assert.equal(row(settled, 'sensors')?.status, 'ok');
  assert.equal(row(settled, 'web')?.days.at(-1)?.health, 'ok');
  assert.equal(row(settled, 'sensors')?.uptimePercent, 100);
  // And once it is warm, a real silence is recorded as one.
  online = 0;
  h.advance(10_000);
  await h.collector.sample();
  assert.equal(row(await h.read.execute('1h'), 'sensors')?.status, 'err');
});

test('analytics: what is not configured is disabled, and a day before collection began has no record rather than a good one', async () => {
  const h = harness({ pipeline: () => pipeline({ publish: [] }) });
  await h.collector.sample();
  const snapshot = await h.read.execute('24h');
  assert.equal(snapshot.usage.state, 'disabled');
  assert.equal(snapshot.units.state, 'disabled');
  const rows = Object.fromEntries((snapshot.services.data ?? []).map((row) => [row.id, row]));
  assert.equal(rows.web?.status, 'off');
  assert.equal(rows.database?.status, 'off');
  assert.equal(rows.database?.uptimePercent, null);
  assert.equal(rows.edge?.days.length, 30);
  assert.deepEqual(rows.edge?.days.slice(0, 29).map((d) => d.health), Array(29).fill('none'));
  assert.equal(rows.edge?.days.at(-1)?.day, '2026-10-10');
  assert.equal(snapshot.collectingSince, T0 - (T0 % 900_000));
  assert.equal(snapshot.storage.data?.breakdown, null, 'the directory scan has not finished; it is not shown as empty');
  assert.equal(snapshot.storage.data?.disks[0]?.daysUntilFull, null, 'no forecast from a single reading');
  assert.deepEqual(snapshot.charts.cpu.series.map((s) => s.label), ['Busy'], 'steal time cannot be measured here, so it is not charted');
});

test('analytics: the data volume forecast comes from its measured growth', async () => {
  let used = 10 * GB;
  const h = harness({}, { disks: () => [{ id: 'data', label: 'Data volume', path: '/var/lib/tmedge', totalBytes: 22 * GB, usedBytes: used, freeBytes: 22 * GB - used, usedPercent: used / (22 * GB) * 100 }] });
  // Twelve hours, a sample a minute, 0.35 GB written: 0.7 GB a day.
  for (let i = 0; i <= 720; i++) {
    await h.collector.sample();
    h.advance(60_000);
    used += 0.35 * GB / 720;
  }
  const disk = (await h.read.execute('24h')).storage.data?.disks[0];
  assert.ok(disk?.growthBytesPerDay);
  assert.ok(Math.abs(disk.growthBytesPerDay / GB - 0.7) < 0.05, `about 0.7 GB a day, got ${(disk.growthBytesPerDay / GB).toFixed(3)}`);
  assert.ok(disk.daysUntilFull !== null && Math.abs(disk.daysUntilFull - (22 * GB - used) / (0.7 * GB)) < 1.5);
});

test('analytics: a sample that fails is a missed point, not a stopped edge', async () => {
  let broken = true;
  const h = harness({ pipeline: () => { if (broken) throw new Error('registry mid-reload'); return pipeline(); } });
  await assert.doesNotReject(h.collector.sample());
  assert.equal(h.collector.faults, 1);
  assert.equal(h.collector.reading, null);
  assert.equal((await h.read.execute('1h')).host.state, 'unavailable', 'and until there is a reading the page says so');
  broken = false;
  h.advance(10_000);
  await h.collector.sample();
  assert.equal((await h.read.execute('1h')).host.state, 'available');
});

test('analytics: a database that hangs is reported down without stalling the sampler', async () => {
  const h = harness({ databaseAvailable: () => new Promise<boolean>(() => undefined) }, { hasDatabase: true });
  const started = Date.now();
  await h.collector.sample();
  assert.ok(Date.now() - started < 1000, 'the host sample does not wait for the database');
  assert.equal((await h.read.execute('1h')).services.data?.find((row) => row.id === 'database')?.statusText, 'Not checked yet');
  await new Promise((resolve) => setTimeout(resolve, 3200));
  h.advance(10_000);
  await h.collector.sample();
  assert.equal((await h.read.execute('1h')).services.data?.find((row) => row.id === 'database')?.status, 'err');
  await h.collector.stop();
});

test('analytics: several tabs on one range within two seconds cost the web tier one report, and a failure is not handed on', async () => {
  let reads = 0, fail = false;
  const usage = { configured: true, read: async () => { reads++; if (fail) throw new Error('down'); return (await import('../src/infrastructure/analytics/web-usage-client.js')).sanitizeUsageReport({ version: 1, generatedAt: T0, range: { id: '1h', from: T0 - 1, to: T0 } })!; } };
  const h = harness({}, { usage, shareMs: 2000 });
  await h.collector.sample();
  const [a, b] = await Promise.all([h.read.execute('1h'), h.read.execute('1h')]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  await h.read.execute('24h');
  assert.equal(reads, 2, 'another range is another page');
  h.advance(2500);
  fail = true;
  const down = await h.read.execute('1h');
  assert.equal(reads, 3, 'after two seconds it is asked again');
  assert.equal(down.usage.state, 'unavailable');
});

test('analytics: any signed-in role may read it; nobody else, and an account that changes mid-request gets nothing', async () => {
  const h = harness();
  await h.collector.sample();
  let revokeDuringRead = false, epoch = 'e1', calls = 0;
  const app = express();
  app.use('/api/analytics', createAnalyticsRouter({
    principalOf: (req) => {
      const name = (req as express.Request).get('x-test-principal');
      if (!name) return null;
      if (name === 'denied') return { ...principal(name, 'viewer'), capabilities: [] };
      return principal(name, name === 'admin' ? 'admin' : name === 'engineer' ? 'engineer' : 'viewer');
    },
    accountEpoch: () => epoch,
  }, { execute: async (range) => { calls++; const result = await h.read.execute(range); if (revokeDuringRead) epoch = 'e2'; return result; } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analytics`;
  const get = (query: string, who?: string) => fetch(`${base}${query}`, { headers: who ? { 'x-test-principal': who } : {} });
  try {
    assert.equal((await get('')).status, 401);
    assert.equal((await get('', 'denied')).status, 403);
    assert.equal(calls, 0, 'nothing is assembled for a caller who may not read it');
    for (const role of ['viewer', 'engineer', 'admin']) {
      const response = await get('?range=7d', role);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('content-encoding'), 'gzip', 'a page of charts is sent compressed');
      const body = await response.json() as { data: AnalyticsSnapshot; error: null };
      assert.equal(body.data.range.id, '7d');
      assert.equal(body.error, null);
    }
    assert.equal((await (await get('', 'viewer')).json() as { data: AnalyticsSnapshot }).data.range.id, '24h', 'a day is the default');
    const plain = await fetch(`${base}?range=1h`, { headers: { 'x-test-principal': 'viewer', 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null, 'and plainly to a client that did not ask for gzip');
    assert.equal((await plain.json() as { data: AnalyticsSnapshot }).data.range.id, '1h');
    assert.equal((await get('?range=forever', 'viewer')).status, 400);
    assert.equal((await get('?range=1h&range=7d', 'viewer')).status, 400);
    revokeDuringRead = true;
    const revoked = await get('?range=1h', 'viewer');
    assert.equal(revoked.status, 401);
    assert.deepEqual((await revoked.json() as { data: unknown }).data, null);
    // It reads; it offers nothing to write.
    assert.equal((await fetch(base, { method: 'POST', headers: { 'x-test-principal': 'admin' } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test('analytics: end to end, the console shows the web tier\'s own count of students and none of its secrets', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-an-e2e-'));
  const web = createWebApp({ port: 0, host: '127.0.0.1', pushToken: TOKEN, sessionSecret: Buffer.from('w'.repeat(40)),
    usersPath: join(dataDir, 'web', 'users.json'), allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000 });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const webBase = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const signup = await fetch(`${webBase}/signup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'u3599999@connect.hku.hk', name: 'Private Name', password: 'correct horse battery' }) });
  const studentCookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  await fetch(`${webBase}/api/occupancy`, { headers: { cookie: studentCookie } });

  const usersPath = join(dataDir, 'algo-users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('viewer', 'a long test password', 'viewer');
  const config = cfg(dataDir, [webBase]);
  const runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'a'.repeat(64), ALGO_USERS_FILE: usersPath, DATA_DIR: dataDir }, config.adminPassword), createConsole(runtime));
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/analytics`)).status, 401);
    assert.equal((await fetch(`${base}/analytics`, { redirect: 'manual' })).status, 302, 'the page itself is behind sign-in');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'a long test password' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    // The collector takes its first sample as the server starts; give it a moment to land.
    let snapshot: AnalyticsSnapshot | null = null;
    for (let i = 0; i < 40 && snapshot?.host.state !== 'available'; i++) {
      const response = await fetch(`${base}/api/analytics?range=1h`, { headers: { cookie } });
      assert.equal(response.status, 200);
      snapshot = (await response.json() as { data: AnalyticsSnapshot }).data;
      if (snapshot.host.state !== 'available') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(snapshot);
    assert.equal(snapshot.host.state, 'available');
    assert.ok((snapshot.host.data?.memory.totalBytes ?? 0) > 0);
    assert.ok((snapshot.host.data?.cores ?? 0) >= 1);
    assert.equal(snapshot.usage.state, 'available');
    assert.equal(snapshot.usage.data?.accounts.total, 1);
    assert.equal(snapshot.usage.data?.active.today, 1);
    assert.equal(snapshot.usage.data?.totals.signUps, 1);
    assert.equal(snapshot.process.data?.edgeId, 'analytics-test');
    assert.ok((snapshot.storage.data?.disks.length ?? 0) >= 1);
    const body = JSON.stringify(snapshot);
    for (const secret of ['u3599999', 'Private Name', TOKEN, 'w'.repeat(40), 'a'.repeat(64), 'test-only', 'a long test password']) {
      assert.ok(!body.includes(secret), `the page data must not contain "${secret.slice(0, 10)}"`);
    }
    // A viewer may read; the page offers nothing to write to.
    assert.equal((await fetch(`${base}/api/analytics`, { method: 'POST', headers: { cookie, 'x-tm-algo': '1' } })).status, 404);
  } finally {
    await handle.dispose();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await runtime.stop();
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
  }
  // History is on disk for the next start, and holds measurements only.
  const state = readFileSync(join(dataDir, 'analytics-edge', 'edge-minute.state.json'), 'utf8');
  assert.match(state, /"mem\.used"/);
  assert.ok(!state.includes(TOKEN));
  rmSync(dataDir, { recursive: true, force: true });
});
