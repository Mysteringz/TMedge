// Real room-fit regression against disposable file storage, without .env or production services.
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

test('table removal confirms, preserves unrelated draft data and stays private until publication', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-viewport-browser-'));
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
    const created = await request('POST', '/locations/drafts', { name: 'Table removal room', building: 'Test', widthCm: 1200, heightCm: 1000 }, 201);
    const document = { ...created.document,
      zones: [{ id: 'removal-zone', name: 'Main area', polygon: [[0, 0], [1200, 0], [1200, 1000], [0, 1000]] }],
      tables: [
        { id: 'remove-table', name: 'Remove this table', zoneId: 'removal-zone', capacity: 2, shape: { type: 'rect', x: 200, y: 200, width: 100, height: 150 }, seats: [{ id: 'remove-seat-a', x: 200, y: 180, neighbors: [] }, { id: 'remove-seat-b', x: 230, y: 180, neighbors: [] }] },
        { id: 'keep-table', name: 'Keep this table', zoneId: 'removal-zone', capacity: 1, shape: { type: 'circle', cx: 700, cy: 500, radius: 50 }, seats: [{ id: 'keep-seat', x: 700, y: 430, neighbors: [] }] },
      ],
      sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:21', pose: { x: 220, y: 180, heightCm: 400, yawDeg: 0, mirror: false }, owns: ['remove-table'] }],
    };
    await request('PUT', `/locations/drafts/${created.draftId}`, { expectedDraftRevision: 1, document });
    await request('POST', `/locations/drafts/${created.draftId}/publications`, { expectedDraftRevision: 2, expectedPublishedRevision: null });
    const edit = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 1 }, 201);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let writes = 0;
    page.on('request', req => { if (['PUT', 'POST', 'DELETE'].includes(req.method())) writes++; });
    await page.goto(`${base}/locations/${edit.draftId}/details`);
    await page.getByTestId('location-canvas-mode-2d').check();
    const selector = page.getByTestId('location-inspector-table-select');
    await selector.selectOption('remove-table');
    const remove = page.getByTestId('location-table-remove');
    assert.equal(await remove.count(), 1, 'selected table has a Remove table action');
    await remove.focus(); await remove.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Remove table?', exact: true });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Remove this table.*2 seats/);
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    assert.equal(await cancel.evaluate(button => button === globalThis.document.activeElement), true);
    await cancel.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await remove.evaluate(button => button === globalThis.document.activeElement), true, 'Cancel restores focus to the action');
    assert.equal(await page.getByTestId('location-canvas-table-remove-table').count(), 1);
    await remove.click(); await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes, 0, 'opening/cancelling never saves or publishes');
    await page.getByText('Seats (2)', { exact: true }).click();
    await page.getByTestId('location-select-seat-remove-seat-a').click();
    await page.getByLabel('Table Y (m)', { exact: true }).fill('-');
    await remove.click();
    await dialog.waitFor({ timeout: 5000 });
    if (process.env.LOCATION_TABLE_REMOVAL_SCREENSHOTS) {
      mkdirSync(process.env.LOCATION_TABLE_REMOVAL_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.LOCATION_TABLE_REMOVAL_SCREENSHOTS, 'remove-table-confirmation.png') });
    }
    await dialog.getByRole('button', { name: 'Remove table', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await selector.inputValue(), '');
    await page.waitForFunction(() => document.querySelector('[data-testid=location-inspector-table-select]') === document.activeElement);
    assert.equal(await selector.evaluate(select => select === globalThis.document.activeElement), true, 'focus moves to the surviving table selector');
    assert.equal(await page.getByTestId('location-canvas-table-remove-table').count(), 0);
    assert.equal(await page.getByTestId('location-canvas-table-keep-table').count(), 1);
    assert.equal(writes, 0, 'confirmation changes the local draft, without saving or publishing');
    assert.ok(runtime.reg.tables.has('remove-table'), 'live table remains before draft publication');
    const saveDraft = async () => {
      const response = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith(`/drafts/${edit.draftId}`));
      await page.getByTestId('location-save-draft').click();
      assert.equal((await response).status(), 200);
      return request('GET', `/locations/drafts/${edit.draftId}`);
    };
    const saved = await saveDraft();
    assert.deepEqual(saved.document.tables, [document.tables[1]]);
    assert.deepEqual(saved.document.zones, document.zones);
    assert.deepEqual(saved.document.sensorAssignments, [{ ...document.sensorAssignments[0], owns: [] }]);
    assert.ok(runtime.reg.tables.has('remove-table'), 'saving a private draft does not remove the live table');
    await page.reload();
    await page.getByTestId('location-canvas-mode-2d').check();
    assert.equal(await page.getByTestId('location-canvas-table-remove-table').count(), 0);
    await selector.selectOption('keep-table');
    await remove.click();
    await dialog.getByRole('button', { name: 'Remove table', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const empty = await saveDraft();
    assert.deepEqual(empty.document.tables, [], 'the final table can be removed and saved');
    await request('POST', `/locations/drafts/${edit.draftId}/publications`, { expectedDraftRevision: empty.draftRevision, expectedPublishedRevision: 1 });
    assert.ok(!runtime.reg.tables.has('remove-table') && !runtime.reg.tables.has('keep-table'));
    assert.deepEqual(runtime.reg.nodes.get('aa:bb:cc:dd:ee:21').owns, []);
    assert.equal((await persistence.published.listHistory(created.locationId)).length, 2);
    const touchDraft = await request('POST', '/locations/drafts', { name: 'Touch removal', building: 'Test', widthCm: 1200, heightCm: 1000 }, 201);
    await request('PUT', `/locations/drafts/${touchDraft.draftId}`, { expectedDraftRevision: 1, document: { ...document, sensorAssignments: [] } });
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await touchContext.request.post(`${base}/auth/login`, { data: { username: 'manager', password } });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(`${base}/locations/${touchDraft.draftId}/details`);
    await touchPage.getByTestId('location-canvas-mode-2d').check();
    await touchPage.getByTestId('location-inspector-table-select').selectOption('remove-table');
    const touchRemove = touchPage.getByTestId('location-table-remove');
    await touchRemove.tap();
    const touchDialog = touchPage.getByRole('dialog', { name: 'Remove table?', exact: true });
    await touchDialog.waitFor();
    if (process.env.LOCATION_TABLE_REMOVAL_SCREENSHOTS) await touchPage.screenshot({ path: join(process.env.LOCATION_TABLE_REMOVAL_SCREENSHOTS, 'remove-table-phone.png') });
    await touchDialog.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await touchDialog.waitFor({ state: 'hidden' });
    assert.equal(await touchPage.getByTestId('location-canvas-table-remove-table').count(), 1);
    await touchRemove.tap();
    await touchDialog.getByRole('button', { name: 'Remove table', exact: true }).tap();
    await touchDialog.waitFor({ state: 'hidden' });
    assert.equal(await touchPage.getByTestId('location-canvas-table-remove-table').count(), 0, 'touch confirmation removes the chosen table');
    await touchContext.close();
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
