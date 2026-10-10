// Local Playwright fallback, not Playwright MCP or Chrome DevTools MCP.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { createConsole } from '../dist/src/edge/console.js';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { KEY, nodesJson, siteJson } from '../dist/test/fixtures.js';

const artifactDir = resolve(process.env.ROLE_ARTIFACT_DIR ?? '../.codex/docs/algo-admin-improvements/task-2-1-roles-and-permissions/artifacts');
mkdirSync(artifactDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'tm-browser-')), usersPath = join(dataDir, 'users.json');
process.env.DATA_DIR = dataDir;
const users = new AlgoUsers(usersPath), password = randomBytes(18).toString('hex');
for (const role of ['viewer', 'operator', 'engineer', 'admin']) await users.add(role, password, role);
const cfg = { edgeId: 'browser-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir, recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null, pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson())), core = createConsole(runtime);
const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ALGO_USERS_FILE: usersPath }, cfg.adminPassword), core);
await new Promise((done) => handle.server.once('listening', done));
const base = `http://127.0.0.1:${handle.server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const evidence = [];
try {
  for (const role of ['viewer', 'operator', 'engineer', 'admin']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const response = await context.request.post(`${base}/auth/login`, { data: { username: role, password } });
    assert.equal(response.status(), 200);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/updates`);
    await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
    const browse = page.getByRole('button', { name: 'Browse folder', exact: true });
    assert.equal(await browse.isDisabled(), !['engineer', 'admin'].includes(role));
    if (!['engineer', 'admin'].includes(role)) await page.getByText('Engineer or admin access required.', { exact: true }).waitFor();
    await page.screenshot({ path: join(artifactDir, `${role}-updates.png`), fullPage: true });
    await page.goto(`${base}/flow`); await page.getByText('Algo debugger', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reset graph', exact: true }).isDisabled(), role === 'viewer');
    if (role === 'viewer') {
      await page.goto(`${base}/train`); await page.getByRole('button', { name: 'Save draft' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save draft' }).isDisabled(), true);
      await page.screenshot({ path: join(artifactDir, 'viewer-training.png'), fullPage: true });
      await page.goto(`${base}/console`);
      const frame = page.frameLocator('iframe');
      await frame.getByText('Read-only access. An operator or engineer can change parameters and run training.', { exact: true }).waitFor();
      assert.equal(await frame.locator('#controls button[data-op="reboot"]').isDisabled(), true);
      await page.screenshot({ path: join(artifactDir, 'viewer-console.png'), fullPage: true });
      await page.setViewportSize({ width: 360, height: 800 }); await page.goto(`${base}/updates`);
      await page.getByRole('heading', { name: 'Updates', exact: true }).waitFor();
      await page.getByText('Viewer', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: join(artifactDir, 'viewer-mobile.png'), fullPage: true });
      const writes = [];
      page.on('request', (request) => { if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url()); });
      for (const path of ['/flow', '/console']) {
        await page.goto(`${base}${path}`);
        await page.getByText('Viewer', { exact: true }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin-access-change', { detail: 403 })));
        await page.getByText('Your access has changed. This action is unavailable.', { exact: true }).waitFor();
      }
      let releaseAccess;
      const heldAccess = new Promise((done) => { releaseAccess = done; });
      await page.route('**/api/me', async (route) => { await heldAccess; await route.continue(); });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin-access-change', { detail: 403 })));
      await page.getByText('Checking access…', { exact: true }).waitFor();
      await page.getByText('Your access has changed. This action is unavailable.', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifactDir, 'access-check-feedback.png'), fullPage: true });
      releaseAccess();
      await page.getByText('Viewer', { exact: true }).waitFor();
      await page.unroute('**/api/me');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin-access-change', { detail: 401 })));
      await page.waitForURL('**/login**');
      await page.getByText('Your session ended. Sign in again.', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifactDir, 'session-ended-feedback.png'), fullPage: true });
      assert.deepEqual(writes, [], 'permission refresh never retries a mutation');
      evidence.push({ checks: ['mobile role and sign-out visible', 'flow and console 403 feedback', 'loading feedback', '401 login feedback'], writesAfterPermissionChange: writes.length });
    }
    assert.deepEqual(errors, []);
    evidence.push({ role, updatesWrite: ['engineer', 'admin'].includes(role), flowWrite: role !== 'viewer', pageErrors: errors });
    await context.close();
  }
  writeFileSync(join(artifactDir, 'browser-results.json'), JSON.stringify({ runner: 'local Playwright Chromium', evidence }, null, 2));
  process.stdout.write('Browser role flows passed for viewer, engineer and admin.\n');
} finally { await browser.close(); await handle.dispose(); await new Promise((done) => handle.server.close(done)); await runtime.stop(); }
