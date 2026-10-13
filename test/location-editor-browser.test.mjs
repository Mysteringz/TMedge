// Real signed-session editor acceptance using local Playwright/system Chrome.
// This is a standalone browser harness; it never reads .env or production data.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
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

const artifacts = resolve(process.env.LOCATION_EDITOR_ARTIFACT_DIR ?? 'tmp/task-3-1-browser-artifacts');
const tempRoot = resolve('tmp/wizard-e2e');
const planPng = resolve('../.codex/docs/new-location-add-wizard/task-2-3-location-api-and-assets/artifacts/synthetic-assets/valid-plan.png');
const planJpg = resolve('../.codex/docs/new-location-add-wizard/task-2-3-location-api-and-assets/artifacts/synthetic-assets/valid-plan.jpg');
mkdirSync(artifacts, { recursive: true });
mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
const fixtureRoot = mkdtempSync(join(tempRoot, 'run-'));
const sitePath = join(fixtureRoot, 'site.json'), nodesPath = join(fixtureRoot, 'nodes.json');
const dataDir = join(fixtureRoot, 'data'), usersPath = join(fixtureRoot, 'algo-users.json');
const password = randomBytes(24).toString('hex'), sessionSecret = randomBytes(32).toString('hex');
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
let failDraftDirectorySync = false;
const draftWriteOperations = {
  syncDirectory(path) {
    if (failDraftDirectorySync) throw new Error('Synthetic draft directory flush failure.');
    syncDirectory(path);
  },
};

function legacyOutline() {
  const points = [];
  const topLeft = -10, right = 410, bottom = 310;
  for (let i = 0; i <= 64; i++) points.push([topLeft + (right - topLeft) * i / 64, topLeft]);
  for (let i = 1; i <= 64; i++) points.push([right, topLeft + (bottom - topLeft) * i / 64]);
  for (let i = 1; i <= 64; i++) points.push([right - (right - topLeft) * i / 64, bottom]);
  for (let i = 1; i <= 64; i++) points.push([topLeft, bottom - (bottom - topLeft) * i / 64]);
  assert.equal(points.length, 257);
  return points;
}

const siteSeed = {
  site: { id: 'wizard-e2e-site', name: 'Synthetic Location Wizard QA' },
  floors: [{
    id: 'qa-legacy-floor', building: 'Legacy Annex', name: 'Legacy room', visibility: 'console', width: 400, height: 300,
    outline: legacyOutline(),
    zones: [{ id: 'qa-legacy-zone', name: 'Legacy area', polygon: [[-10, -10], [410, -10], [400, 300]] }],
    tables: [{ id: 'QA-LEGACY-TABLE', name: 'Legacy rectangle', zone: 'qa-legacy-zone', x: 0, y: 100, width: 40, height: 60, capacity: 1 }],
  }],
};
writeFileSync(sitePath, JSON.stringify(siteSeed));
writeFileSync(nodesPath, JSON.stringify({ nodes: [] }));

const users = new AlgoUsers(usersPath);
for (const [name, role] of [['qa-admin', 'admin'], ['qa-operator', 'operator'], ['qa-engineer', 'engineer'], ['qa-viewer', 'viewer']]) {
  await users.add(name, password, role);
}

const cfg = {
  edgeId: 'wizard-editor-e2e', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath, nodesPath,
  dataDir, recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'synthetic-only',
  flashToken: null, pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
  nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
};

