// Local Playwright/installed Chrome fallback with temporary runtime transport fixtures.
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
const artifacts = resolve('../.codex/docs/algo-admin-improvements/task-3-2-connection-and-command-states/artifacts'); mkdirSync(artifacts, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'tm-receipt-browser-')), usersPath = join(dataDir, 'users.json'); process.env.DATA_DIR = dataDir;
const users = new AlgoUsers(usersPath), password = randomBytes(18).toString('hex');
for (const [name, role] of [['alice', 'engineer'], ['bob', 'admin'], ['reader', 'viewer']]) await users.add(name, password, role);
const cfg = { edgeId: 'receipt-browser', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir, recordRaw: false,
  consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test', flashToken: null, pushUrls: [], pushToken: '', publishMs: 60000,
  gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson())), originalNodes = runtime.nodes.bind(runtime);
let online = true, sequence = 41, dispatches = 0;
runtime.nodes = () => originalNodes().map((node) => ({ ...node, online, reportReceivedAt: online ? Date.now() : Date.now() - 20000,
  status: { fw: 'test-1', ip: '127.0.0.1', rssi: -40, channel: 1, heap: 100000, minHeap: 50000, stackFree: 10000, wifiDrops: 0, sensorErrors: 0,
    frames: 1, fps: 1, vdd: 3.3, lastCmd: sequence, params: { min_contrast: 60, raw_every: 0 }, receivedAt: Date.now(), generation: 1 } }));
runtime.ingest.sendCommand = async () => { dispatches++; return ++sequence; };
const core = createConsole(runtime), handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ALGO_USERS_FILE: usersPath }, cfg.adminPassword), core);
await new Promise((done) => handle.server.once('listening', done)); const base = `http://127.0.0.1:${handle.server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const evidence = [];
let activePage = null;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: 'alice', password } })).status(), 200);
  await context.addInitScript(() => { const Original = window.WebSocket; window.testSockets = []; window.WebSocket = class extends Original { constructor(...args) { super(...args); window.testSockets.push(this); } }; });
  const page = await context.newPage(), errors = [], submits = [];
  activePage = page;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/command')) submits.push(request.url()); });
  await page.goto(`${base}/console`); const frame = page.frameLocator('iframe');
  await frame.locator('#conn').getByText('Connected', { exact: true }).waitFor();
  await frame.locator('#controls button[data-op="identify"]').waitFor({ state: 'visible' });
  const submitted = page.waitForResponse((response) => response.url().endsWith('/command') && response.request().method() === 'POST');
  await frame.locator('#controls button[data-op="identify"]').click();
  const result = await (await submitted).json(); assert.equal(result.receipt.state, 'sent');
  await frame.locator('#cmd-result').getByText('Sent — waiting for device.', { exact: false }).waitFor();
  assert.equal(dispatches, 1);
  runtime.commandReceipts.observeStatus({ uid: result.receipt.uid, sequence: result.receipt.sequence, boot: 1, at: Date.now() });
  await frame.locator('#refresh-command-status').click();
  await frame.locator('#cmd-result').getByText('Device acknowledged.', { exact: false }).waitFor();
  await frame.locator('#cmd-result').getByText('Acknowledgement does not confirm execution or persistence.', { exact: false }).waitFor();
  await page.screenshot({ path: join(artifacts, 'device-acknowledged.png'), fullPage: true });
  for (const username of ['bob', 'reader']) {
    const other = await browser.newContext(); await other.request.post(`${base}/auth/login`, { data: { username, password } });
    assert.equal((await other.request.get(`${base}/console-app/api/nodes/${result.receipt.uid}/commands/${result.receipt.id}`)).status(), 404);
    if (username === 'reader') assert.equal((await other.request.post(`${base}/console-app/api/nodes/${result.receipt.uid}/command`, { headers: { 'x-tm-console': '1' }, data: { op: 'identify' } })).status(), 403);
    await other.close();
  }
  await page.route('**/console-app/api/ws-token', (route) => route.abort());
  await frame.locator('body').evaluate(() => window.testSockets.at(-1)?.close());
  await frame.locator('#data-freshness').getByText('Last known data', { exact: false }).waitFor();
  assert.equal(await frame.locator('#controls button[data-op="identify"]').isDisabled(), true);
  await frame.locator('#conn').getByText('Disconnected', { exact: true }).waitFor();
  assert.equal(dispatches, 1); assert.equal(submits.length, 1);
  await page.screenshot({ path: join(artifacts, 'console-disconnected-retained.png'), fullPage: true });
  await page.unroute('**/console-app/api/ws-token');
  await frame.locator('#conn').getByText('Connected', { exact: true }).waitFor();
  assert.equal(dispatches, 1, 'reconnect does not replay');
  const receiptUrl = `**/console-app/api/nodes/${encodeURIComponent(result.receipt.uid)}/commands/${encodeURIComponent(result.receipt.id)}`;
  await page.route(receiptUrl, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null, error: { code: 'not-found' } }) }));
  await frame.locator('#refresh-command-status').click();
  await frame.locator('#cmd-result').getByText('Command status is no longer available.', { exact: false }).waitFor();
  await page.screenshot({ path: join(artifacts, 'command-expired-uncertain.png'), fullPage: true });
  await page.unroute(receiptUrl);
  runtime.ingest.sendCommand = async () => { dispatches++; throw new Error('PRIVATE192.168.1.9'); };
  await frame.locator('#controls button[data-op="identify"]').click();
  await frame.locator('#cmd-result').getByText('Delivery could not be confirmed.', { exact: false }).waitFor();
  assert.ok(!(await frame.locator('#cmd-result').textContent()).includes('PRIVATE'));
  await page.screenshot({ path: join(artifacts, 'command-transport-uncertain.png'), fullPage: true });
  await page.goto(`${base}/flow`);
  const strip = page.getByRole('region', { name: 'Live connection status' });
  await strip.getByText('Connected', { exact: true }).waitFor();
  online = false; await strip.getByText('Sensor REPORT offline or not yet received', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'flow-connected-sensor-offline.png'), fullPage: true });
  await page.route('**/api/ws-token', (route) => route.abort()); await page.evaluate(() => window.testSockets.at(-1)?.close());
  await strip.getByText('Last known data', { exact: false }).waitFor();
  await strip.getByText('Disconnected', { exact: true }).waitFor();
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'flow-disconnected-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  evidence.push({ checks: ['real cookie API/issuer isolation including admin', 'viewer command denial', 'sent receipt', 'exact device ACK disclaimer', 'disconnect retained data/disabled controls', 'reconnect no replay', 'receipt404 uncertainty', 'safe dispatch failure', 'connected transport vs offline REPORT', '360px and200% CSS zoom', 'zero page errors'], commandPosts: submits.length, fakeDispatches: dispatches });
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({ runner: 'local Playwright + installed Chrome', fixture: 'temporary runtime nodes and dispatch; actual auth/HTTP/WS; no hardware dispatch', evidence }, null, 2));
  process.stdout.write('Connection and command browser acceptance passed.\n'); await context.close();
} catch (error) {
  if (activePage) { await activePage.screenshot({ path: join(artifacts, 'browser-failure.png'), fullPage: true });
    writeFileSync(join(artifacts, 'browser-failure.txt'), `${error.message}\n${await activePage.frameLocator('iframe').locator('#cmd-result').textContent().catch(() => 'frame unavailable')}`); }
  throw error;
} finally { await browser.close(); await handle.dispose(); await new Promise((done) => handle.server.close(done)); await runtime.stop(); }
