// Focused signed-session console furniture flow using local Playwright/system Chrome.
// Uses disposable file fixtures and loopback only; it never reads .env or production data.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { EdgeLocationPublicationRuntime } from '../dist/src/edge/location-publication-runtime.js';
import { initializeFileLocationPersistence } from '../dist/src/infrastructure/location-config/file-location-storage.js';
import { syncDirectory } from '../dist/src/shared/directory-sync.js';
import { computeLocationCoverageSuggestions } from '../dist/src/infrastructure/location-config/location-coverage.js';
import { createLocationRouter } from '../dist/src/modules/location-config/routes/location-router.js';
import { KEY } from '../dist/test/fixtures.js';

const taskArtifacts = resolve(process.env.LOCATION_FURNITURE_ARTIFACT_DIR ?? '../tmp/room-editor-refinement/task-3c-console-furniture');
const artifacts = join(taskArtifacts, 'developer-browser');
const tempRoot = resolve('../tmp/room-editor-refinement/task-3c-console-furniture-runtime');
const sampleGlb = resolve('../tmp/new-location-add-wizard/task-3-3-qa-preparation/qa-self-contained-textured-triangle.glb');
mkdirSync(artifacts, { recursive: true });
mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
assert.ok(readFileSync(sampleGlb).byteLength > 20, 'the local self-contained GLB fixture is available');
const fixtureRoot = mkdtempSync(join(tempRoot, 'run-'));
const sitePath = join(fixtureRoot, 'site.json');
const nodesPath = join(fixtureRoot, 'nodes.json');
const dataDir = join(fixtureRoot, 'data');
const usersPath = join(fixtureRoot, 'algo-users.json');
const password = randomBytes(24).toString('hex');
const sessionSecret = randomBytes(32).toString('hex');
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
writeFileSync(sitePath, JSON.stringify({ site: { id: 'furniture-ui-qa', name: 'Furniture UI QA' }, floors: [{
  id: 'qa-seed-floor', building: 'Seed Building', name: 'Seed Floor', visibility: 'public', width: 400, height: 300,
  outline: [[0, 0], [400, 0], [400, 300], [0, 300]], zones: [{ id: 'qa-seed-zone', name: 'Seed Zone', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }], tables: [],
}] }));
writeFileSync(nodesPath, JSON.stringify({ nodes: [] }));

const cfg = {
  edgeId: 'furniture-ui-qa', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath, nodesPath,
  dataDir, recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'synthetic-only',
  flashToken: null, pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
  nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
};

let persistence;
let runtime;
let handle;
let browser;
const network = [];
const browserErrors = [];
const safePath = (path) => path.replace(/(\/api\/locations\/drafts\/)[^/]+/g, '$1{draftId}')
  .replace(/(\/api\/locations\/drafts\/\{draftId\}\/assets\/)[^/]+/g, '$1{assetId}')
  .replace(/(\/api\/furniture-library\/)[^/]+$/g, '$1{assetId}')
  .replace(/^(\/locations\/)[^/]+(?=\/)/g, '$1{draftId}');