let persistence, runtime, handle, browser;
const browserErrors = [], network = [], checks = [];
const jsonFrom = async (response) => {
  const envelope = await response.json();
  assert.ok(envelope && Object.hasOwn(envelope, 'data'), `expected API data envelope, got status ${response.status()}`);
  return envelope.data;
};
const typeSequentially = async (locator, value) => {
  await locator.fill('');
  await locator.pressSequentially(value, { delay: 8 });
  assert.equal(await locator.inputValue(), value, `raw decimal remains intact while typing ${value}`);
};
const pressRepeatedly = async (page, key, count) => {
  for (let i = 0; i < count; i++) await page.keyboard.press(key);
};
const readDraft = async (context, base, draftId) => jsonFrom(await context.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`));
const assertErrorAssociation = async (page, input, text) => {
  await input.waitFor({ state: 'visible' });
  await page.waitForFunction((element) => element.getAttribute('aria-invalid') === 'true', await input.elementHandle());
  const ids = (await input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  assert.ok(ids.length, 'invalid control has an aria-describedby association');
  const associated = await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).count()));
  assert.ok(associated.some((count) => count === 1), 'the described error is present in the document');
  assert.match(await page.locator(`[id="${ids[0]}"]`).innerText(), new RegExp(text, 'i'));
  await page.waitForFunction((element) => element === document.activeElement, await input.elementHandle());
};
const assertImageDecoded = async (page, image) => {
  const handle = await image.elementHandle();
  assert.ok(handle, 'image preview element exists');
  await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, handle);
  const dimensions = await image.evaluate((element) => ({ width: element.naturalWidth, height: element.naturalHeight }));
  assert.ok(dimensions.width > 0 && dimensions.height > 0, 'PNG/JPEG preview decoded without a CSP image failure');
};

async function run() {
  persistence = initializeFileLocationPersistence(sitePath, nodesPath, dataDir, draftWriteOperations);
  runtime = createEdgeRuntime(cfg, persistence.registry);
  const publicationRuntime = new EdgeLocationPublicationRuntime(runtime, persistence.siteSeed);
  const locationApi = (auth) => createLocationRouter({
    auth, edgeId: cfg.edgeId, siteSeed: persistence.siteSeed, drafts: persistence.drafts, published: persistence.published,
    snapshots: persistence.snapshots, assets: persistence.assets, assetMetadata: persistence.assetMetadata,
    coordinator: persistence.coordinator, runtime: publicationRuntime, suggestCoverage: computeLocationCoverageSuggestions, now: Date.now,
  });
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: sessionSecret, ALGO_USERS_FILE: usersPath }, cfg.adminPassword), undefined, { locationApi });
  await new Promise((done) => handle.server.once('listening', done));
  const base = `http://127.0.0.1:${handle.server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });

  const signIn = async (username, viewport = { width: 1440, height: 1000 }) => {
    const context = await browser.newContext({ viewport });
    assert.equal((await context.request.post(`${base}/auth/login`, { data: { username, password } })).status(), 200);
    return context;
  };
  const attachEvidence = (page) => {
    // The sandbox has no internet access; keep font styling deterministic without
    // letting an optional Google Fonts fetch become a browser failure.
    page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '/* offline browser fixture */' }));
    page.on('pageerror', (error) => browserErrors.push({ kind: 'pageerror', message: error.message.slice(0, 300) }));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/server responded with a status of (?:409|503)/i.test(text)) return; // Deliberate conflict/unavailable recovery probes.
      browserErrors.push({ kind: 'console', message: text.slice(0, 300) });
    });
    page.on('requestfailed', (request) => network.push({ method: request.method(), path: new URL(request.url()).pathname, result: 'failed' }));
    page.on('response', (response) => network.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }));
  };

  for (const username of ['qa-engineer', 'qa-viewer']) {
    const context = await signIn(username);
    const page = await context.newPage(); attachEvidence(page);
    await page.goto(`${base}/locations`);
    await page.getByRole('heading', { name: 'Location access unavailable' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Locations' }).count(), 0);
    const me = await context.request.get(`${base}/api/me`);
    assert.equal(me.status(), 200, 'location authorization does not intercept the shell session endpoint');
    assert.ok(!(await me.json()).capabilities.includes('locations.manage'));
    assert.equal((await context.request.get(`${base}/api/workspace/`)).status(), 200,
      'existing signed-in workspace APIs remain available to non-location managers');
    assert.equal((await context.request.get(`${base}/api/locations`)).status(), 403);
    assert.equal((await context.request.get(`${base}/api/locations/drafts/not-owned`)).status(), 403);
    await page.goto(`${base}/`);
    const search = page.getByRole('combobox', { name: 'Search the site or ask a question' });
    await search.waitFor(); await search.fill('Locations');
    assert.equal(await page.getByRole('option').filter({ hasText: 'Locations' }).count(), 0);
    assert.ok(!(await page.locator('.ws-places').innerText()).includes('Locations'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Navigation menu' }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Locations' }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    checks.push(`${username}: API, direct route, desktop/mobile navigation, workspace places/search denied`);
    await context.close();
  }

  const adminContext = await signIn('qa-admin');
  assert.equal((await adminContext.request.get(`${base}/api/me`)).status(), 200, 'admin session route remains reachable');
  assert.equal((await adminContext.request.get(`${base}/api/workspace/`)).status(), 200, 'admin workspace route remains reachable');
  const page = await adminContext.newPage(); attachEvidence(page);
  await page.goto(`${base}/locations`);
  await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Locations' }).count(), 1);
  await page.screenshot({ path: join(artifacts, 'locations-list-desktop.png'), fullPage: true });
  const unknownLocationRoute = await adminContext.request.get(`${base}/api/locations/not-a-location-route`);
  assert.equal(unknownLocationRoute.status(), 404, 'authorized unknown location paths return the scoped JSON 404');
  assert.equal((await unknownLocationRoute.json()).error.code, 'NOT_FOUND');
  await page.getByRole('button', { name: 'Add location' }).click();
  const form = page.getByRole('form', { name: 'Create a location draft' });
  await form.getByLabel('Location name').fill('QA Editor Suite');
  await form.getByLabel('Building').fill('North QA Annex');
  const widthCreate = form.getByLabel('Floor width (m)');
  const heightCreate = form.getByLabel('Floor height (m)');
  await typeSequentially(widthCreate, '12.34'); await widthCreate.press('Tab');
  await typeSequentially(heightCreate, '8.76'); await heightCreate.press('Tab');
  await form.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/locations\/[^/]+\/details$/);
  const draftId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
  await page.getByRole('heading', { name: 'QA Editor Suite', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Floor width (m)').inputValue(), '12.34');
  assert.equal(await page.getByLabel('Floor height (m)').inputValue(), '8.76');
  assert.equal(await page.getByRole('button', { name: 'Main area', exact: true }).count(), 1);
  await page.screenshot({ path: join(artifacts, 'location-editor-desktop.png'), fullPage: true });

  // Dimension input remains decimal text through real sequential key events.
  const widthEditor = page.getByLabel('Floor width (m)');
  await typeSequentially(widthEditor, '12.34');
  await widthEditor.press('ArrowLeft');
  assert.equal(await widthEditor.inputValue(), '12.34', 'canvas keyboard shortcuts do not intercept text input arrows');
  await widthEditor.press('Tab');
  const heightEditor = page.getByLabel('Floor height (m)');
  await typeSequentially(heightEditor, '8.76'); await heightEditor.press('Tab');

  // Draw an additional named zone entirely with the keyboard and select a vertex to nudge.
  await page.getByRole('button', { name: 'Add zone' }).click();
  const canvas = page.locator('.loc-canvas');
  await page.waitForFunction(() => document.activeElement?.classList.contains('loc-canvas'));
  await pressRepeatedly(page, 'Shift+ArrowLeft', 5);
  await pressRepeatedly(page, 'Shift+ArrowUp', 5); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowRight', 10); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowDown', 10); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowLeft', 10); await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.getByLabel('Zone name').waitFor();
  await page.getByLabel('Zone name').fill('QA partition');
  const vertexButton = page.getByRole('button', { name: 'Select QA partition vertex 2' });
  await vertexButton.press('Enter');
  assert.equal(await vertexButton.getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => document.activeElement?.classList.contains('loc-canvas'));
  const vertexX = page.getByLabel('QA partition vertex 2 X (m)');
  const vertexY = page.getByLabel('QA partition vertex 2 Y (m)');
  const oldX = Number(await vertexX.inputValue()), oldY = Number(await vertexY.inputValue());
  await page.keyboard.press('ArrowRight');
  assert.equal(await canvas.evaluate((element) => document.activeElement === element), true, 'canvas keeps keyboard focus after a vertex nudge');
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForFunction(({ x, y }) => {
    const inputs = [...document.querySelectorAll('input')];
    return inputs.find((input) => input.getAttribute('aria-label') === x)?.value !== undefined
      && inputs.find((input) => input.getAttribute('aria-label') === y)?.value !== undefined;
  }, { x: 'QA partition vertex 2 X (m)', y: 'QA partition vertex 2 Y (m)' });
  assert.equal(Number(await vertexX.inputValue()), Number((oldX + 0.01).toFixed(2)));
  await page.waitForFunction(({ label, before }) => {
    const input = [...document.querySelectorAll('input')].find((item) => item.getAttribute('aria-label') === label);
    return input?.value !== String(before);
  }, { label: 'QA partition vertex 2 Y (m)', before: oldY });
  assert.equal(Number(await vertexY.inputValue()), Number((oldY - 0.1).toFixed(2)));
  assert.match(await page.locator('.loc-canvas-live').innerText(), /Zone vertex 2 moved to .* metres X and .* metres Y/i);
  await typeSequentially(vertexX, '6.25'); await vertexX.press('Tab');
  const committedZoneVertexY = Number(await vertexY.inputValue());
  await typeSequentially(vertexY, committedZoneVertexY.toFixed(2)); await vertexY.press('Tab');

  // Focus restoration: active zone sketch, polygon-table sketch, and no-sketch Escape.
  await page.getByRole('button', { name: 'Add zone' }).click();
  await canvas.waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'loc-add-zone');
  canvas.evaluate((element) => element.focus()); await page.keyboard.press('Escape');
  assert.equal(await canvas.evaluate((element) => document.activeElement === element), true, 'Escape without a sketch leaves focus on the canvas');
  await page.getByRole('button', { name: 'Draw polygon table' }).click();
  await page.getByRole('button', { name: 'Cancel sketch' }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'loc-add-polygon-table');
  checks.push('sequential decimal input, keyboard polygon drawing/vertex select/nudge and sketch focus restoration passed');

  // Rectangular values are converted to cm once at the editor boundary.
  await page.getByRole('button', { name: 'Add rectangle table' }).click();
  await page.getByLabel('Table name').fill('West rectangle');
  const rectX = page.getByLabel('Table X (m)'), rectY = page.getByLabel('Table Y (m)');
  const rectWidth = page.getByLabel('Table width (m)'), rectHeight = page.getByLabel('Table height (m)');
  await typeSequentially(rectX, '2.5'); await rectX.press('Tab');
  await typeSequentially(rectY, '1.25'); await rectY.press('Tab');
  await typeSequentially(rectWidth, '2.5'); await rectWidth.press('Tab');
  await typeSequentially(rectHeight, '1.5'); await rectHeight.press('Tab');
  await page.getByLabel('Table X (m)').waitFor();
  let rect = await page.getByLabel('Table X (m)').inputValue();
  assert.equal(rect, '2.5');
  await page.getByRole('button', { name: 'West rectangle', exact: true }).click();
  const seatX = page.getByLabel('Seat 1 X (m)'), seatY = page.getByLabel('Seat 1 Y (m)');
  await typeSequentially(seatX, '1.75'); await seatX.press('Tab');
  await typeSequentially(seatY, '0.9'); await seatY.press('Tab');

  // Distinct round-table center/radius and polygon-table vertex edit.
  await page.getByRole('button', { name: 'Add round table' }).click();
  await page.getByLabel('Table name').fill('East round table');
  const circleX = page.getByLabel('Circle center X (m)'), circleY = page.getByLabel('Circle center Y (m)'), circleRadius = page.getByLabel('Circle radius (m)');
  await typeSequentially(circleX, '3.5'); await circleX.press('Tab');
  await typeSequentially(circleY, '4'); await circleY.press('Tab');
  await typeSequentially(circleRadius, '2.5'); await circleRadius.press('Tab');
  await page.getByLabel('Capacity').fill('3'); await page.getByLabel('Capacity').press('Tab');
  await page.getByRole('button', { name: 'Generate seats' }).click();
  await page.getByLabel('Table zone').selectOption({ label: 'QA partition' });
  await page.getByRole('button', { name: 'Add rectangle table' }).waitFor();
  await page.getByRole('button', { name: 'Draw polygon table' }).click();
  await pressRepeatedly(page, 'Shift+ArrowLeft', 5); await pressRepeatedly(page, 'Shift+ArrowUp', 5); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowRight', 10); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowDown', 10); await page.keyboard.press('Space');
  await pressRepeatedly(page, 'Shift+ArrowLeft', 10); await page.keyboard.press('Space'); await page.keyboard.press('Enter');
  await page.getByLabel('Table name').fill('East polygon table');
  await page.getByLabel('Capacity').fill('5'); await page.getByLabel('Capacity').press('Tab');
  await page.getByRole('button', { name: 'Generate seats' }).click();
  const tableVertex = page.getByLabel('Table vertex 1 X (m)');
  await typeSequentially(tableVertex, '5.25'); await tableVertex.press('Tab');
  const tableVertexY = page.getByLabel('Table vertex 1 Y (m)');
  const polygonVertexY = Number((Number(await tableVertexY.inputValue()) + 0.01).toFixed(2));
  await typeSequentially(tableVertexY, polygonVertexY.toFixed(2)); await tableVertexY.press('Tab');

  // Field-specific error paths: width, height, table shape, seat and zone vertex.
  const saveButton = page.getByRole('button', { name: 'Save draft', exact: true });
  for (const [label, invalid, restore] of [
    ['Floor width (m)', '0.5', '12.34'], ['Floor height (m)', '0.5', '8.76'],
  ]) {
    const field = page.getByLabel(label); await field.fill(invalid); await field.press('Tab'); await saveButton.click();
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    assert.ok((await field.getAttribute('aria-describedby'))?.length);
    await page.waitForFunction((element) => element === document.activeElement, await field.elementHandle());
    await field.fill(restore); await field.press('Tab');
  }

  await page.getByRole('button', { name: 'West rectangle', exact: true }).click();
  const badRectX = page.getByLabel('Table X (m)'); await badRectX.fill('-0.1'); await badRectX.press('Tab'); await saveButton.click();
  await assertErrorAssociation(page, badRectX, 'X must be inside');
  await badRectX.fill('2.5'); await badRectX.press('Tab');
  const badSeat = page.getByLabel('Seat 1 X (m)'); await badSeat.fill('-0.5'); await badSeat.press('Tab'); await saveButton.click();
  await assertErrorAssociation(page, badSeat, 'Seat X must be inside');
  await badSeat.fill('1.75'); await badSeat.press('Tab');
  await page.getByRole('button', { name: 'QA partition', exact: true }).click();
  const badZoneVertex = page.getByLabel('QA partition vertex 4 X (m)');
  await badZoneVertex.fill('99'); await badZoneVertex.press('Tab'); await saveButton.click();
  await assertErrorAssociation(page, badZoneVertex, 'vertex 4 X must be inside');
  await badZoneVertex.fill('5.67'); await badZoneVertex.press('Tab');

  // A saved plan gives the delayed standalone save a real blank-canvas action
  // to freeze alongside the geometry and metadata inputs.
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planPng);
  await page.getByText('Floor plan saved to this private draft.', { exact: true }).waitFor();
  await assertImageDecoded(page, page.getByAltText('Private floor plan background preview'));
  let detail = await readDraft(adminContext, base, draftId);

  // A delayed normal draft save locks controls until the submitted revision is applied.
  const beforeDelayedSave = await readDraft(adminContext, base, draftId);
  await page.getByLabel('Location name').fill('QA Editor Suite · delayed save');
  let releaseDraftSave;
  let markDraftSaveStarted;
  let delayedSaveStatus;
  const draftSaveStarted = new Promise((done) => { markDraftSaveStarted = done; });
  await page.route('**/api/locations/drafts/*', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`) {
      const saved = await route.fetch();
      delayedSaveStatus = saved.status();
      markDraftSaveStarted();
      await new Promise((done) => { releaseDraftSave = done; });
      await route.fulfill({ response: saved });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await draftSaveStarted;
  assert.equal(await page.getByLabel('Location name').isDisabled(), true, 'metadata editing is frozen while a regular save is pending');
  assert.equal(await page.getByLabel('QA partition vertex 4 X (m)').isDisabled(), true, 'geometry editing is frozen while a regular save is pending');
  assert.equal(await page.getByLabel('Upload floor plan (PNG or JPEG)').isDisabled(), true, 'file selection is frozen while a regular save is pending');
  assert.equal(await page.getByTestId('location-step-sensors').isDisabled(), true, 'wizard navigation is frozen while a regular save is pending');
  assert.equal(await page.getByTestId('location-editor-back').isDisabled(), true, 'leaving the editor is frozen while a regular save is pending');
  assert.equal(await page.getByRole('button', { name: 'Use blank canvas' }).isDisabled(), true, 'the plan choice cannot race a pending save');
  releaseDraftSave();
  assert.equal(delayedSaveStatus, 200, 'the delayed standalone save received a successful server result');
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Location name').isDisabled(), false, 'the editor becomes available after applying the server revision');
  await page.unroute('**/api/locations/drafts/*');
  detail = await readDraft(adminContext, base, draftId);
  assert.equal(detail.draftRevision, beforeDelayedSave.draftRevision + 1);
  assert.equal(detail.document.name, 'QA Editor Suite · delayed save', 'the authoritative result matches the frozen submission');

  // Save-before-upload remains transactional: controls cannot mutate the captured candidate.
  await page.getByLabel('Location name').fill('QA Editor Suite · saved before upload');
  const beforeUploadSave = await readDraft(adminContext, base, draftId);
  const expectedUploadSaveRevision = beforeUploadSave.draftRevision + 1;
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((done) => { markUploadStarted = done; });
  await page.route('**/api/locations/drafts/*/assets/floor-plan', async (route) => {
    markUploadStarted();
    await new Promise((done) => { releaseUpload = done; });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: 'Synthetic upload failure.' } }) });
  });
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planPng);
  await uploadStarted;
  assert.equal(await page.getByLabel('Location name').isDisabled(), true, 'editing is frozen while save/upload transaction is pending');
  assert.equal(await page.getByLabel('QA partition vertex 4 X (m)').isDisabled(), true, 'geometry is frozen while save/upload is pending');
  assert.equal(await page.getByLabel('Upload floor plan (PNG or JPEG)').isDisabled(), true, 'a second file cannot replace the in-flight image');
  assert.equal(await page.getByTestId('location-step-sensors').isDisabled(), true, 'navigation is frozen while save/upload is pending');
  assert.equal(await page.getByTestId('location-editor-back').isDisabled(), true, 'the user cannot leave during save/upload');
  assert.equal(await page.getByRole('button', { name: 'Use blank canvas' }).isDisabled(), true, 'blank choice cannot race an upload');
  releaseUpload();
  await page.getByRole('alert').filter({ hasText: 'The plan upload failed; your selected image preview is retained for retry.' }).waitFor();
  assert.equal(await page.getByAltText('Selected floor plan preview; not uploaded').isVisible(), true);
  await assertImageDecoded(page, page.getByAltText('Selected floor plan preview; not uploaded'));
  assert.equal(await page.getByLabel('Location name').isDisabled(), false);
  await page.screenshot({ path: join(artifacts, 'location-upload-retry-state.png'), fullPage: true });
  await page.unroute('**/api/locations/drafts/*/assets/floor-plan');
  detail = await readDraft(adminContext, base, draftId);
  assert.equal(detail.document.name, 'QA Editor Suite · saved before upload', 'document save completes even when image upload fails');
  assert.equal(detail.draftRevision, expectedUploadSaveRevision);
  assert.ok((await page.getByRole('alert').innerText()).includes(`revision ${expectedUploadSaveRevision} was saved privately`));
  await page.getByRole('button', { name: 'Retry plan upload' }).click();
  await page.getByText('Floor plan saved to this private draft.', { exact: true }).waitFor();
  detail = await readDraft(adminContext, base, draftId);
  assert.equal(detail.document.widthCm, 1234);
  assert.equal(detail.document.heightCm, 876);
  const savedRect = detail.document.tables.find((item) => item.name === 'West rectangle');
  const savedCircle = detail.document.tables.find((item) => item.name === 'East round table');
  const savedPolygon = detail.document.tables.find((item) => item.name === 'East polygon table');
  assert.equal(savedRect.shape.x, 250); assert.equal(savedRect.shape.y, 125);
  assert.equal(savedRect.shape.width, 250); assert.equal(savedRect.shape.height, 150);
  assert.equal(savedRect.seats.length, 4); assert.equal(savedRect.seats[0].x, 175); assert.equal(savedRect.seats[0].y, 90);
  assert.equal(savedCircle.shape.cx, 350); assert.equal(savedCircle.shape.cy, 400);
  assert.equal(savedCircle.shape.radius, 250); assert.equal(savedCircle.seats.length, 3);
  assert.equal(savedCircle.zoneId, detail.document.zones.find((zone) => zone.name === 'QA partition').id);
  assert.equal(savedPolygon.shape.type, 'polygon');
  assert.equal(savedPolygon.shape.points[0][0], 525); assert.equal(savedPolygon.shape.points[0][1], Math.round(polygonVertexY * 100));
  assert.equal(savedPolygon.seats.length, 5);
  assert.equal(detail.document.zones.find((zone) => zone.name === 'QA partition').polygon[1][0], 625);
  assert.equal(detail.document.zones.find((zone) => zone.name === 'QA partition').polygon[1][1], Math.round(committedZoneVertexY * 100));
  assert.equal(detail.document.planAssetId ? true : false, true);

  // A stale upload is an explicit conflict: keep preview and offer both recovery actions.
  const remoteDocument = structuredClone(detail.document); remoteDocument.building = 'Remote update';
  const remoteSave = await adminContext.request.put(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}`, {
    data: { expectedDraftRevision: detail.draftRevision, document: remoteDocument }, headers: { 'x-tm-algo': '1', origin: base },
  });
  assert.equal(remoteSave.status(), 200);
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planJpg);
  await page.getByText('This draft changed before the plan upload completed. Your selected image preview is retained. Reload latest before retrying.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reload latest' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Keep my edits / copy changes' }).isVisible(), true);
  assert.equal(await page.getByAltText('Selected floor plan preview; not uploaded').isVisible(), true);
  await page.screenshot({ path: join(artifacts, 'location-conflict-recovery.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reload latest' }).click();
  await page.getByLabel('Building').waitFor();
  assert.equal(await page.getByLabel('Building').inputValue(), 'Remote update');
  await page.getByRole('button', { name: 'Retry plan upload' }).click();
  await page.getByText('Floor plan saved to this private draft.', { exact: true }).waitFor();

  // A real post-rename draft directory-sync failure returns an applied result.
  // Keep the local image and revision until an explicit GET re-syncs the file.
  failDraftDirectorySync = true;
  const uncertainUploadResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.endsWith(`/drafts/${encodeURIComponent(draftId)}/assets/floor-plan`));
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planPng);
  const uncertainResponse = await uncertainUploadResponse;
  assert.equal(uncertainResponse.status(), 200);
  const uncertainAlert = page.getByRole('alert').filter({ hasText: 'Floor plan attachment was applied to draft revision' });
  await uncertainAlert.waitFor();
  const uncertainRevision = Number(/draft revision (\d+)/i.exec(await uncertainAlert.innerText())?.[1]);
  const uncertainUpload = await persistence.drafts.getDraft('qa-admin', draftId);
  assert.ok(uncertainUpload);
  assert.equal(uncertainUpload.draftRevision, uncertainRevision, 'the UI applies the revision returned by the upload response');
  assert.ok(uncertainUpload.draftRevision > detail.draftRevision);
  await page.getByText(new RegExp(`Floor plan attachment was applied to draft revision ${uncertainUpload.draftRevision}`)).waitFor();
  assert.equal(await page.getByText(new RegExp(`Draft revision ${uncertainUpload.draftRevision} · private`)).count(), 1,
    'the returned applied draft revision is reflected in the editor');
  assert.equal(await page.getByAltText('Selected floor plan preview; not uploaded').isVisible(), true,
    'the selected file preview remains visible while durability is uncertain');
  assert.equal(await page.getByRole('button', { name: 'Retry plan upload' }).isDisabled(), true,
    'uncertain attachment is not blindly retried');
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true,
    'further writes are blocked until authoritative reload');
  const activeBeforeUnresolvedPublish = await persistence.published.getActive(uncertainUpload.locationId);
  const unresolvedPublish = await adminContext.request.post(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}/publications`, {
    data: { expectedDraftRevision: uncertainUpload.draftRevision, expectedPublishedRevision: null },
    headers: { 'x-tm-algo': '1', origin: base },
  });
  assert.equal(unresolvedPublish.status(), 503,
    'a direct publication request cannot bypass unresolved draft durability');
  assert.deepEqual(await persistence.published.getActive(uncertainUpload.locationId), activeBeforeUnresolvedPublish,
    'the blocked direct API publication leaves the active version unchanged');
  await page.screenshot({ path: join(artifacts, 'location-upload-unconfirmed.png'), fullPage: true });

  const failedRecoveryResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
  await page.getByRole('button', { name: 'Reload latest' }).click();
  assert.equal((await failedRecoveryResponse).status(), 503,
    'a normal draft GET cannot erase the unconfirmed outcome while file recovery still fails');
  failDraftDirectorySync = false;
  const recoveredResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
  await page.getByRole('button', { name: 'Reload latest' }).click();
  assert.equal((await recoveredResponse).status(), 200, 'explicit reload succeeds after exact file/directory recovery');
  await page.getByAltText('Private floor plan background preview').waitFor();
  detail = await readDraft(adminContext, base, draftId);
  assert.equal(detail.durability, 'confirmed');
  assert.equal(detail.draftRevision, uncertainUpload.draftRevision);
  assert.equal(detail.document.planAssetId, uncertainUpload.document.planAssetId);
  checks.push('post-rename file-writer fault returns applied-unconfirmed revision, retains preview, blocks retry/writes, and requires successful authoritative recovery');

  // A confirmed attachment followed by a failed detail read still applies the
  // returned revision and local preview, and offers an explicit reload retry.
  let failNextDetailRead = true;
  await page.route('**/api/locations/drafts/**', async (route) => {
    const request = route.request();
    if (failNextDetailRead && request.method() === 'GET'
      && new URL(request.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`) {
      failNextDetailRead = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic detail read failure.' } }) });
      return;
    }
    await route.continue();
  });
  const confirmedUploadResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.endsWith(`/drafts/${encodeURIComponent(draftId)}/assets/floor-plan`));
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planJpg);
  const confirmedResponse = await confirmedUploadResponse;
  assert.equal(confirmedResponse.status(), 200);
  const confirmedAlert = page.getByRole('alert').filter({ hasText: 'latest draft details could not be reloaded' });
  await confirmedAlert.waitFor();
  const confirmedRevision = Number(/saved to draft revision (\d+)/i.exec(await confirmedAlert.innerText())?.[1]);
  const confirmedUpload = await persistence.drafts.getDraft('qa-admin', draftId);
  assert.ok(confirmedUpload);
  assert.equal(confirmedUpload.draftRevision, confirmedRevision);
  assert.equal(await page.getByText(new RegExp(`Draft revision ${confirmedUpload.draftRevision} · private`)).count(), 1);
  assert.equal(await page.getByAltText('Selected floor plan preview; not uploaded').isVisible(), true,
    'failed readback retains the uploaded image preview until explicit reload');
  assert.equal(await page.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), true);
  await page.unroute('**/api/locations/drafts/**');
  await page.getByRole('button', { name: 'Reload latest' }).click();
  await page.getByAltText('Private floor plan background preview').waitFor();
  detail = await readDraft(adminContext, base, draftId);
  assert.equal(detail.draftRevision, confirmedUpload.draftRevision);
  assert.equal(detail.document.planAssetId, confirmedUpload.document.planAssetId);
  checks.push('confirmed upload plus failed detail read retains its applied revision/preview and succeeds only after explicit reload');

  // Review is read-only and separate; no publication occurs from a save or upload.
  await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
  await page.getByRole('heading', { name: 'Review location' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'location-review-private.png'), fullPage: true });
  let list = await jsonFrom(await adminContext.request.get(`${base}/api/locations`));
  assert.equal(list.published.length, 1, 'draft remains private until the explicit Publish location action');
  assert.equal(list.drafts.some((item) => item.draftId === draftId), true);

  // Responsive reflow and visible mobile targets.
  await page.getByRole('button', { name: 'Edit details & layout' }).click();
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'tablet has no horizontal overflow');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow');
  const addZoneBox = await page.getByRole('button', { name: 'Add zone' }).boundingBox();
  assert.ok(addZoneBox.height >= 44, 'mobile editor action has a 44px target');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const canvasBox = await page.locator('.loc-canvas').boundingBox();
  assert.ok(canvasBox);
  const touch = await page.context().newCDPSession(page);
  const viewBeforeTouch = await page.locator('.loc-canvas').getAttribute('viewBox');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: canvasBox.x + canvasBox.width * 0.88, y: canvasBox.y + canvasBox.height * 0.82, id: 41 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: canvasBox.x + canvasBox.width * 0.72, y: canvasBox.y + canvasBox.height * 0.68, id: 41 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction((before) => document.querySelector('.loc-canvas')?.getAttribute('viewBox') !== before, viewBeforeTouch);
  assert.notEqual(await page.locator('.loc-canvas').getAttribute('viewBox'), viewBeforeTouch, 'touch drag pans the zoomed mobile canvas');
  assert.equal(await page.getByText('Zoom 1.25×').count(), 1, 'mobile zoom control changes the view scale');
  await touch.detach();
  await page.getByRole('button', { name: 'Reset view' }).click();
  await page.screenshot({ path: join(artifacts, 'location-editor-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% browser-like zoom reflows without horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(artifacts, 'location-editor-desktop-final.png'), fullPage: true });
  checks.push('rect/circle/polygon, seat, zones, plan privacy, failed/delayed upload, stale conflict, private review and responsive/zoom checks passed');

  // Explicit publication is separate from saving/review and returns to the list.
  await page.getByRole('button', { name: 'Back to locations', exact: true }).click();
  await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add location' }).click();
  const publishForm = page.getByRole('form', { name: 'Create a location draft' });
  await publishForm.getByLabel('Location name').fill('QA Published Location');
  await publishForm.getByLabel('Building').fill('QA Publication Annex');
  await publishForm.getByLabel('Floor width (m)').fill('5');
  await publishForm.getByLabel('Floor width (m)').press('Tab');
  await publishForm.getByLabel('Floor height (m)').fill('4');
  await publishForm.getByLabel('Floor height (m)').press('Tab');
  let failInitialDraftRead = true;
  await page.route('**/api/locations/drafts/**', async (route) => {
    if (failInitialDraftRead && route.request().method() === 'GET'
      && /^\/api\/locations\/drafts\/[0-9a-f-]+$/i.test(new URL(route.request().url()).pathname)) {
      failInitialDraftRead = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic initial draft read failure.' } }) });
      return;
    }
    await route.continue();
  });
  await publishForm.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/locations\/[^/]+\/details$/);
  const publishDraftId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).isVisible(), true,
    'an initial draft-load failure has an explicit retry action');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByLabel('Location name').waitFor();
  await page.unroute('**/api/locations/drafts/**');
  await page.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planPng);
  await page.getByText('Floor plan saved to this private draft.', { exact: true }).waitFor();
  const createdPublishDraft = await readDraft(adminContext, base, publishDraftId);
  assert.ok(createdPublishDraft.document.planAssetId, 'the published base fixture contains an uploaded plan');
  assert.equal(createdPublishDraft.assetCapabilities.planAssetId.previewAvailable, true);
  await page.getByAltText('Private floor plan background preview').waitFor();
  await assertImageDecoded(page, page.getByAltText('Private floor plan background preview'));
  await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
  await page.getByRole('heading', { name: 'Review location' }).waitFor();
  const publicationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(publishDraftId)}/publications`);
  await page.getByRole('button', { name: 'Publish location' }).click();
  const publication = await publicationResponse;
  assert.equal(publication.status(), 200, 'explicit publication succeeds before the editor redirects');
  const publicationData = (await publication.json()).data;
  assert.equal(publicationData.publishedRevision, 1);
  assert.equal(publicationData.locationId, createdPublishDraft.locationId);
  await page.waitForURL(`${base}/locations`);
  const publishedList = await jsonFrom(await adminContext.request.get(`${base}/api/locations`));
  assert.equal(publishedList.published.find((item) => item.locationId === createdPublishDraft.locationId)?.activeRevision, 1,
    'the explicit Publish location action commits revision 1 before redirecting to the list');
  checks.push('draft-load retry and explicit publish success/redirect/active-revision path passed');

  // A separate operator edits the server-seeded legacy location through its real route.
  const operatorContext = await signIn('qa-operator');
  assert.equal((await operatorContext.request.get(`${base}/api/me`)).status(), 200, 'operator session route remains reachable');
  assert.equal((await operatorContext.request.get(`${base}/api/workspace/`)).status(), 200, 'operator workspace route remains reachable');
  const operatorPage = await operatorContext.newPage(); attachEvidence(operatorPage);
  await operatorPage.goto(`${base}/locations`);
  await operatorPage.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  assert.equal(await operatorPage.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Locations' }).count(), 1,
    'operators with locations.manage see Locations in desktop navigation');
  await operatorPage.setViewportSize({ width: 390, height: 844 });
  await operatorPage.getByRole('button', { name: 'Navigation menu' }).click();
  assert.equal(await operatorPage.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Locations' }).count(), 1,
    'operators with locations.manage see Locations in mobile navigation');
  await operatorPage.getByRole('button', { name: 'Navigation menu' }).click();
  await operatorPage.setViewportSize({ width: 1440, height: 1000 });
  const operatorInitialList = await jsonFrom(await operatorContext.request.get(`${base}/api/locations`));
  assert.equal(operatorInitialList.drafts.length, 0,
    'the operator list contains no private drafts owned by the admin');
  assert.ok(!operatorInitialList.drafts.some((draft) => draft.name === 'QA Editor Suite'));
  assert.ok(operatorInitialList.published.some((location) => location.name === 'QA Published Location'),
    'published locations remain visible even when their publisher owns private drafts');
  await operatorPage.getByText('You have no private drafts.', { exact: true }).waitFor();
  assert.equal(await operatorPage.getByRole('heading', { name: 'QA Editor Suite', exact: true }).count(), 0,
    'another manager’s saved private draft is omitted from the list');
  const inheritedPlanCard = operatorPage.locator('.loc-list-card').filter({ has: operatorPage.getByRole('heading', { name: 'QA Published Location', exact: true }) });
  await inheritedPlanCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await operatorPage.waitForURL(/\/locations\/[^/]+\/details$/);
  const inheritedPlanDraftId = decodeURIComponent(new URL(operatorPage.url()).pathname.split('/')[2]);
  await operatorPage.getByAltText('Private floor plan background preview').waitFor();
  await assertImageDecoded(operatorPage, operatorPage.getByAltText('Private floor plan background preview'));
  let inheritedPlanDraft = await readDraft(operatorContext, base, inheritedPlanDraftId);
  assert.equal(inheritedPlanDraft.document.planAssetId, createdPublishDraft.document.planAssetId,
    'the second manager inherits the exact base revision plan ID');
  assert.equal(inheritedPlanDraft.assetCapabilities.planAssetId.previewAvailable, true,
    'the second manager receives only the authorized exact-base preview capability');
  const inheritedPreview = await operatorContext.request.get(`${base}/api/locations/drafts/${encodeURIComponent(inheritedPlanDraftId)}/assets/${encodeURIComponent(inheritedPlanDraft.document.planAssetId)}`);
  assert.equal(inheritedPreview.status(), 200);
  assert.match(inheritedPreview.headers()['content-type'] ?? '', /^image\/png$/);
  assert.match(inheritedPreview.headers()['cache-control'] ?? '', /private, no-store/);
  await operatorPage.getByLabel('Location name').fill('QA Published Location inherited by operator');
  await operatorPage.getByRole('button', { name: 'Save draft', exact: true }).click();
  await operatorPage.getByText('Draft saved · private', { exact: true }).waitFor();
  await operatorPage.reload();
  await operatorPage.getByRole('heading', { name: 'QA Published Location inherited by operator', exact: true }).waitFor();
  await operatorPage.getByAltText('Private floor plan background preview').waitFor();
  const operatorAfterEditList = await jsonFrom(await operatorContext.request.get(`${base}/api/locations`));
  assert.ok(operatorAfterEditList.drafts.some((draft) => draft.name === 'QA Published Location inherited by operator'),
    'the operator can reload the operator-owned draft after an unchanged inherited-plan save');
  assert.ok(!operatorAfterEditList.drafts.some((draft) => draft.name === 'QA Editor Suite'),
    'the admin-owned private draft remains hidden after the operator starts an edit');
  inheritedPlanDraft = await readDraft(operatorContext, base, inheritedPlanDraftId);
  assert.equal(inheritedPlanDraft.document.planAssetId, createdPublishDraft.document.planAssetId,
    'an unchanged save and reload retain the original uploader asset reference');
  await operatorPage.getByRole('button', { name: 'Back to locations', exact: true }).click();
  await operatorPage.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  const legacyCard = operatorPage.locator('.loc-list-card').filter({ has: operatorPage.getByRole('heading', { name: 'Legacy room', exact: true }) });
  await legacyCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await operatorPage.waitForURL(/\/locations\/[^/]+\/details$/);
  const legacyDraftId = decodeURIComponent(new URL(operatorPage.url()).pathname.split('/')[2]);
  await operatorPage.getByRole('heading', { name: 'Legacy room', exact: true }).waitFor();
  assert.equal(await operatorPage.getByText('Console-only · not shown to students', { exact: true }).count(), 1);
  await operatorPage.getByLabel('Location name').fill('Legacy room renamed');
  await operatorPage.getByRole('button', { name: 'Save draft', exact: true }).click();
  await operatorPage.getByText(/Draft saved · private/i).waitFor();
  await operatorPage.reload(); await operatorPage.getByRole('heading', { name: 'Legacy room renamed', exact: true }).waitFor();
  let legacy = await readDraft(operatorContext, base, legacyDraftId);
  assert.equal(legacy.document.outline.length, 257);
  assert.deepEqual(legacy.document.zones[0].polygon, [[-10, -10], [410, -10], [400, 300]]);
  assert.equal(legacy.document.tables[0].shape, undefined);
  assert.deepEqual(legacy.document.tables[0].rect, { x: 0, y: 100, width: 40, height: 60 });
  assert.equal(legacy.document.tables[0].seats[0].x, -35); assert.equal(legacy.document.tables[0].seats[0].y, 130);
  const legacySeat = operatorPage.getByLabel('Seat 1 X (m)');
  await operatorPage.getByRole('button', { name: 'Legacy rectangle', exact: true }).click();
  await legacySeat.fill('-0.3'); await legacySeat.press('Tab');
  await operatorPage.getByRole('button', { name: 'Save draft', exact: true }).click();
  await assertErrorAssociation(operatorPage, legacySeat, 'Seat X must be inside');
  await legacySeat.fill('-0.35'); await legacySeat.press('Tab');
  await operatorPage.getByLabel('Upload floor plan (PNG or JPEG)').setInputFiles(planPng);
  await operatorPage.getByText('Floor plan saved to this private draft.', { exact: true }).waitFor();
  legacy = await readDraft(operatorContext, base, legacyDraftId);
  assert.equal(legacy.document.outline.length, 257);
  assert.equal(legacy.document.tables[0].shape, undefined);
  assert.equal(legacy.document.tables[0].seats[0].x, -35);
  await operatorPage.screenshot({ path: join(artifacts, 'legacy-edit-preserved.png'), fullPage: true });
  checks.push('real operator signed-session legacy edit, exact 257-point/off-floor preservation, strict changed-seat rejection, and plan round-trip passed');
  checks.push('admin-uploaded published plan remains privately previewable by a second manager only through the exact owned base draft after save/reload');

  // Keep a minimal, sanitized result summary; never include cookies, request bodies, or auth data.
  assert.deepEqual(browserErrors, [], `unexpected browser errors: ${JSON.stringify(browserErrors)}`);
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({
    runner: 'Local Playwright 1.63 / installed Chrome; real /auth/login sessions; temporary file persistence; loopback only',
    checks, network, browserErrors,
    screenshots: ['locations-list-desktop.png', 'location-editor-desktop.png', 'location-review-private.png', 'location-editor-mobile.png', 'legacy-edit-preserved.png'],
  }, null, 2));
  writeFileSync(join(artifacts, 'failure-trace.json'), JSON.stringify({
    expectedInjectedFailure: { route: 'PUT /api/locations/drafts/:draftId/assets/floor-plan', status: 503, assertion: 'draft revision committed; local image preview retained and retry remains available' },
    unexpectedFailures: [],
  }, null, 2));
  process.stdout.write(`Location editor browser acceptance passed (${checks.length} scenario groups).\n`);
}

try {
  await run();
} catch (error) {
  const safeMessage = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1200) : 'Unknown browser harness failure';
  writeFileSync(join(artifacts, 'failure-trace.json'), JSON.stringify({ unexpectedFailure: safeMessage, network }, null, 2));
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
  if (resolve(fixtureRoot).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) rmSync(fixtureRoot, { recursive: true, force: true });
}
