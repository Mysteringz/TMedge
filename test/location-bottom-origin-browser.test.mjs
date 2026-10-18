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

test('bottom-left coordinate fields preserve geometry and convert edits to canonical data', { timeout: 60_000 }, async () => {
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
    const created = await request('POST', '/locations/drafts', { name: 'Origin test', building: 'Test', widthCm: 1200, heightCm: 1000 }, 201);
    const document = { ...created.document,
      zones: [{ id: 'origin-zone', name: 'Main area', polygon: [[0, 0], [1200, 0], [1200, 1000], [0, 1000]] }],
      tables: [
        { id: 'rect-table', name: 'Rectangle', zoneId: 'origin-zone', capacity: 1, shape: { type: 'rect', x: 200, y: 200, width: 100, height: 150 }, seats: [{ id: 'rect-seat', x: 220, y: 180, neighbors: [] }] },
        { id: 'circle-table', name: 'Circle', zoneId: 'origin-zone', capacity: 1, shape: { type: 'circle', cx: 400, cy: 400, radius: 50 }, seats: [{ id: 'circle-seat', x: 400, y: 330, neighbors: [] }] },
        { id: 'polygon-table', name: 'Polygon', zoneId: 'origin-zone', capacity: 1, shape: { type: 'polygon', points: [[600, 600], [700, 600], [700, 700]] }, seats: [{ id: 'polygon-seat', x: 650, y: 580, neighbors: [] }] },
      ],
      sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:21', pose: { x: 100, y: 350.5, heightCm: 400.5, yawDeg: 17, mirror: true }, owns: [] }],
    };
    await request('PUT', `/locations/drafts/${created.draftId}`, { expectedDraftRevision: 1, document });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/locations/${created.draftId}/details`);
    await page.getByTestId('location-canvas-mode-2d').check();
    await page.getByTestId('location-inspector-table-select').selectOption('rect-table');
    const tableY = page.getByLabel('Table Y (m)', { exact: true });
    assert.equal(await tableY.inputValue(), '6.5', 'rectangle Y is its lower-left corner in metres');
    assert.equal(await page.getByTestId('location-canvas-table-rect-table').getAttribute('y'), '200', 'opening the editor never flips existing geometry');
    assert.deepEqual((await request('GET', `/locations/drafts/${created.draftId}`)).document, document);
    await tableY.fill('7'); await tableY.press('Tab');
    const tableHeight = page.getByLabel('Table height (m)', { exact: true });
    await tableHeight.fill('2'); await tableHeight.press('Tab');
    assert.equal(await tableY.inputValue(), '7', 'resizing keeps the lower-left anchor fixed');
    await page.getByText('Seats (1)', { exact: true }).click();
    const seatY = page.getByLabel('Seat 1 Y (m)', { exact: true });
    assert.equal(await seatY.inputValue(), '8.7', 'numeric table translation carries its custom seat by the same displacement');
    await seatY.fill('8'); await seatY.press('Tab');
    await page.getByTestId('location-inspector-table-select').selectOption('circle-table');
    const circleY = page.getByLabel('Circle center Y (m)', { exact: true });
    assert.equal(await circleY.inputValue(), '6');
    await circleY.fill('5'); await circleY.press('Tab');
    await page.getByTestId('location-inspector-table-select').selectOption('polygon-table');
    const polygonY = page.getByLabel('Table vertex 1 Y (m)', { exact: true });
    assert.equal(await polygonY.inputValue(), '4');
    await polygonY.fill('3.5'); await polygonY.press('Tab');
    await page.getByTestId('location-inspector-zone-select').selectOption('origin-zone');
    const inspector = page.getByTestId('location-editor-inspector');
    const selectors = page.locator('.loc-inspector-selection');
    await inspector.evaluate(element => { element.scrollTop = 0; });
    const selectorsBeforeScroll = await selectors.boundingBox();
    await inspector.evaluate(element => { element.scrollTop = 220; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const selectorsAfterScroll = await selectors.boundingBox();
    assert.ok(selectorsAfterScroll.y < selectorsBeforeScroll.y - 100, 'zone/table selectors scroll away rather than overlaying editable fields');
    await inspector.evaluate(element => { element.scrollTop = 0; });
    const zoneY = page.getByLabel('Main area vertex 1 Y (m)', { exact: true });
    assert.equal(await zoneY.inputValue(), '10');
    const boundary = page.getByRole('table', { name: 'Main area boundary coordinates', exact: true });
    assert.equal(await boundary.getByRole('row').count(), 5, 'boundary has a header and four compact corner rows');
    assert.deepEqual(await boundary.getByRole('columnheader').allTextContents(), ['Corner', 'X (m)', 'Y (m)', 'Actions']);
    const addCorner = page.getByRole('button', { name: 'Add corner', exact: true });
    await addCorner.click();
    assert.equal(await boundary.getByRole('row').count(), 6);
    await boundary.getByRole('button', { name: 'Remove corner 5', exact: true }).click();
    assert.equal(await boundary.getByRole('row').count(), 5);
    if (process.env.LOCATION_INSPECTOR_SCREENSHOTS) {
      mkdirSync(process.env.LOCATION_INSPECTOR_SCREENSHOTS, { recursive: true });
      await boundary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.LOCATION_INSPECTOR_SCREENSHOTS, 'zone-boundary-desktop.png') });
      await inspector.screenshot({ path: join(process.env.LOCATION_INSPECTOR_SCREENSHOTS, 'zone-editor-panel.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await boundary.scrollIntoViewIfNeeded();
    assert.equal(await boundary.evaluate(table => table.scrollWidth <= table.clientWidth + 1 && table.getBoundingClientRect().right <= window.innerWidth), true, 'compact boundary coordinates fit on a phone without horizontal scrolling');
    if (process.env.LOCATION_INSPECTOR_SCREENSHOTS) await page.screenshot({ path: join(process.env.LOCATION_INSPECTOR_SCREENSHOTS, 'zone-boundary-phone.png') });
    await page.setViewportSize({ width: 1366, height: 900 });
    await zoneY.fill('9.5'); await zoneY.press('Tab');
    const save = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    assert.equal((await save).status(), 200);
    const saved = (await request('GET', `/locations/drafts/${created.draftId}`)).document;
    assert.equal(saved.tables[0].shape.y, 100); assert.equal(saved.tables[0].shape.height, 200);
    assert.equal(saved.tables[0].seats[0].y, 200);
    assert.equal(saved.tables[1].shape.cy, 500);
    assert.equal(saved.tables[2].shape.points[0][1], 650);
    assert.equal(saved.zones[0].polygon[0][1], 50);
    assert.deepEqual(saved.sensorAssignments, document.sensorAssignments);
    await page.goto(`${base}/locations/${created.draftId}/sensors`);
    await page.getByTestId('location-canvas-mode-2d').check();
    const sensorY = page.getByLabel('Position Y (m)', { exact: true });
    await sensorY.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid=location-sensor-position-y]')?.value === '6.495');
    // An untouched fractional sensor value survives blur and unrelated editing.
    await sensorY.focus(); await sensorY.press('Tab');
    const sensorX = page.getByLabel('Position X (m)', { exact: true });
    await sensorX.fill('1.25'); await sensorX.press('Tab');
    const saveSensor = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
    await page.getByTestId('location-sensors-save').click();
    assert.equal((await saveSensor).status(), 200);
    assert.equal((await request('GET', `/locations/drafts/${created.draftId}`)).document.sensorAssignments[0].pose.y, 350.5);
    await sensorY.fill('6'); await sensorY.press('Tab');
    const svg = page.locator('.loc-viewport-canvas.is-active .loc-canvas');
    await svg.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('[data-testid=location-sensor-position-y]')?.value === '6.01');
    const saveMovedSensor = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
    await page.getByTestId('location-sensors-save').click();
    assert.equal((await saveMovedSensor).status(), 200);
    const pose = (await request('GET', `/locations/drafts/${created.draftId}`)).document.sensorAssignments[0].pose;
    assert.deepEqual(pose, { x: 125, y: 399, heightCm: 400.5, yawDeg: 17, mirror: true });
    await page.getByTestId('location-sensor-aa-bb-cc-dd-ee-22').click();
    await sensorX.fill('3'); await sensorX.press('Tab');
    await sensorY.fill('2'); await sensorY.press('Tab');
    await page.getByLabel('Height (m)', { exact: true }).fill('3.5');
    await page.getByLabel('Height (m)', { exact: true }).press('Tab');
    await svg.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('[data-testid=location-sensor-position-y]')?.value === '2.01');
    assert.equal(await page.getByTestId('location-canvas-sensor-aa-bb-cc-dd-ee-22').getAttribute('cy'), '799', 'provisional sensor uses canonical position before adding');
    await page.getByTestId('location-sensor-add').click();
    const saveNewSensor = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
    await page.getByTestId('location-sensors-save').click();
    assert.equal((await saveNewSensor).status(), 200);
    const newPose = (await request('GET', `/locations/drafts/${created.draftId}`)).document.sensorAssignments.find(row => row.uid.endsWith('22')).pose;
    assert.equal(newPose.x, 300); assert.equal(newPose.y, 799); assert.equal(newPose.heightCm, 350);
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