try {
  const users = new AlgoUsers(usersPath);
  await users.add('qa-furniture-manager', password, 'admin');
  persistence = initializeFileLocationPersistence(sitePath, nodesPath, dataDir, { syncDirectory });
  runtime = createEdgeRuntime(cfg, persistence.registry);
  const publicationRuntime = new EdgeLocationPublicationRuntime(runtime, persistence.siteSeed);
  const locationApi = (auth) => createLocationRouter({
    auth, edgeId: cfg.edgeId, siteSeed: persistence.siteSeed, drafts: persistence.drafts, published: persistence.published,
    snapshots: persistence.snapshots, assets: persistence.assets, furnitureLibrary: persistence.furnitureLibrary,
    assetMetadata: persistence.assetMetadata, coordinator: persistence.coordinator, runtime: publicationRuntime,
    suggestCoverage: computeLocationCoverageSuggestions, now: Date.now,
  });
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: sessionSecret, ALGO_USERS_FILE: usersPath }, cfg.adminPassword), undefined, { locationApi });
  await new Promise((done) => handle.server.once('listening', done));
  const base = `http://127.0.0.1:${handle.server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: 'qa-furniture-manager', password } })).status(), 200);
  const page = await context.newPage();
  page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '/* offline fixture */' }));
  page.on('pageerror', (error) => browserErrors.push({ kind: 'pageerror', message: error.message.slice(0, 240) }));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push({ kind: 'console', message: message.text().slice(0, 240) }); });
  page.on('response', (response) => network.push({ method: response.request().method(), path: safePath(new URL(response.url()).pathname), status: response.status() }));
  page.on('request', (request) => {
    const url = request.url();
    assert.ok(url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('https://fonts.googleapis.com/'), `unexpected external request origin: ${new URL(url).origin}`);
  });

  await page.goto(`${base}/locations`);
  await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add location' }).click();
  const create = page.getByRole('form', { name: 'Create a location draft' });
  await create.getByLabel('Location name').fill('Furniture QA Draft');
  await create.getByLabel('Building').fill('Synthetic Building');
  await create.getByLabel('Floor width (m)').fill('12');
  await create.getByLabel('Floor height (m)').fill('8');
  await create.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/locations\/[^/]+\/details$/);
  const draftId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
  await page.getByRole('heading', { name: 'Furniture QA Draft', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add rectangle table' }).click();
  await page.getByLabel('Table name').fill('Furniture test table');
  await page.getByLabel('Capacity').fill('4');
  await page.getByRole('button', { name: 'Generate seats' }).click();
  await page.getByTestId('location-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  let saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(saved.document.tables.length, 1);
  assert.equal(saved.document.tables[0].seats.length, 4, 'the fixture table has four authored seat anchors');
  const tableId = saved.document.tables[0].id;
  const authoredTable = structuredClone(saved.document.tables[0]);
  const roomSettings = page.getByTestId('location-room-settings');
  assert.equal(await roomSettings.getAttribute('open'), null, 'secondary location details start collapsed');
  const assertSelectedNameVisible = async (width, height, view = 'collapsed') => {
    await page.setViewportSize({ width, height });
    const inspector = page.getByTestId('location-editor-inspector');
    await inspector.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-testid="location-editor-inspector"]')?.scrollTop === 0);
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const geometry = await page.evaluate(() => {
      const inspector = document.querySelector('[data-testid="location-editor-inspector"]');
      const input = inspector?.querySelector('input[aria-label="Table name"]');
      const pane = inspector?.getBoundingClientRect(), field = input?.closest('.loc-field')?.getBoundingClientRect(), control = input?.getBoundingClientRect();
      const hit = control ? document.elementFromPoint(control.left + control.width / 2, control.top + control.height / 2) : null;
      return { scrollTop: inspector?.scrollTop, pane: pane && { left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom },
        field: field && { left: field.left, right: field.right, top: field.top, bottom: field.bottom },
        control: control && { left: control.left, right: control.right, top: control.top, bottom: control.bottom }, hit: hit === input || !!(input && hit && input.contains(hit)) };
    });
    assert.equal(geometry.scrollTop, 0, 'selected table controls are tested at inspector scrollTop zero');
    assert.ok(geometry.field && geometry.control && geometry.pane
      && geometry.field.left >= geometry.pane.left - 1 && geometry.field.right <= geometry.pane.right + 1
      && geometry.field.top >= geometry.pane.top - 1 && geometry.field.bottom <= geometry.pane.bottom + 1
      && geometry.control.top >= geometry.pane.top - 1 && geometry.control.bottom <= geometry.pane.bottom + 1 && geometry.hit,
    `the selected Table name label and input are fully visible and hit-testable at ${width}x${height} (${view}): ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: join(artifacts, `details-selected-name-${view}-${width}x${height}.png`) });
  };
  await assertSelectedNameVisible(1366, 768);
  await assertSelectedNameVisible(1440, 900);
  await roomSettings.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="location-room-settings"]')?.open === true);
  await assertSelectedNameVisible(1366, 768, 'location-details-expanded');
  await assertSelectedNameVisible(1440, 900, 'location-details-expanded');

  await page.getByTestId('location-step-model').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
  await page.getByText('No table model default. Built-in rooms use a generated table fallback.', { exact: true }).waitFor();
  await page.getByText('No chair model default. Built-in rooms use a generated chair fallback.', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Choose model', exact: true }).first().click();
  const dialog = page.getByTestId('location-furniture-library-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('Display name').fill('QA Table Asset');
  await dialog.getByLabel('Furniture upload type').selectOption('table');
  await dialog.getByLabel('Upload shared furniture GLB').setInputFiles(sampleGlb);
  await dialog.getByRole('button', { name: 'Upload model', exact: true }).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid="location-furniture-library-dialog"]');
    const status = dialog?.querySelector('.loc-furniture-upload [role="status"]')?.textContent ?? '';
    return !!dialog?.querySelector('.loc-furniture-upload [role="alert"]') || /uploaded to the shared library/i.test(status);
  });
  const uploadFeedback = await dialog.locator('.loc-furniture-upload [role="status"], .loc-furniture-upload [role="alert"]').allTextContents();
  assert.match(uploadFeedback.join(' '), /uploaded to the shared library.*not been assigned/i,
    `upload is confirmed without changing the room assignment: ${uploadFeedback.join(' ')}`);
  await page.screenshot({ path: join(artifacts, 'furniture-upload-unassigned.png') });
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(saved.document.furnitureDefaults, undefined, 'library upload alone leaves the saved room assignment unchanged');
  await dialog.getByLabel('Filter furniture by type').selectOption('chair');
  await dialog.getByText(/No models match this filter yet/).waitFor();
  await dialog.getByLabel('Filter furniture by type').selectOption('table');
  const tableRow = dialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: 'QA Table Asset' });
  await tableRow.waitFor();
  const libraryList = (await (await context.request.get(`${base}/api/furniture-library?type=table`)).json()).data;
  const tableAssetId = libraryList.items.find((item) => item.displayName.includes('QA Table Asset')).assetId;
  const resultRegion = dialog.getByTestId('location-furniture-results');
  assert.equal(await resultRegion.getAttribute('role'), 'region');
  assert.equal(await resultRegion.getAttribute('tabindex'), '0', 'the named result list is keyboard-focusable and scrollable');
  let keyboardReachedUse = false;
  for (let index = 0; index < 10; index += 1) {
    const active = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    if (/^Use QA Table Asset/.test(active)) { keyboardReachedUse = true; break; }
    await page.keyboard.press('Tab');
  }
  assert.equal(keyboardReachedUse, true, 'Tab navigation reaches the compatible model action in the native library dialog');
  await page.route(`${base}/api/furniture-library/${tableAssetId}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: 'Retry in the test fixture.' } }) }));
  await page.keyboard.press('Enter');
  await dialog.getByRole('alert').filter({ hasText: /could not be checked for preview/i }).waitFor();
  assert.doesNotMatch(await page.getByTestId('location-furniture-default-table').innerText(), /QA Table Asset/,
    'a failed private preflight leaves the current furniture assignment unchanged');
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(saved.document.furnitureDefaults, undefined, 'the failed selection does not mutate the saved draft');
  await page.screenshot({ path: join(artifacts, 'furniture-selection-retry.png') });
  await page.unroute(`${base}/api/furniture-library/${tableAssetId}`);
  await tableRow.getByRole('button', { name: /^Use / }).focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLButtonElement && active.textContent?.trim() === 'Change model'
      && active.closest('.loc-furniture-slot')?.querySelector('legend')?.textContent?.includes('Table model default');
  }), true, 'closing the native dialog restores keyboard focus to the room table-slot opener');
  await page.getByTestId('location-furniture-default-table').filter({ hasText: /QA Table Asset.*Table model/ }).waitFor();
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    return viewer?.scene?.furnitureGroup?.children.length === 1;
  });
  const cameraBeforeFit = await page.evaluate(() => {
    const scene = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').scene;
    return { position: scene.camera.position.toArray(), target: scene.controls.target.toArray() };
  });
  await page.getByTestId('location-default-table-scale').fill('1.25');
  await page.getByTestId('location-default-table-yawDeg').fill('45');
  await page.getByTestId('location-default-table-elevationM').fill('0.2');
  const beforeFurnitureSave = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(beforeFurnitureSave.document.furnitureDefaults, undefined, 'the selection and fit stay in the unsaved editor draft');
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    return viewer?.scene?.furnitureGroup?.children.length === 1;
  });
  const liveTableModel = await page.evaluate(() => {
    const scene = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').scene;
    const table = scene.furnitureGroup.children[0];
    const footprint = scene.tables[0].footprint;
    const center = footprint.type === 'circle' ? footprint.center : (() => {
      let crossSum = 0, centerX = 0, centerZ = 0;
      for (let index = 0; index < footprint.points.length; index += 1) {
        const current = footprint.points[index], next = footprint.points[(index + 1) % footprint.points.length];
        const cross = current.x * next.z - next.x * current.z;
        crossSum += cross; centerX += (current.x + next.x) * cross; centerZ += (current.z + next.z) * cross;
      }
      return { x: centerX / (3 * crossSum), z: centerZ / (3 * crossSum) };
    })();
    return { source: scene.source, scale: table.scale.toArray(), rotationY: table.rotation.y, elevation: table.position.y,
      fallbackNames: scene.furnitureFallback.children.map((child) => child.name), anchor: table.position.toArray(),
      expectedAnchor: [center.x, 0.2, center.z],
      camera: { position: scene.camera.position.toArray(), target: scene.controls.target.toArray() } };
  });
  assert.deepEqual(liveTableModel.scale, [1.25, 1.25, 1.25]);
  assert.ok(Math.abs(liveTableModel.rotationY - Math.PI / 4) < 1e-6);
  assert.equal(liveTableModel.elevation, 0.2);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(liveTableModel.camera.position[axis] - cameraBeforeFit.position[axis]) < 0.03, `fit edits retain camera position axis ${axis}`);
    assert.ok(Math.abs(liveTableModel.camera.target[axis] - cameraBeforeFit.target[axis]) < 0.03, `fit edits retain camera target axis ${axis}`);
  }
  for (let axis = 0; axis < 3; axis += 1) assert.ok(Math.abs(liveTableModel.anchor[axis] - liveTableModel.expectedAnchor[axis]) < 1e-6,
    `the table model uses the exact logical footprint anchor on axis ${axis}`);
  assert.ok(!liveTableModel.fallbackNames.some((name) => name.startsWith('generated-table-')), 'the assigned GLB replaces its generated table proxy');
  await page.screenshot({ path: join(artifacts, 'generated-room-table-model-1366x768.png') });
  await page.getByTestId('location-model-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(saved.document.furnitureDefaults.table.assetId, tableAssetId);
  assert.deepEqual(saved.document.furnitureDefaults.table, { assetId: tableAssetId, scale: 1.25, yawDeg: 45, elevationM: 0.2 });
  assert.equal(saved.document.tables[0].id, authoredTable.id);
  assert.deepEqual(saved.document.tables[0].shape, authoredTable.shape, 'fitting never changes the logical table footprint');
  assert.deepEqual(saved.document.tables[0].seats, authoredTable.seats, 'fitting never changes authored seat anchors');
  assert.equal(saved.document.tables[0].capacity, authoredTable.capacity, 'fitting never changes logical capacity');
  assert.deepEqual(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}').map((entry) => entry.status), [503, 200],
    'failed selection recovery performs one failed private preflight followed by one successful read reused by preview');

  await page.getByTestId('location-step-details').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
  await page.getByTestId('location-table-furniture-options').locator('summary').click();
  await page.getByTestId(`location-furniture-mode-${tableId}-table`).selectOption('override');
  assert.equal(await page.getByTestId(`table-${tableId}-table-scale`).inputValue(), '1.25', 'table override starts as a complete copy of the room default');
  await page.getByTestId(`table-${tableId}-table-scale`).fill('2');
  await page.getByRole('button', { name: 'Reset to room default', exact: true }).click();
  assert.equal(await page.getByTestId(`location-furniture-mode-${tableId}-table`).inputValue(), 'inherit');

  await page.getByTestId('location-step-model').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  const chairDialog = page.getByTestId('location-furniture-library-dialog');
  await chairDialog.waitFor({ state: 'visible' });
  await chairDialog.getByLabel('Display name').fill('QA Chair Asset');
  await chairDialog.getByLabel('Furniture upload type').selectOption('chair');
  await chairDialog.getByLabel('Upload shared furniture GLB').setInputFiles(sampleGlb);
  await chairDialog.getByRole('button', { name: 'Upload model', exact: true }).click();
  await chairDialog.getByRole('status').filter({ hasText: /uploaded to the shared library.*not been assigned/i }).waitFor();
  await chairDialog.getByLabel('Filter furniture by type').selectOption('table');
  const wrongTypeRow = chairDialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: 'QA Table Asset' });
  await wrongTypeRow.waitFor();
  assert.equal(await wrongTypeRow.getByRole('button', { name: /Wrong type/ }).isDisabled(), true, 'a table asset cannot be selected for the chair slot');
  await chairDialog.getByLabel('Filter furniture by type').selectOption('chair');
  const chairRow = chairDialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: 'QA Chair Asset' });
  await chairRow.waitFor();
  await chairRow.getByRole('button', { name: /^Use / }).click();
  await chairDialog.waitFor({ state: 'hidden' });
  await page.getByTestId('location-furniture-default-chair').filter({ hasText: /QA Chair Asset.*Chair model/ }).waitFor();
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    return viewer?.scene?.furnitureGroup?.children.length === 5;
  });
  const chairAnchorCheck = await page.evaluate(() => {
    const scene = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').scene;
    return { seats: scene.tables[0].seats.map((seat) => ({ x: seat.position.x, z: seat.position.z, side: seat.side })),
      chairs: scene.furnitureGroup.children.slice(1).map((chair) => ({ x: chair.position.x, z: chair.position.z, yaw: chair.rotation.y, elevation: chair.position.y })) };
  });
  assert.equal(chairAnchorCheck.chairs.length, chairAnchorCheck.seats.length, 'chair model replacement creates one model at every authored seat');
  for (const seat of chairAnchorCheck.seats) {
    const chair = chairAnchorCheck.chairs.find((candidate) => Math.abs(candidate.x - seat.x) < 1e-6 && Math.abs(candidate.z - seat.z) < 1e-6);
    assert.ok(chair, `the chair instance uses authored seat anchor ${seat.x}, ${seat.z}`);
    const expectedYaw = seat.side === 'L' ? Math.PI / 2 : seat.side === 'R' ? -Math.PI / 2 : seat.side === 'T' ? Math.PI : 0;
    assert.ok(Math.abs(chair.yaw - expectedYaw) < 1e-6, `the chair instance preserves existing seat-side orientation ${seat.side}`);
    assert.equal(chair.elevation, 0);
  }

  await page.getByTestId('location-step-details').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
  await page.getByTestId('location-table-furniture-options').locator('summary').click();
  await page.getByTestId(`location-furniture-mode-${tableId}-chair`).selectOption('override');
  assert.equal(await page.getByTestId(`table-${tableId}-chair-scale`).inputValue(), '1', 'chair override also copies the full inherited fit');
  assert.match(await page.locator('[data-testid="location-table-furniture"]').innerText(), /override applies to this table and all of its seats/);
  await page.getByRole('button', { name: 'Reset to room default', exact: true }).last().click();
  assert.equal(await page.getByTestId(`location-furniture-mode-${tableId}-chair`).inputValue(), 'inherit');
  await page.getByTestId('location-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  const chairAssetId = saved.document.furnitureDefaults.chair.assetId;
  assert.deepEqual(saved.document.tables[0].shape, authoredTable.shape, 'table/chair model assignments preserve logical shape');
  assert.deepEqual(saved.document.tables[0].seats, authoredTable.seats, 'table/chair model assignments preserve logical seats');
  assert.equal(saved.document.tables[0].capacity, authoredTable.capacity, 'table/chair model assignments preserve capacity');
  assert.equal(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}' && entry.status === 200).length, 2,
    'the manager preflights each unique selected model once and the scene reuses cached bytes');

  await page.getByTestId('location-step-model').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
  await page.getByRole('button', { name: 'Change model', exact: true }).first().click();
  const staleDialog = page.getByTestId('location-furniture-library-dialog');
  await staleDialog.waitFor({ state: 'visible' });
  await staleDialog.getByLabel('Display name').fill('QA Stale Selection');
  await staleDialog.getByLabel('Furniture upload type').selectOption('table');
  await staleDialog.getByLabel('Upload shared furniture GLB').setInputFiles(sampleGlb);
  await staleDialog.getByRole('button', { name: 'Upload model', exact: true }).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid="location-furniture-library-dialog"]');
    return /uploaded to the shared library/i.test(dialog?.querySelector('.loc-furniture-upload [role="status"]')?.textContent ?? '');
  });
  const staleLibrary = (await (await context.request.get(`${base}/api/furniture-library?type=table`)).json()).data;
  const staleItem = staleLibrary.items.find((item) => item.displayName.includes('QA Stale Selection'));
  assert.ok(staleItem, 'the stale-response fixture is available as a private unassigned library item');
  const stalePath = `${base}/api/furniture-library/${staleItem.assetId}`;
  const readResponsesBeforeStale = network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}').length;
  const catalogReadsBeforeReopen = network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library').length;
  const liveModelResources = await page.evaluate(() => {
    const scene = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer')?.scene;
    if (!scene) return null;
    const resources = { geometry: new Set(), material: new Set(), texture: new Set() };
    for (const entry of scene.furnitureModels.values()) {
      if (entry.status !== 'loaded' || !entry.template) continue;
      entry.template.traverse((object) => {
        if (object.geometry) resources.geometry.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        for (const material of materials) {
          resources.material.add(material);
          for (const value of Object.values(material)) if (value?.isTexture) resources.texture.add(value);
        }
      });
    }
    const totals = Object.fromEntries(Object.entries(resources).map(([kind, items]) => [kind, items.size]));
    const disposed = { geometry: 0, material: 0, texture: 0 };
    for (const [kind, items] of Object.entries(resources)) for (const item of items) {
      item.addEventListener('dispose', () => { disposed[kind] += 1; }, { once: true });
    }
    const originalDispose = scene.dispose.bind(scene);
    scene.dispose = () => {
      originalDispose();
      window.__furnitureSceneDisposeEvidence = {
        disposed: scene.disposed, cachedModels: scene.furnitureModels.size, cachedBuffers: scene.furnitureBuffers.size,
        totals, disposedResources: { ...disposed },
      };
    };
    return { cachedModels: scene.furnitureModels.size, resourceTotals: totals };
  });
  assert.ok(liveModelResources && liveModelResources.cachedModels >= 2 && liveModelResources.resourceTotals.geometry > 0 && liveModelResources.resourceTotals.material > 0,
    `both assigned models have live owned resources before editor teardown: ${JSON.stringify(liveModelResources)}`);
  let releaseStaleResponse;
  let finishStaleResponse;
  let startedStaleResponse;
  const staleResponseStarted = new Promise((resolveStarted) => { startedStaleResponse = resolveStarted; });
  const staleResponseFinished = new Promise((resolveFinished) => { finishStaleResponse = resolveFinished; });
  await page.route(stalePath, async (route) => {
    startedStaleResponse();
    await new Promise((resolveResponse) => { releaseStaleResponse = resolveResponse; });
    try { await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: readFileSync(sampleGlb) }); }
    catch { /* An aborted private read is expected after leaving this draft. */ }
    finally { finishStaleResponse(); }
  });
  const staleRow = staleDialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: 'QA Stale Selection' });
  await staleRow.waitFor();
  await staleRow.getByRole('button', { name: /^Use / }).click();
  await staleResponseStarted;
  for (let navigation = 0; navigation < 10 && new URL(page.url()).pathname !== '/locations'; navigation += 1) {
    const previousPath = new URL(page.url()).pathname;
    await page.goBack();
    await page.waitForFunction((path) => location.pathname !== path, previousPath);
  }
  await page.waitForURL(`${base}/locations`);
  releaseStaleResponse();
  await staleResponseFinished;
  await page.unroute(stalePath);
  assert.equal(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}').length, readResponsesBeforeStale,
    'leaving a draft aborts its in-flight private furniture read before any stale response can be applied');
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.equal(saved.document.furnitureDefaults.table.assetId, tableAssetId, 'the delayed stale selection leaves the saved room assignment unchanged');
  assert.equal(saved.document.tables[0].furnitureOverrides, undefined, 'the delayed stale selection never writes a table override');
  const disposalEvidence = await page.evaluate(() => window.__furnitureSceneDisposeEvidence ?? null);
  assert.ok(disposalEvidence && disposalEvidence.disposed && disposalEvidence.cachedModels === 0 && disposalEvidence.cachedBuffers === 0,
    `unmount clears the private furniture cache: ${JSON.stringify(disposalEvidence)}`);
  for (const kind of ['geometry', 'material', 'texture']) {
    assert.equal(disposalEvidence.disposedResources[kind], disposalEvidence.totals[kind], `all cached furniture ${kind} resources are disposed exactly once`);
  }
  await page.reload();
  const draftCard = page.getByTestId('location-draft-list').getByRole('listitem').filter({ hasText: 'Furniture QA Draft' });
  await draftCard.getByRole('button', { name: 'Continue draft' }).click();
  await page.getByRole('heading', { name: 'Furniture QA Draft', exact: true }).waitFor();
  await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
  await page.getByTestId('location-step-review').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/review$`));
  const review = page.getByTestId('location-furniture-review');
  await review.getByText(/QA Table Asset.*Table model/).waitFor();
  await review.getByText(/QA Chair Asset.*Chair model/).waitFor();
  const reviewText = await review.innerText();
  assert.doesNotMatch(reviewText, /[0-9a-f]{8}-[0-9a-f-]{27}/i, 'Review shows safe library names and types, never private asset IDs');
  await page.screenshot({ path: join(artifacts, 'furniture-review-reopened-1366x768.png') });
  assert.equal(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library').length, catalogReadsBeforeReopen + 1,
    'reopening a saved furniture draft loads safe catalog metadata once');
  assert.equal(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}').length, 5,
    'selected models use one failed recovery attempt and four successful authenticated reads across initial preview and reopen');
  assert.equal(network.filter((entry) => entry.method === 'GET' && entry.path === '/api/furniture-library/{assetId}' && entry.status === 200).length, 4);
  assert.equal(network.some((entry) => /\/api\/public\/.*(?:model|asset)|\/models\//i.test(entry.path)), false,
    'the console preview never uses a public or student asset route');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the saved Review and furniture summary reflow without horizontal overflow on mobile');
  await page.screenshot({ path: join(artifacts, 'furniture-review-mobile-390x844.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });

  await page.getByTestId('location-step-model').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
  await page.getByLabel('Upload GLB').setInputFiles(sampleGlb);
  await page.getByTestId('location-model-filename').filter({ hasText: /qa-self-contained-textured-triangle\.glb/i }).waitFor();
  await page.getByTestId('location-custom-furniture-warning').waitFor();
  await page.waitForFunction(() => {
    const scene = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer')?.scene;
    return scene?.source === 'custom' && scene.furnitureGroup.children.length === 5 && scene.furnitureFallback.children.length === 0;
  });
  await page.getByRole('button', { name: 'Clear default', exact: true }).last().click();
  await page.getByTestId('location-furniture-default-chair').getByText('No chair model default. No chair overlay is assigned to the custom room.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  const restoreChairDialog = page.getByTestId('location-furniture-library-dialog');
  await restoreChairDialog.waitFor({ state: 'visible' });
  const restoreChair = restoreChairDialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: 'QA Chair Asset' });
  await restoreChair.getByRole('button', { name: /^Use / }).click();
  await restoreChairDialog.waitFor({ state: 'hidden' });
  await page.getByTestId('location-model-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  await page.getByTestId('location-step-review').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/review$`));
  await page.getByTestId('location-furniture-review').getByText(/Custom room GLBs should omit table and chair geometry/).waitFor();
  assert.equal(await page.getByTestId('location-publish').isEnabled(), true, 'the custom-room duplicate warning is informational and does not block publishing');
  saved = (await (await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`)).json()).data;
  assert.ok(saved.document.modelAssetId, 'custom-room upload is attached privately to the draft');
  assert.ok(saved.document.furnitureDefaults.table && saved.document.furnitureDefaults.chair, 'source changes preserve both room furniture assignments');
  assert.equal(network.some((entry) => entry.method === 'POST' && /\/publications\b/.test(entry.path)), false, 'the test never publishes the fixture draft');
  assert.deepEqual(browserErrors, [{ kind: 'console', message: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)' }],
    `only the intentional failed-preflight response is logged: ${JSON.stringify(browserErrors)}`);
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({
    runner: 'Local Playwright 1.63 / installed Chrome; signed synthetic manager session; disposable file persistence; loopback only',
    checks: [
      'upload remains unassigned; type filters work; keyboard can reach/use the compatible model action and focus returns to its opener',
      'generated GLB replaces the table primitive and applies exact scale/yaw/elevation at the authored anchor',
      'table and all-seat chair overrides copy complete inherited assignments and reset cleanly',
      'saved reopen warms safe library metadata; Review shows model names/types and no asset IDs',
      'leaving during a delayed private selection does not mutate the saved draft; unmount disposes cached furniture geometry, materials and textures exactly once',
      'custom-room overlay warning and source-specific no-default copy remain informational; custom preview adds no generated furniture proxies',
      'preview uses authenticated furniture-library reads only; no public asset route is requested',
      'selected-table name label and input stay visible and hit-testable at inspector scrollTop zero (location details collapsed/expanded at both desktop sizes); Review reflows at 390x844',
    ], network, browserErrors,
    screenshots: ['details-selected-name-collapsed-1366x768.png', 'details-selected-name-collapsed-1440x900.png', 'details-selected-name-location-details-expanded-1366x768.png', 'details-selected-name-location-details-expanded-1440x900.png', 'furniture-upload-unassigned.png', 'furniture-selection-retry.png', 'generated-room-table-model-1366x768.png', 'furniture-review-reopened-1366x768.png', 'furniture-review-mobile-390x844.png'],
  }, null, 2));
  process.stdout.write('Console furniture browser flow passed (5 scenario groups).\n');
  await context.close();
} catch (error) {
  const safeError = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1200) : 'Unknown browser failure';
  writeFileSync(join(artifacts, 'failure-trace.json'), JSON.stringify({ failure: safeError, network, browserErrors }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (handle) {
    await handle.dispose();
    await new Promise((done) => { handle.server.close(() => done()); handle.server.closeAllConnections(); });
  }
  if (runtime) await runtime.stop();
  persistence?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  const resolvedFixture = resolve(fixtureRoot);
  const fixturePrefix = `${resolve(tempRoot)}${process.platform === 'win32' ? '\\' : '/'}`;
  if (resolvedFixture.startsWith(fixturePrefix)) rmSync(resolvedFixture, { recursive: true, force: true });
}
