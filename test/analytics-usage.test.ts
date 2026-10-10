/**
 * Claims about usage metering on the student web tier: what is counted, who
 * may read it, and that nothing which names a student is kept or sent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { sanitizeUsageReport, WebUsageClient } from '../src/infrastructure/analytics/web-usage-client.js';
import { routeGroup, UsageMeter } from '../src/modules/analytics/application/usage-meter.js';
import type { StudentUsageReport } from '../src/shared/analytics.js';
import { createWebApp, loadWebConfig } from '../src/web/main.js';
import { SnapshotPublishers } from '../src/web/publishers.js';
import { makerspace } from './fixtures.js';

const TOKEN = 'edge-token-for-tests-0123456789';
const EMAIL = 'u3512345@connect.hku.hk';

async function start(t: { after(fn: () => Promise<void>): void }, publishers?: SnapshotPublishers) {
  const directory = mkdtempSync(join(tmpdir(), 'tm-usage-web-'));
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: TOKEN, publishers, sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(directory, 'users.json'), allowedDomains: ['connect.hku.hk'], signupOpen: true,
    cookieSecure: false, trustProxy: false, staleMs: 30_000, analyticsDir: join(directory, 'analytics-web'),
  });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await web.dispose();
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
  };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const snapshot = new OccupancyEngine(makerspace(), 'edge-a').snapshot(Date.now());
  snapshot.floors = snapshot.floors.filter((floor) => floor.id === 'iw-maker-a');
  const report = (range: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    fetch(`${base}/api/edge/usage?range=${range}`, { headers });
  return { ...web, base, directory, snapshot, report, close };
}

async function signup(base: string): Promise<string> {
  const response = await fetch(`${base}/signup`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, name: 'Chan Tai Man', password: 'correct horse battery' }),
  });
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

test('usage: paths are counted under a handful of names, never as typed', () => {
  assert.equal(routeGroup('GET', '/api/occupancy'), 'occupancy');
  assert.equal(routeGroup('GET', '/api/search'), 'search');
  assert.equal(routeGroup('POST', '/api/activity'), 'activity');
  assert.equal(routeGroup('POST', '/login'), 'sign-in');
  assert.equal(routeGroup('GET', '/login/'), 'pages');
  assert.equal(routeGroup('GET', '/auth/google/callback'), 'sign-in');
  assert.equal(routeGroup('GET', '/dashboard/spaces/iw-maker-a'), 'pages');
  assert.equal(routeGroup('GET', '/app/index-ClwD1oYR.js'), 'assets');
  assert.equal(routeGroup('GET', '/wp-admin/setup'), 'other');
  // The edge and health probes are machines, and are left out of student traffic.
  assert.equal(routeGroup('POST', '/api/edge/snapshot'), 'edge');
  assert.equal(routeGroup('GET', '/healthz'), 'health');
});

test('usage: the report answers to the edge token and to nothing a student holds', async (t) => {
  const web = await start(t);
  const cookie = await signup(web.base);
  assert.ok(cookie.startsWith('tm_session='));
  assert.equal((await web.report('24h', {})).status, 401);
  assert.equal((await web.report('24h', { cookie })).status, 401, 'a signed-in student is not the edge');
  assert.equal((await web.report('24h', { authorization: 'Bearer wrong-token-of-the-same-size!!' })).status, 401);
  assert.equal((await web.report('24h', { authorization: 'Bearer ' })).status, 401);
  assert.equal((await web.report('yesterday')).status, 400);
  const ok = await web.report('24h');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  // Reading is all it offers.
  assert.equal((await fetch(`${web.base}/api/edge/usage?range=24h`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
});

test('usage: with per-edge credentials only a registered, unrevoked edge may read the report', async (t) => {
  const web = await start(t, new SnapshotPublishers({ version: 1, edges: {
    'edge-a': { token: '11'.repeat(32), floors: ['iw-maker-a'] }, 'edge-old': { token: '22'.repeat(32), floors: [], revoked: true },
  } }));
  const read = (edgeId: string, token: string) => fetch(`${web.base}/api/edge/usage?range=1h&edgeId=${edgeId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await read('edge-a', '11'.repeat(32))).status, 200);
  assert.equal((await read('edge-a', TOKEN)).status, 401, 'the shared token is ignored once a registry exists');
  assert.equal((await read('edge-b', '11'.repeat(32))).status, 401);
  assert.equal((await read('edge-old', '22'.repeat(32))).status, 401);
});

test('usage: what students do is counted once each, and one student is one active student', async (t) => {
  const web = await start(t);
  const cookie = await signup(web.base);
  web.store.put(web.snapshot);
  const floor = web.snapshot.floors[0]!, table = floor.tables[0]!;
  const act = (body: unknown) => fetch(`${web.base}/api/activity`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-tm-student-activity': '1' }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${web.base}/api/occupancy`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${web.base}/api/occupancy`, { headers: { cookie } })).status, 200);
  assert.equal((await act({ action: 'seat-search', seats: 2, floorId: floor.id })).status, 202);
  assert.equal((await act({ action: 'seat-search', seats: 8 })).status, 202);
  assert.equal((await act({ action: 'space-view', seats: 2, floorId: floor.id })).status, 202);
  assert.equal((await act({ action: 'table-select', seats: 2, floorId: floor.id, tableId: table.id })).status, 202);
  assert.equal((await act({ action: 'table-select', seats: 2, floorId: floor.id, tableId: 'no-such-table' })).status, 400);
  // A wrong password, and a snapshot push from the edge.
  await fetch(`${web.base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'not the password' }) });
  await fetch(`${web.base}/api/edge/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(web.snapshot) });
  web.usage.sample();

  const report = await (await web.report('24h')).json() as StudentUsageReport;
  assert.equal(report.version, 1);
  assert.equal(report.timezone, 'Asia/Hong_Kong');
  assert.equal(report.active.today, 1, 'six requests from one account are one student');
  assert.equal(report.active.last7Days, 1);
  assert.equal(report.accounts.total, 1);
  assert.equal(report.accounts.createdPerDay?.at(-1)?.total, 1);
  assert.equal(report.accounts.createdPerDay?.at(-1)?.created, 1);
  assert.equal(report.totals.searches, 2);
  assert.equal(report.totals.spaceViews, 1);
  assert.equal(report.totals.tableSelects, 1, 'the refused selection is not counted');
  assert.equal(report.totals.signUps, 1);
  assert.equal(report.totals.failedSignIns, 1);
  assert.equal(report.totals.signIns, 0);
  assert.deepEqual(report.partySizes.filter((p) => p.searches > 0), [{ seats: '2', searches: 1 }, { seats: '6+', searches: 1 }]);
  assert.deepEqual(report.topFloors, [{ floorId: floor.id, name: floor.name, views: 1 }]);
  assert.deepEqual(report.topTables, [{ floorId: floor.id, tableId: table.id, name: table.name, selects: 1 }]);
  assert.equal(report.previousTotals, null, 'there is no earlier period to compare with yet, and it does not pretend there is');
  // signup + 2 occupancy + 5 activity posts + 1 login; the edge's push is not student traffic.
  assert.equal(report.totals.requests, 9);
  assert.equal(report.totals.clientErrors, 2);
  assert.deepEqual(report.routeGroups.map((g) => g.group).sort(), ['activity', 'occupancy', 'sign-in']);
  assert.equal(report.activity.series.find((s) => s.key === 'act.seat-search.succeeded')?.values.reduce((a, b) => a + b, 0), 2);
  assert.equal(report.online.series[0]?.values.at(-1), 0, 'nobody has the live view open, and the sampler says so');
  assert.equal(report.process.accountStorage, 'file');
  assert.deepEqual(report.process.edges.map((e) => e.edgeId), ['edge-a']);
});

test('usage: neither the report nor the files behind it can name a student', async (t) => {
  const web = await start(t);
  const cookie = await signup(web.base);
  web.store.put(web.snapshot);
  await fetch(`${web.base}/api/occupancy`, { headers: { cookie } });
  web.usage.sample();
  const body = await (await web.report('30d')).text();
  const users = JSON.parse(readFileSync(join(web.directory, 'users.json'), 'utf8')) as { id: string; email: string; name: string }[];
  const secrets = [EMAIL, 'u3512345', 'Chan Tai Man', users[0]!.id, TOKEN, 's'.repeat(40)];
  for (const secret of secrets) assert.ok(!body.includes(secret), `the report must not contain "${secret.slice(0, 12)}"`);
  await web.close();
  const dir = join(web.directory, 'analytics-web');
  const files = readdirSync(dir);
  assert.ok(files.length > 0, 'history is kept so a deploy does not empty the charts');
  const kept = files.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
  for (const secret of secrets) assert.ok(!kept.includes(secret), `no file may contain "${secret.slice(0, 12)}"`);
  assert.match(kept, /"ids":\["[0-9a-f]{16}"\]/, 'what is kept per student is a keyed hash');
});

test('usage: a restart keeps today\'s counts and today\'s active students', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-usage-meter-'));
  let now = Date.UTC(2026, 9, 10, 4, 0, 0);
  const options = { dir, timeZone: 'Asia/Hong_Kong', secret: Buffer.alloc(32, 3), live: () => ({ sockets: 2, emails: ['a@x.hk', 'a@x.hk'] }), now: () => now };
  const context = { accountsTotal: 5, accountCreatedTimes: null, accountStorage: 'file' as const, floorName: () => null, tableName: () => null, edges: [] };
  const first = new UsageMeter(options);
  first.event('seat-search', 'succeeded', { seats: 3, resultCount: 0, liveData: false });
  first.event('login', 'rate-limited');
  first.event('made-up-action', 'succeeded');
  first.request('GET', '/api/occupancy', 200, 12, 'b@x.hk');
  first.sample();
  await first.close();
  now += 120_000;
  const second = new UsageMeter(options);
  second.sample();
  const report = second.report('24h', context);
  assert.equal(report.totals.searches, 1);
  assert.equal(report.totals.noResultSearches, 1);
  assert.equal(report.totals.staleDataSearches, 1);
  assert.equal(report.totals.rateLimitedSignIns, 1);
  assert.equal(report.totals.requests, 1);
  assert.equal(report.active.today, 2, 'one by request, one with the live view open; two tabs are one student');
  assert.equal(report.live.students, 1);
  assert.equal(report.live.sockets, 2);
  assert.equal(report.accounts.total, 5);
  assert.equal(report.accounts.createdPerDay, null, 'a store that cannot list creation times leaves the history unknown');
  await second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('usage: a fault in the counting is swallowed -- it must never become a failed request for a student', () => {
  let broken = false;
  const meter = new UsageMeter({
    dir: null, timeZone: 'Asia/Hong_Kong', secret: Buffer.alloc(32, 4),
    live: () => { if (broken) throw new Error('socket registry gone'); return { sockets: 0, emails: [] }; },
    now: () => { if (broken) throw new Error('clock gone'); return Date.UTC(2026, 9, 10, 4, 0, 0); },
  });
  meter.event('login', 'succeeded');
  broken = true;
  assert.doesNotThrow(() => meter.request('GET', '/api/occupancy', 200, 5, 'a@x.hk'));
  assert.doesNotThrow(() => meter.event('seat-search', 'succeeded', { seats: 2 }));
  assert.doesNotThrow(() => meter.sample());
  assert.equal(meter.faults, 3);
  broken = false;
  meter.event('login', 'succeeded');
  assert.equal(meter.report('1h', { accountsTotal: null, accountCreatedTimes: null, accountStorage: 'file', floorName: () => null, tableName: () => null, edges: [] }).totals.signIns, 2);
});

test('usage: the edge rebuilds what it receives, so a malformed report cannot reach a browser as-is', async (t) => {
  assert.equal(sanitizeUsageReport(null), null);
  assert.equal(sanitizeUsageReport({ version: 2 }), null);
  const hostile = sanitizeUsageReport({
    version: 1, generatedAt: 5, range: { id: '24h', from: 1, to: 5 }, timezone: 'x'.repeat(500),
    live: { sockets: -4, students: 'many' }, accounts: { total: Infinity }, active: { perDay: [{ day: '<script>', students: 1 }, { day: '2026-10-10', students: 3 }] },
    totals: { searches: 'DROP TABLE' }, online: { times: [1, 2, 3], stepMs: 1, series: [{ key: 'k', label: 'l', values: [1] }] },
    topFloors: Array.from({ length: 500 }, () => ({ floorId: 'f', name: 'n', views: 1 })), process: { email: 'leak@x.hk' }, extra: { email: 'leak@x.hk' },
  });
  assert.ok(hostile);
  assert.equal(hostile.timezone.length, 64);
  assert.deepEqual(hostile.live, { sockets: 0, students: 0 });
  assert.equal(hostile.accounts.total, 0);
  assert.deepEqual(hostile.active.perDay, [{ day: '2026-10-10', students: 3 }]);
  assert.equal(hostile.totals.searches, 0);
  assert.deepEqual(hostile.online.series[0]?.values, [1, null, null], 'a short series is padded with gaps, not shifted');
  assert.equal(hostile.topFloors.length, 12);
  assert.ok(!JSON.stringify(hostile).includes('leak@x.hk'), 'fields the edge does not know are dropped');

  const web = await start(t);
  const client = new WebUsageClient([web.base], TOKEN, 'edge-a');
  assert.equal((await client.read('1h')).range.id, '1h');
  await assert.rejects(new WebUsageClient([web.base], 'wrong-token-of-the-same-size!!', 'edge-a').read('1h'), /HTTP 401/);
  assert.equal(new WebUsageClient([], TOKEN, 'edge-a').configured, false);
});

test('usage: the site time zone is validated at start-up and history is kept beside the account file', () => {
  const env = { WEB_PUSH_TOKEN: TOKEN, SESSION_SECRET: 's'.repeat(40), DATA_DIR: '/var/lib/tmedge' };
  assert.throws(() => loadWebConfig({ ...env, ANALYTICS_TIMEZONE: 'Hong Kong' }), /ANALYTICS_TIMEZONE/);
  const cfg = loadWebConfig(env);
  assert.equal(cfg.analyticsTimeZone, 'Asia/Hong_Kong');
  assert.equal(cfg.analyticsDir, join('/var/lib/tmedge', 'analytics-web'));
  assert.equal(loadWebConfig({ ...env, ANALYTICS_TIMEZONE: 'Europe/London' }).analyticsTimeZone, 'Europe/London');
});
