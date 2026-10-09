// Local installed Chrome + Playwright fallback; no MCP browser claims.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { createConsole } from '../dist/src/edge/console.js';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { KEY, nodesJson, siteJson } from '../dist/test/fixtures.js';

const artifacts = resolve(process.env.HEALTH_ARTIFACT_DIR ?? '../.codex/docs/algo-admin-improvements/task-3-1-health-dashboard/artifacts');
mkdirSync(artifacts, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'tm-health-browser-')), usersPath = join(dataDir, 'users.json');
process.env.DATA_DIR = dataDir;
const users = new AlgoUsers(usersPath), password = randomBytes(18).toString('hex');
for (const role of ['viewer', 'engineer', 'admin']) await users.add(role, password, role);
const cfg = { edgeId: 'health-browser-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir,
  recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null, pushUrls: [], pushToken: '',
  publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson())), core = createConsole(runtime);
const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ALGO_USERS_FILE: usersPath }, cfg.adminPassword), core);
await new Promise((done) => handle.server.once('listening', done));
const base = `http://127.0.0.1:${handle.server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const evidence = [];
class HealthPage {
  constructor(page) { this.page = page; }
  async open() { await this.page.goto(base); await this.page.getByRole('heading', { name: 'System status', exact: true }).waitFor(); }
  refresh() { return this.page.getByRole('button', { name: 'Refresh system status', exact: true }); }
  async ready() { await this.refresh().waitFor(); }
  section(name) { return this.page.getByRole('region', { name, exact: true }); }
}
const section = (data, state = 'available', staleAfterMs = 15000) => ({ state, observedAt: state === 'available' ? Date.now() : null, staleAfterMs, data });
function issueSnapshot() {
  const now = Date.now();
  return { generatedAt: now,
    sensors: section({ total: 2, offline: 1, unknown: 1, rows: [{ uid: 'a', label: 'Offline sensor', floorId: 'floor-1', online: false, reportReceivedAt: now - 20000, statusReceivedAt: now - 120000 }, { uid: 'b', label: 'Never-seen sensor', floorId: null, online: false, reportReceivedAt: null, statusReceivedAt: null }] }),
    training: section({ total: 1, failed: 0, rows: [{ id: 'job-1', name: 'My stale job', status: 'RUNNING', updatedAt: now - 70000, lastPolledAt: now - 70000, endedAt: null, remoteObservationRequired: true }] }, 'available', 60000),
    firmware: section({ build: { state: 'idle', startedAt: null }, rollout: { id: 'r', version: '1.0', stage: 'done', startedAt: now - 90000000, finishedAt: now - 80000000, interrupted: false, total: 1, failed: 0, uncertain: 0, confirmed: 1, rows: [{ uid: 'a', label: 'Updated sensor', state: 'confirmed', percent: 100, updatedAt: now - 80000000, outcomeUncertain: false }] } }),
    parameters: section({ total: 1, rows: [{ uid: 'a', param: 'fps', binding: 'device', revertAt: now + 60000, confirmedAt: null, restoring: true }] }) };
}
try {
  for (const role of ['viewer', 'engineer', 'admin']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: role, password } })).status(), 200);
    const page = await context.newPage(), home = new HealthPage(page), errors = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url()); });
    await home.open(); await home.ready();
    await home.section('Sensors').getByText('No report received', { exact: false }).first().waitFor();
    assert.equal((await context.request.get(`${base}/api/admin/health`)).status(), 200);
    await home.refresh().click(); await page.getByRole('status').getByText('System status refreshed.', { exact: true }).waitFor();
    if (role === 'viewer') {
      await page.screenshot({ path: join(artifacts, 'viewer-real-health.png'), fullPage: true });
      let data = issueSnapshot(), status = 200, active = 0, peak = 0, reads = 0, hold = null;
      await page.route('**/api/admin/health', async (route) => {
        active++; peak = Math.max(peak, active); reads++;
        if (hold) await hold;
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data: status === 200 ? data : null, error: status === 200 ? null : { code: 'unavailable', message: 'unavailable' } }) }); active--;
      });
      await home.refresh().click(); await home.ready();
      await home.section('Sensors').getByText('STATUS data stale', { exact: false }).waitFor();
      await home.section('My training jobs').getByText('Remote status stale or not yet checked.', { exact: false }).waitFor();
      await home.section('Pending parameter reversions').getByText('Restoring previous value', { exact: false }).waitFor();
      assert.equal(await home.section('Firmware rollout').getByText('stale', { exact: false }).count(), 0);
      await page.screenshot({ path: join(artifacts, 'health-source-freshness.png'), fullPage: true });
      data = { ...data, sensors: section(null, 'unavailable'), training: section(null, 'disabled', 60000) };
      await home.refresh().click(); await home.ready();
      await home.section('Sensors').getByText('Sensors source unavailable.', { exact: false }).waitFor();
      await home.section('My training jobs').getByText('My training jobs source disabled.', { exact: false }).waitFor();
      assert.equal(await home.section('Sensors').getByText('No offline sensors.', { exact: true }).count(), 0);
      await page.screenshot({ path: join(artifacts, 'health-partial-unavailable.png'), fullPage: true });
      data = issueSnapshot(); await home.refresh().click(); await home.ready();
      let release; hold = new Promise((done) => { release = done; });
      await home.refresh().click();
      await page.getByRole('button', { name: 'Refreshing…', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Refreshing…', exact: true }).isDisabled(), true);
      await page.waitForTimeout(5500); assert.equal(peak, 1, 'no overlapping poll while request pending');
      release(); hold = null; await home.ready();
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenReads = reads; await page.waitForTimeout(5500); assert.equal(reads, hiddenReads, 'hidden dashboard does not poll');
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(400); assert.ok(reads > hiddenReads);
      status = 503; await home.refresh().click(); await home.ready();
      await page.evaluate(() => { const original = Date.now; Date.now = () => original() + 20000; });
      await page.getByText('Dashboard data is stale.', { exact: false }).waitFor();
      await home.section('Sensors').getByText('Offline sensor', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, 'health-retained-stale.png'), fullPage: true });
      await page.setViewportSize({ width: 360, height: 800 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifacts, 'health-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => { document.body.style.zoom = '2'; });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifacts, 'health-zoom-200.png'), fullPage: true });
      await home.refresh().focus(); await page.keyboard.press('ArrowDown');
      assert.equal(await home.refresh().evaluate((el) => document.activeElement === el), true);
      status = 401; await home.refresh().click(); await page.waitForURL('**/login**');
      assert.equal(await page.getByRole('heading', { name: 'System status', exact: true }).count(), 0);
      evidence.push({ fixtureChecks: ['distinct report/status freshness', 'remote active job stale', 'historical firmware completion', 'recovery pending', 'partial unavailable and disabled', 'single in-flight', 'hidden visibility pause/resume', 'retained stale snapshot', '360px and200% zoom', 'keyboard focus', '401 clears health'], peakConcurrentHealthRequests: peak });
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    evidence.push({ role, actualEndpoint: 200, readOnlyWrites: writes.length, pageErrors: errors });
    await context.close();
  }
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({ runner: 'local Playwright + installed Chrome', evidence }, null, 2));
  process.stdout.write('Health browser acceptance passed for all roles.\n');
} finally { await browser.close(); await handle.dispose(); await new Promise((done) => handle.server.close(done)); await runtime.stop(); }
