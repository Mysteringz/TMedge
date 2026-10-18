// Real editing regressions against disposable file storage, without .env or production services.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { EdgeLocationPublicationRuntime } from '../dist/src/edge/location-publication-runtime.js';
import { initializeFileLocationPersistence } from '../dist/src/infrastructure/location-config/file-location-storage.js';
import { createLocationRouter } from '../dist/src/modules/location-config/routes/location-router.js';
import { computeLocationCoverageSuggestions } from '../dist/src/infrastructure/location-config/location-coverage.js';
import { KEY, siteJson } from '../dist/test/fixtures.js';

test('draft exits, raw numeric validation and table translation preserve user edits', { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'location-edit-safety-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const sitePath = join(dir, 'site.json'), nodesPath = join(dir, 'nodes.json');
  writeFileSync(sitePath, JSON.stringify(siteJson()));
  writeFileSync(nodesPath, JSON.stringify({ nodes: [{ uid: 'aa:bb:cc:dd:ee:21', label: 'Bottom-right sensor', simulated: false, rgb: false, detector: 'node' }, { uid: 'aa:bb:cc:dd:ee:22', label: 'New sensor', simulated: false, rgb: false, detector: 'node' }] }));
  let persistence, runtime, handle, browser;
  try {
    persistence = initializeFileLocationPersistence(sitePath, nodesPath, dir);
    runtime = createEdgeRuntime({ edgeId: 'draft-browser', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath, nodesPath, dataDir: dir,
      recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'local-test', flashToken: null, pushUrls: [], pushToken: '',
      publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null }, persistence.registry);
    const users = new AlgoUsers(join(dir, 'users.json'));
    const password = randomBytes(24).toString('hex');
    await users.add('manager', password, 'admin');
    const publicationRuntime = new EdgeLocationPublicationRuntime(runtime, persistence.siteSeed);
    handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ALGO_USERS_FILE: users.path }, 'local-test'), undefined, {
      locationApi: auth => createLocationRouter({ auth, edgeId: 'draft-browser', siteSeed: persistence.siteSeed, ...persistence, runtime: publicationRuntime, suggestCoverage: computeLocationCoverageSuggestions }),
    });
    await new Promise(resolve => handle.server.once('listening', resolve));
    const base = `http://127.0.0.1:${handle.server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: 'manager', password } })).status(), 200);
    const request = async (method, path, body, expected = 200) => {
      const response = await context.request.fetch(`${base}/api${path}`, { method, headers: { origin: base, 'x-tm-algo': '1' }, ...(body ? { data: body } : {}) });
      assert.equal(response.status(), expected, await response.text());
      return (await response.json()).data;
    };

    const created = await request('POST', '/locations/drafts', { name: 'Safety test', building: 'Test', widthCm: 1200, heightCm: 1000 }, 201);
    const document = { ...created.document,
      zones: [{ id: 'zone', name: 'Main area', polygon: [[0, 0], [1200, 0], [1200, 1000], [0, 1000]] }],
      tables: [
        { id: 'rect', name: 'Rectangle', zoneId: 'zone', capacity: 1, shape: { type: 'rect', x: 200, y: 200, width: 100, height: 150 }, seats: [{ id: 'rect-seat', x: 220, y: 180, neighbors: [] }] },
        { id: 'circle', name: 'Circle', zoneId: 'zone', capacity: 1, shape: { type: 'circle', cx: 500, cy: 500, radius: 50 }, seats: [{ id: 'circle-seat', x: 500, y: 430, neighbors: [] }] },
      ],
      sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:21', pose: { x: 100, y: 350, heightCm: 400, yawDeg: 17, mirror: true }, owns: [] }],
    };
    await request('PUT', `/locations/drafts/${created.draftId}`, { expectedDraftRevision: 1, document });
    const page = await context.newPage();
    const artifacts = process.env.LOCATION_SAFETY_ARTIFACT_DIR;
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    page.setDefaultTimeout(8000);
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const detailUrl = `${base}/locations/${created.draftId}/details`;
    const read = () => request('GET', `/locations/drafts/${created.draftId}`);
    const openSettings = async () => {
      const settings = page.getByTestId('location-room-settings');
      if (!await settings.evaluate(element => element.open)) await settings.locator('summary').click();
    };
    const save = async (testId = 'location-save-draft') => {
      const response = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
      await page.getByTestId(testId).click();
      assert.equal((await response).status(), 200);
      await page.getByText(/Draft saved/).waitFor();
      await page.waitForFunction(id => !document.querySelector(`[data-testid="${id}"]`)?.disabled, testId);
      return read();
    };
    const respondToDialog = async (action, accept = false) => {
      const prompt = page.waitForEvent('dialog');
      const navigation = action().catch(error => {
        if (!/ERR_ABORTED|Navigation.*cancel|Timeout/i.test(error.message)) throw error;
      });
      const dialog = await prompt;
      if (accept) await dialog.accept(); else await dialog.dismiss();
      await navigation;
      return dialog.type();
    };
    const assertLocalName = async () => {
      await page.waitForURL(detailUrl);
      assert.equal(await page.getByLabel('Location name', { exact: true }).inputValue(), 'Local name');
      assert.equal((await read()).document.name, 'Safety test');
    };
    await page.goto(base + '/locations');
    await page.getByTestId(`location-continue-${created.draftId}`).click();
    await openSettings();
    await page.getByLabel('Location name', { exact: true }).fill('Local name');
    for (const testId of ['location-editor-back', 'location-details-back', 'location-nav-desktop']) {
      await respondToDialog(() => page.getByTestId(testId).click());
      await assertLocalName();
    }
    await respondToDialog(() => page.goBack());
    await assertLocalName();
    assert.equal(await respondToDialog(() => page.reload({ timeout: 3000 })), 'beforeunload');
    await assertLocalName();
    await respondToDialog(() => page.getByTestId('location-editor-back').click(), true);
    await page.waitForURL(base + '/locations');
    await page.getByTestId(`location-continue-${created.draftId}`).click();
    await openSettings();
    assert.equal(await page.getByLabel('Location name', { exact: true }).inputValue(), 'Safety test');
    await page.getByLabel('Location name', { exact: true }).fill('Saved name');
    await save();
    await page.getByTestId('location-editor-back').click();
    await page.waitForURL(base + '/locations');
    await page.goBack();
    await page.waitForURL(detailUrl);
    await openSettings();
    assert.equal(await page.getByLabel('Location name', { exact: true }).inputValue(), 'Saved name');

    // The document is clean throughout these attempts: its old width must not excuse bad raw text.
    const width = page.getByLabel('Floor width (m)', { exact: true });
    let publications = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/publications')) publications++; });
    for (const raw of ['', 'bad', '1001']) {
      await width.fill(raw); await width.press('Tab');
      await page.getByTestId('location-step-review').click();
      assert.equal(page.url(), detailUrl);
      assert.equal(await width.inputValue(), raw);
      assert.equal(await width.evaluate(element => document.activeElement === element), true);
      assert.equal((await read()).document.widthCm, 1200);
      assert.equal(publications, 0);
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-testid="location-field-floor-width"]');
        const container = input?.closest('.loc-room-settings-content');
        const field = input?.getBoundingClientRect(), pane = container?.getBoundingClientRect();
        return field && pane && field.top >= pane.top && field.bottom <= pane.bottom;
      });
      if (artifacts && raw === '') await page.screenshot({ path: join(artifacts, 'invalid-width-blocked.png'), fullPage: true });
    }
    await width.fill('12'); await width.press('Tab');
    await page.getByTestId('location-step-review').click();
    await page.waitForURL(/\/review$/);
    await page.goBack();
    await page.waitForURL(detailUrl);
    await openSettings();
    await width.fill(''); await width.press('Tab');
    await page.goForward();
    await page.waitForFunction(url => location.href === url, detailUrl);
    assert.equal(await width.inputValue(), '');
    await width.fill('12'); await width.press('Tab');

    await page.getByTestId('location-inspector-table-select').selectOption('rect');
    for (const [label, value] of [['Table X (m)', '3.25'], ['Table Y (m)', '7']]) {
      const input = page.getByLabel(label, { exact: true });
      await input.fill(value); await input.press('Tab');
    }
    const rect = (await save()).document.tables.find(table => table.id === 'rect');
    assert.deepEqual(rect.shape, { type: 'rect', x: 325, y: 150, width: 100, height: 150 });
    assert.deepEqual(rect.seats, [{ id: 'rect-seat', x: 345, y: 130, neighbors: [] }]);
    await page.getByTestId('location-inspector-table-select').selectOption('circle');
    for (const [label, value] of [['Circle center X (m)', '6'], ['Circle center Y (m)', '6']]) {
      const input = page.getByLabel(label, { exact: true });
      await input.fill(value); await input.press('Tab');
    }
    const circle = (await save()).document.tables.find(table => table.id === 'circle');
    assert.deepEqual(circle.shape, { type: 'circle', cx: 600, cy: 400, radius: 50 });
    assert.deepEqual(circle.seats, [{ id: 'circle-seat', x: 600, y: 330, neighbors: [] }]);
    if (artifacts) await page.screenshot({ path: join(artifacts, 'tables-and-seats-translated.png'), fullPage: true });
    await page.reload();
    await page.getByTestId('location-inspector-table-select').selectOption('rect');
    assert.equal(await page.getByLabel('Table X (m)', { exact: true }).inputValue(), '3.25');
    assert.deepEqual((await read()).document.tables.find(table => table.id === 'rect').seats, rect.seats);

    // Sensor raw errors also use the same gate, including when no valid document value changed.
    await page.getByTestId('location-step-sensors').click();
    await page.getByTestId('location-sensor-aa-bb-cc-dd-ee-21').click();
    const height = page.getByLabel('Height (m)', { exact: true });
    await height.fill(''); await height.press('Tab');
    await page.getByTestId('location-sensors-continue').click();
    assert.match(page.url(), /\/sensors$/);
    assert.equal(await height.inputValue(), '');
    await height.fill('4'); await height.press('Tab');
    await page.getByTestId('location-step-review').click();
    await page.waitForURL(/\/review$/);
    assert.equal(await page.getByTestId('location-publish').isEnabled(), true);
    await page.getByTestId('location-publish').click();
    await page.waitForURL(base + '/locations');
    assert.equal(publications, 1, 'corrected values publish normally without a leave warning');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await handle?.dispose();
    if (handle) await new Promise(resolve => handle.server.close(resolve));
    await runtime?.stop();
    persistence?.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
