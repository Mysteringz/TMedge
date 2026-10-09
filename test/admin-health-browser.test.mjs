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
try {
  for (const role of ['viewer', 'engineer', 'admin']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: role, password } })).status(), 200);
    const page = await context.newPage(), errors = []; let healthReads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.url().includes('/api/admin/health')) healthReads++; });
    await page.goto(base); await page.getByRole('button', { name: /Notifications/ }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'System status', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh system status', exact: true }).count(), 0);
    assert.equal((await context.request.get(`${base}/api/admin/health`)).status(), 200, 'legacy health API remains');
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.locator('.cx-source-summaries dd').first().waitFor();
    assert.equal(await page.locator('.cx-source-summaries dt').count(), 4);
    const order = await page.locator('.cx-identity-actions').evaluate((cluster) => [...cluster.children].map((child) => child.className));
    assert.ok(order[0].includes('cx-who') && order[1].includes('cx-notification-toggle'));
    assert.equal(await page.locator('#notification-toggle').evaluate((bell) => bell.nextElementSibling?.getAttribute('aria-label')), 'Sign out');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#notification-toggle').evaluate((bell) => bell === document.activeElement), true);
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByRole('button', { name: 'Close notifications' }).focus(); await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), 'Close notifications');
    await page.locator('.cx-who').click(); assert.equal(await page.locator('#notification-center').count(), 0);
    assert.equal(healthReads, 0, 'Home does not mount or poll old dashboard');
    await page.goto(`${base}/console`);
    const frame = page.frameLocator('iframe');
    await frame.locator('.console-access-notice').waitFor({ state: 'attached' }); await frame.locator('#data-freshness').waitFor();
    const gutters = await frame.locator('.console-access-notice, #data-freshness').evaluateAll((rows) => rows.filter((row) => row.textContent).map((row) => ({left:row.getBoundingClientRect().left, margin:getComputedStyle(row).marginLeft, overflow:document.documentElement.scrollWidth > innerWidth})));
    assert.ok(gutters.every((row) => row.left >= 16 && row.margin === '16px' && !row.overflow));
    await page.screenshot({ path: join(artifacts, `${role}-console-gutters.png`), fullPage: true });
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.screenshot({ path: join(artifacts, `${role}-bell-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await frame.locator('body').click({ position: { x: 20, y: 500 } }); await page.waitForTimeout(100);
    assert.equal(await page.locator('#notification-center').count(), 0, 'observable iframe click closes center');
    assert.deepEqual(errors, []);
    evidence.push({ role, noHomeHealthPolling:true, fourCompactSources:true, mobileDomOrder:true, focusEscapeOutsideTab:true, consoleGutters:gutters, pageErrors:errors });
    await context.close();
  }
  writeFileSync(join(artifacts, 'bell-browser-results.json'), JSON.stringify({ runner: 'local Playwright + installed Chrome', evidence }, null, 2));
  process.stdout.write('Bell and console browser acceptance passed for all roles.\n');
} finally { await browser.close(); await handle.dispose(); await new Promise((done) => handle.server.close(done)); await runtime.stop(); }
