// Real signed-session editor acceptance using local Playwright/system Chrome.
// This is a standalone browser harness; it never reads .env or production data.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const artifacts = resolve(process.env.LOCATION_EDITOR_ARTIFACT_DIR ?? 'tmp/task-2-2-console-room-preview/artifacts');
const tempRoot = resolve('tmp/wizard-e2e');
const planPng = resolve('../.codex/docs/new-location-add-wizard/task-2-3-location-api-and-assets/artifacts/synthetic-assets/valid-plan.png');
const planJpg = resolve('../.codex/docs/new-location-add-wizard/task-2-3-location-api-and-assets/artifacts/synthetic-assets/valid-plan.jpg');
const texturedGlb = resolve('../tmp/new-location-add-wizard/task-3-3-qa-preparation/qa-self-contained-textured-triangle.glb');
const externalGlb = resolve('../tmp/new-location-add-wizard/task-3-3-qa-preparation/qa-external-resource-rejected.glb');
const truncatedGlb = resolve('../tmp/new-location-add-wizard/task-3-3-qa-preparation/qa-truncated-file-rejected.glb');
const malformedHeaderGlb = resolve('../tmp/new-location-add-wizard/task-3-3-qa-preparation/qa-malformed-header-rejected.glb');
mkdirSync(artifacts, { recursive: true });
mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
const fixtureRoot = mkdtempSync(join(tempRoot, 'run-'));
const sitePath = join(fixtureRoot, 'site.json'), nodesPath = join(fixtureRoot, 'nodes.json');
const dataDir = join(fixtureRoot, 'data'), usersPath = join(fixtureRoot, 'algo-users.json');
const SENSOR_A = 'aa:bb:cc:dd:ee:21', SENSOR_B = 'aa:bb:cc:dd:ee:22', RGB_SENSOR = 'aa:bb:cc:dd:ee:23';
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

function createMalformedEmbeddedImage(sourcePath, targetPath) {
  const bytes = readFileSync(sourcePath);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim());
  const imageView = json.bufferViews[json.images[0].bufferView];
  const binaryStart = 20 + jsonLength + 8;
  const imageStart = binaryStart + (imageView.byteOffset ?? 0);
  bytes.fill(0, imageStart, imageStart + imageView.byteLength);
  writeFileSync(targetPath, bytes);
  return targetPath;
}

function createDataUriEmbeddedImage(sourcePath, targetPath) {
  const source = readFileSync(sourcePath);
  const sourceJsonLength = source.readUInt32LE(12);
  const document = JSON.parse(source.toString('utf8', 20, 20 + sourceJsonLength).trim());
  const sourceBinaryHeader = 20 + sourceJsonLength;
  const sourceBinaryLength = source.readUInt32LE(sourceBinaryHeader);
  const sourceBinaryStart = sourceBinaryHeader + 8;
  const imageView = document.bufferViews[document.images[0].bufferView];
  const imageStart = sourceBinaryStart + (imageView.byteOffset ?? 0);
  const imageBytes = source.subarray(imageStart, imageStart + imageView.byteLength);
  document.images[0].uri = `data:${document.images[0].mimeType};base64,${imageBytes.toString('base64')}`;
  delete document.images[0].bufferView;

  const jsonBytes = Buffer.from(JSON.stringify(document), 'utf8');
  const paddedJsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  jsonBytes.copy(paddedJson);
  const binary = source.subarray(sourceBinaryStart, sourceBinaryStart + sourceBinaryLength);
  const totalLength = 12 + 8 + paddedJsonLength + 8 + binary.byteLength;
  const result = Buffer.alloc(totalLength);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(totalLength, 8);
  result.writeUInt32LE(paddedJsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(result, 20);
  const binaryHeader = 20 + paddedJsonLength;
  result.writeUInt32LE(binary.byteLength, binaryHeader);
  result.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(result, binaryHeader + 8);
  writeFileSync(targetPath, result);
  return targetPath;
}

const malformedEmbeddedImageGlb = createMalformedEmbeddedImage(texturedGlb, join(fixtureRoot, 'malformed-embedded-image.glb'));
const dataUriTexturedGlb = createDataUriEmbeddedImage(texturedGlb, join(fixtureRoot, 'data-uri-textured-image.glb'));

const siteSeed = {
  site: { id: 'wizard-e2e-site', name: 'Synthetic Location Wizard QA' },
  floors: [{
    id: 'qa-legacy-floor', building: 'Legacy Annex', name: 'Legacy room', visibility: 'console', width: 400, height: 300,
    outline: legacyOutline(),
    zones: [{ id: 'qa-legacy-zone', name: 'Legacy area', polygon: [[-10, -10], [410, -10], [400, 300]] }],
    tables: [{ id: 'QA-LEGACY-TABLE', name: 'Legacy rectangle', zone: 'qa-legacy-zone', x: 0, y: 100, width: 40, height: 60, capacity: 1 }],
    model: { assetId: '00000000-0000-4000-8000-000000000033', transform: {
      scale: { x: 1.1, y: 0.9, z: 1 }, rotationDeg: { x: 5, y: 15, z: -5 }, positionM: { x: 0.25, y: 0, z: -0.5 },
    } },
  }],
};
writeFileSync(sitePath, JSON.stringify(siteSeed));
writeFileSync(nodesPath, JSON.stringify({ nodes: [
  { uid: SENSOR_A, label: 'QA Ceiling Sensor A', simulated: false, rgb: false, detector: 'node' },
  { uid: SENSOR_B, label: 'QA Ceiling Sensor B', simulated: false, rgb: false, detector: 'node' },
  { uid: RGB_SENSOR, label: 'QA Console RGB', floor: 'qa-legacy-floor', pose: { x: 125.5, y: 160, heightCm: 350, yawDeg: 0, mirror: false }, owns: [], simulated: false, rgb: true, detector: 'node' },
] }));

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
const browserErrors = [], network = [], checks = [], expectedBrowserEvents = [], externalBrowserRequests = [], expectedHttpConsoleFailures = [];
let expectEmbeddedTextureFailure = false, expectRendererFailure = false;
const expectHttpConsoleFailure = (request, status) => {
  expectedHttpConsoleFailures.push({ method: request.method(), path: new URL(request.url()).pathname, status, responseSeen: false });
};
const expectHttpConsoleFailureAt = (method, path, status) => {
  expectedHttpConsoleFailures.push({ method, path, status, responseSeen: false });
};
const consoleLocationPath = (message) => {
  try { return new URL(message.location().url).pathname; } catch { return ''; }
};
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
const assertInlineErrorAssociation = async (page, input, text) => {
  await page.waitForFunction((element) => element.getAttribute('aria-invalid') === 'true', await input.elementHandle());
  const ids = (await input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  assert.ok(ids.length, 'invalid control has an aria-describedby association');
  assert.match(await page.locator(`[id="${ids.at(-1)}"]`).innerText(), new RegExp(text, 'i'));
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
      if (expectEmbeddedTextureFailure && /couldn.t load texture/i.test(text)) {
        expectEmbeddedTextureFailure = false;
        expectedBrowserEvents.push({ kind: 'embedded-texture-parse-failure', message: text.slice(0, 240) }); return;
      }
      if (expectRendererFailure && text === 'THREE.WebGLRenderer: QA injected one-shot renderer construction failure') {
        expectRendererFailure = false;
        expectedBrowserEvents.push({ kind: 'renderer-construction-failure', message: text.slice(0, 240) }); return;
      }
      const statusMatch = text.match(/server responded with a status of (\d{3})\b/i);
      if (statusMatch) {
        const path = consoleLocationPath(message);
        const status = Number(statusMatch[1]);
        const expectedIndex = expectedHttpConsoleFailures.findIndex((item) => item.responseSeen && item.path === path && item.status === status);
        if (expectedIndex >= 0) {
          const [expected] = expectedHttpConsoleFailures.splice(expectedIndex, 1);
          const { responseSeen: _responseSeen, ...details } = expected;
          expectedBrowserEvents.push({ kind: 'intercepted-http-error', ...details }); return;
        }
        browserErrors.push({ kind: 'console', path, status, message: text.slice(0, 300) }); return;
      }
      browserErrors.push({ kind: 'console', path: consoleLocationPath(message), message: text.slice(0, 300) });
    });
    page.on('requestfailed', (request) => network.push({
      method: request.method(), path: new URL(request.url()).pathname,
      result: 'failed', reason: request.failure()?.errorText ?? 'unknown',
    }));
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')
        && !url.startsWith('https://fonts.googleapis.com/')) externalBrowserRequests.push(url);
    });
    page.on('response', (response) => {
      const method = response.request().method(), path = new URL(response.url()).pathname, status = response.status();
      const expected = expectedHttpConsoleFailures.find((item) => !item.responseSeen && item.method === method && item.path === path && item.status === status);
      if (expected) expected.responseSeen = true;
      network.push({ method, path, status });
    });
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
    assert.equal((await context.request.get(`${base}/location-model-viewer.js?attempt=1`)).status(), 404,
      'the edge-hosted executable viewer entry is restricted to locations managers');
    assert.equal((await context.request.get(`${base}/location-model-viewer/scene.js`)).status(), 404,
      'the scene module is also restricted to locations managers');
    assert.equal((await context.request.get(`${base}/location-model/vendor/three/three.module.js`)).status(), 404,
      'the signed same-origin Three module mount is restricted to locations managers');
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
  const locationShell = await adminContext.request.get(`${base}/locations`);
  assert.equal(locationShell.status(), 200);
  const locationCsp = locationShell.headers()['content-security-policy'] ?? '';
  assert.match(locationCsp, /img-src 'self' data: blob:/, 'private plan previews use local image Blob URLs');
  assert.match(locationCsp, /connect-src 'self' data: blob:/, 'self-contained data and loader-owned Blob image resources are allowed');
  assert.doesNotMatch(locationCsp, /connect-src[^;]*(?:https?:|\*)/i, 'Blob support does not allow arbitrary network connections');
  const allowedThree = await adminContext.request.get(`${base}/location-model/vendor/three/three.module.js`);
  assert.equal(allowedThree.status(), 200, 'location managers can load the checked-in viewer core from the edge');
  assert.match(allowedThree.headers()['cache-control'] ?? '', /no-store/);
  const deniedVendorPath = await adminContext.request.get(`${base}/location-model/vendor/three/not-allowlisted.js`);
  assert.equal(deniedVendorPath.status(), 404, 'the signed mount does not expose arbitrary vendor files');
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
  const initialRoomDraft = await readDraft(adminContext, base, draftId);
  assert.equal(initialRoomDraft.document.proceduralRoom, 'simple-rectangle-v1', 'a new rectangular draft selects the persisted built-in room source');
  await page.getByTestId('location-room-preview-status').filter({ hasText: 'Built-in room preview ready.' }).waitFor();
  const generatedViewer = page.locator('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    return viewer?.scene?.source === 'generated' && viewer.scene.walls?.size === 4;
  });
  const initialRoomGeometry = await generatedViewer.evaluate(async (viewer) => {
    const THREE = await import('/location-model/vendor/three/three.module.js');
    const scene = viewer.scene;
    const wallBounds = [...scene.walls.values()].map((wall) => new THREE.Box3().setFromObject(wall).getSize(new THREE.Vector3()).y);
    return { source: scene.source, wallCount: scene.walls.size, hiddenWalls: [...scene.walls.values()].filter((wall) => !wall.visible).length, wallHeights: wallBounds };
  });
  assert.equal(initialRoomGeometry.source, 'generated');
  assert.equal(initialRoomGeometry.wallCount, 4, 'the empty built-in scene includes all four walls');
  assert.equal(initialRoomGeometry.hiddenWalls, 1, 'the initial cardinal camera view hides one camera-facing wall');
  assert.ok(initialRoomGeometry.wallHeights.every((height) => Math.abs(height - 3) < 1e-6), 'every wall mesh is exactly 3.0 m high');
  assert.equal(network.filter((request) => request.method === 'GET' && request.path.startsWith(`/api/locations/drafts/${draftId}/assets/`)).length, 0,
    'the generated source loads no model or asset bytes');
  await page.screenshot({ path: join(artifacts, 'location-generated-room-details-desktop.png'), fullPage: true });
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
  await page.getByTestId('location-model-zoom-in').click();
  await page.waitForTimeout(250);
  const cameraBeforeLiveTableEdit = await generatedViewer.evaluate((viewer) => ({ position: viewer.scene.camera.position.toArray(), target: viewer.scene.controls.target.toArray() }));
  await rectWidth.fill('2.6');
  await page.waitForFunction(async () => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    const table = viewer?.scene?.overlay?.children?.find((object) => object.name.startsWith('generated-table-'));
    if (!table) return false;
    const THREE = await import('/location-model/vendor/three/three.module.js');
    const size = new THREE.Box3().setFromObject(table).getSize(new THREE.Vector3());
    return Math.abs(size.x - 2.6) < 1e-5;
  });
  const liveTableGeometry = await generatedViewer.evaluate(async (viewer) => {
    const THREE = await import('/location-model/vendor/three/three.module.js');
    const scene = viewer.scene;
    scene.overlay.updateMatrixWorld(true);
    const table = scene.overlay.children.find((object) => object.name.startsWith('generated-table-'));
    const bounds = new THREE.Box3().setFromObject(table);
    return {
      size: bounds.getSize(new THREE.Vector3()).toArray(), maxY: bounds.max.y,
      seatCount: scene.overlay.children.filter((object) => object.name.startsWith('generated-seat-')).length,
      camera: { position: scene.camera.position.toArray(), target: scene.controls.target.toArray() },
    };
  });
  assert.ok(Math.abs(liveTableGeometry.size[0] - 2.6) < 1e-5 && Math.abs(liveTableGeometry.size[2] - 1.5) < 1e-5,
    'the generated rectangle mesh uses the live 2D dimensions exactly');
  assert.ok(Math.abs(liveTableGeometry.maxY - 0.75) < 1e-6, 'the generated table mesh top is exactly 0.75 m above the floor');
  assert.equal(liveTableGeometry.seatCount, 4, 'the generated scene places one chair proxy at each stored seat');
  for (const axis of ['position', 'target']) for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(liveTableGeometry.camera[axis][index] - cameraBeforeLiveTableEdit[axis][index]) < 0.03,
      `a live layout edit preserves camera ${axis} component ${index}`);
  }
  const wallVisibility = await generatedViewer.evaluate((viewer) => {
    const scene = viewer.scene;
    const centerX = scene.widthM / 2, centerZ = -scene.heightM / 2;
    scene.camera.position.set(centerX, 5, centerZ + 10); scene.updateWallVisibility();
    const cardinal = [...scene.walls].filter(([, wall]) => !wall.visible).map(([name]) => name);
    scene.camera.position.set(centerX + 10, 5, centerZ + 10); scene.updateWallVisibility();
    const diagonal = [...scene.walls].filter(([, wall]) => !wall.visible).map(([name]) => name);
    scene.camera.position.set(centerX, 5, centerZ - 10); scene.updateWallVisibility();
    const opposite = [...scene.walls].filter(([, wall]) => !wall.visible).map(([name]) => name);
    return { cardinal, diagonal, opposite };
  });
  assert.deepEqual(wallVisibility.cardinal, ['north']);
  assert.deepEqual(wallVisibility.diagonal.sort(), ['east', 'north']);
  assert.deepEqual(wallVisibility.opposite, ['south'], 'camera-facing walls restore as the orbit crosses the room');
  await generatedViewer.evaluate((viewer) => viewer.scene.resetCamera());
  await rectWidth.fill('2.5'); await rectWidth.press('Tab');
  checks.push('generated preview starts with four exact-height walls, updates exact table/seat meshes immediately, retains camera state, and hides/restores cardinal/diagonal camera-facing walls');

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
  const incompleteWidth = page.getByLabel('Floor width (m)');
  await incompleteWidth.fill('12.');
  await page.getByTestId('location-room-preview-status').filter({ hasText: 'Last valid preview. Fix the highlighted 2D fields to update the preview.' }).waitFor();
  assert.equal(await incompleteWidth.getAttribute('aria-invalid'), 'true', 'an incomplete decimal is exposed as invalid before blur');
  await incompleteWidth.fill('12.34'); await incompleteWidth.press('Tab');
  await page.waitForFunction(() => !document.querySelector('[data-testid="location-room-preview-status"]')?.textContent?.includes('Last valid preview'));
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
  const badRectX = page.getByLabel('Table X (m)'); await badRectX.fill('-0.1');
  await page.getByTestId('location-room-preview-status').filter({ hasText: 'Last valid preview. Fix the highlighted 2D fields to update the preview.' }).waitFor();
  await badRectX.press('Tab'); await saveButton.click();
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

  // The Sensors step reads the current eligible registry list, but edits only
  // the private authored document. A public draft never offers the console
  // RGB sensor that is attached to the seeded console-only legacy floor.
  await page.getByTestId('location-step-sensors').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/sensors$`));
  await page.getByRole('heading', { name: 'Sensors', exact: true }).waitFor();
  const eligibleResponse = await adminContext.request.get(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}/sensors`);
  assert.equal(eligibleResponse.status(), 200);
  const eligibleResult = await jsonFrom(eligibleResponse);
  assert.ok(eligibleResult.sensors.some((sensor) => sensor.uid === SENSOR_A && sensor.pose === null));
  assert.ok(eligibleResult.sensors.some((sensor) => sensor.uid === SENSOR_B && sensor.pose === null));
  assert.ok(!eligibleResult.sensors.some((sensor) => sensor.uid === RGB_SENSOR), 'public location sensor choices omit RGB sensors');
  const sensorAButton = page.getByTestId('location-sensor-aa-bb-cc-dd-ee-21');
  await sensorAButton.click();
  assert.equal(await page.getByText('Pose not set', { exact: true }).count(), 1, 'an unplaced sensor has no guessed pose');
  assert.equal(await page.getByLabel('Position X (m)').inputValue(), '');
  assert.equal(await page.getByLabel('Position Y (m)').inputValue(), '');
  assert.equal(await page.getByLabel('Height (m)').inputValue(), '', 'mounting height must be entered explicitly');
  const sensorX = page.getByLabel('Position X (m)'), sensorY = page.getByLabel('Position Y (m)'), sensorHeight = page.getByLabel('Height (m)');
  await typeSequentially(sensorX, '3.75'); await sensorX.press('Tab');
  await typeSequentially(sensorY, '2.5'); await sensorY.press('Tab');
  await typeSequentially(sensorHeight, '1.49'); await sensorHeight.press('Tab');
  await page.getByTestId('location-room-preview-status').filter({ hasText: 'Last valid preview. Fix the highlighted 2D fields to update the preview.' }).waitFor();
  await assertInlineErrorAssociation(page, sensorHeight, '(?:mounting height|value).*1\\.5.*15');
  await typeSequentially(sensorHeight, '15.01'); await sensorHeight.press('Tab');
  await assertInlineErrorAssociation(page, sensorHeight, '(?:mounting height|value).*1\\.5.*15');
  await typeSequentially(sensorHeight, '1.5'); await sensorHeight.press('Tab');
  assert.notEqual(await sensorHeight.getAttribute('aria-invalid'), 'true', 'the minimum mounting height is accepted');
  await typeSequentially(sensorHeight, '15'); await sensorHeight.press('Tab');
  assert.notEqual(await sensorHeight.getAttribute('aria-invalid'), 'true', 'the maximum mounting height is accepted');
  await typeSequentially(sensorHeight, '3.5'); await sensorHeight.press('Tab');
  const yaw = page.getByLabel('Yaw (°)'); await typeSequentially(yaw, '15.5'); await yaw.press('Tab');
  await page.getByLabel('Mirror orientation').check();
  await page.getByTestId('location-sensor-add').click();
  await page.getByTestId('location-canvas-sensor-aa-bb-cc-dd-ee-21').waitFor();
  await page.getByText('Available for this location · In this draft').waitFor();

  const sensorBButton = page.getByTestId('location-sensor-aa-bb-cc-dd-ee-22');
  await sensorBButton.click();
  const sensorBX = page.getByLabel('Position X (m)'), sensorBY = page.getByLabel('Position Y (m)'), sensorBHeight = page.getByLabel('Height (m)');
  await typeSequentially(sensorBX, '9.5'); await sensorBX.press('Tab');
  await typeSequentially(sensorBY, '2.5'); await sensorBY.press('Tab');
  await typeSequentially(sensorBHeight, '4'); await sensorBHeight.press('Tab');
  await page.getByTestId('location-sensor-add').click();
  await page.getByTestId('location-canvas-sensor-aa-bb-cc-dd-ee-22').waitFor();

  // Assigned sensor keyboard movement uses 1 cm arrows and 10 cm with Shift,
  // and does not alter unrelated pose fields or the other sensor.
  await sensorAButton.click();
  await page.waitForFunction((testId) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed') === 'true', 'location-sensor-aa-bb-cc-dd-ee-21');
  const sensorMap = page.getByTestId('location-floor-canvas');
  await sensorMap.focus();
  assert.match(await sensorMap.getAttribute('aria-label'), /Use arrow keys to move the selected sensor/);
  assert.equal(await sensorMap.evaluate((element) => document.activeElement === element), true, 'keyboard focus is on the sensor map');
  await sensorMap.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[aria-label="Position X (m)"]')?.value === '3.76');
  assert.equal(await page.getByLabel('Position X (m)').inputValue(), '3.76');
  assert.equal(await page.getByLabel('Position Y (m)').inputValue(), '2.5', 'ArrowRight changes X only');
  await sensorMap.press('Shift+ArrowDown');
  await page.waitForFunction(() => document.querySelector('[aria-label="Position Y (m)"]')?.value === '2.6');
  assert.equal(await page.getByLabel('Position X (m)').inputValue(), '3.76', 'Shift+ArrowDown leaves X unchanged');
  assert.equal(await page.getByLabel('Position Y (m)').inputValue(), '2.6', 'Shift+ArrowDown changes Y by 10 cm');
  assert.equal(await page.getByLabel('Height (m)').inputValue(), '3.5');
  assert.equal(await page.getByLabel('Yaw (°)').inputValue(), '15.5');
  assert.equal(await page.getByLabel('Mirror orientation').isChecked(), true);

  const sensorAMarker = page.getByTestId('location-canvas-sensor-aa-bb-cc-dd-ee-21');
  const markerBox = await sensorAMarker.boundingBox();
  assert.ok(markerBox);
  const beforePointer = { x: await page.getByLabel('Position X (m)').inputValue(), y: await page.getByLabel('Position Y (m)').inputValue() };
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(markerBox.x + markerBox.width / 2 + 20, markerBox.y + markerBox.height / 2 - 15, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(({ x, y }) => document.querySelector('[aria-label="Position X (m)"]')?.value !== x
    && document.querySelector('[aria-label="Position Y (m)"]')?.value !== y, beforePointer);
  assert.equal(await page.getByLabel('Height (m)').inputValue(), '3.5', 'pointer drag preserves height');
  assert.equal(await page.getByLabel('Yaw (°)').inputValue(), '15.5', 'pointer drag preserves yaw');
  assert.equal(await page.getByLabel('Mirror orientation').isChecked(), true, 'pointer drag preserves mirror');

  await sensorBButton.click();
  await page.waitForFunction((testId) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed') === 'true', 'location-sensor-aa-bb-cc-dd-ee-22');
  await page.waitForFunction(() => document.querySelector('[aria-label="Position X (m)"]')?.value === '9.5',
    undefined, { timeout: 5000 });
  assert.equal(await page.getByLabel('Position X (m)').inputValue(), '9.5');
  assert.equal(await page.getByLabel('Position Y (m)').inputValue(), '2.5');
  assert.equal(await page.getByLabel('Height (m)').inputValue(), '4');
  assert.equal(await page.getByLabel('Yaw (°)').inputValue(), '0');
  assert.equal(await page.getByLabel('Mirror orientation').isChecked(), false);

  const sensorStepDraft = await readDraft(adminContext, base, draftId);
  const westTable = sensorStepDraft.document.tables.find((table) => table.name === 'West rectangle');
  const roundTable = sensorStepDraft.document.tables.find((table) => table.name === 'East round table');
  assert.ok(westTable);
  assert.ok(roundTable);
  const westCoverageTestId = `location-table-coverage-${westTable.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const roundCoverageTestId = `location-table-coverage-${roundTable.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  await page.getByTestId(westCoverageTestId).waitFor();
  await page.waitForFunction((testId) => document.querySelector(`[data-testid="${testId}"]`)?.textContent?.includes('seats covered'), westCoverageTestId);
  const westOwner = page.getByLabel('Assigned owner for West rectangle');
  await westOwner.selectOption(SENSOR_A);
  await page.waitForFunction((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    return row?.textContent?.includes('seats covered') && !row.querySelector('select')?.disabled;
  }, westCoverageTestId);

  // A stale request can neither keep its old count actionable nor overwrite a newer candidate.
  let releaseOldCoverage;
  let markOldCoverageStarted;
  let markOldCoverageFinished;
  let markNewCoverageFinished;
  const oldCoverageStarted = new Promise((done) => { markOldCoverageStarted = done; });
  const oldCoverageFinished = new Promise((done) => { markOldCoverageFinished = done; });
  const newCoverageFinished = new Promise((done) => { markNewCoverageFinished = done; });
  let delayedCoverageRequest, currentCoverageRequest;
  let interceptedCoverage = 0;
  await page.route('**/api/locations/drafts/*/coverage-suggestions', async (route) => {
    const candidate = route.request().postDataJSON();
    interceptedCoverage += 1;
    const responseFor = (unionCovered) => ({ data: { locationId: sensorStepDraft.locationId, suggestions: [
      { tableId: westTable.id, coveredBy: [], suggestedOwner: null, seatCoverage: {
        totalSeats: westTable.seats.length, coveredSeats: unionCovered,
        bySensor: [{ uid: SENSOR_A, coveredSeats: 2 }, { uid: SENSOR_B, coveredSeats: 2 }],
      } },
      { tableId: roundTable.id, coveredBy: [SENSOR_B], suggestedOwner: SENSOR_B, seatCoverage: {
        totalSeats: roundTable.seats.length, coveredSeats: roundTable.seats.length,
        bySensor: [{ uid: SENSOR_A, coveredSeats: 0 }, { uid: SENSOR_B, coveredSeats: roundTable.seats.length }],
      } },
    ] } });
    if (interceptedCoverage === 1) {
      delayedCoverageRequest = candidate;
      markOldCoverageStarted();
      await new Promise((done) => { releaseOldCoverage = done; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(2)) });
      markOldCoverageFinished();
      return;
    }
    if (interceptedCoverage === 2) {
      currentCoverageRequest = candidate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(westTable.seats.length)) });
      markNewCoverageFinished();
      return;
    }
    await route.continue();
  });
  const sensorBXRace = page.getByLabel('Position X (m)');
  await typeSequentially(sensorBXRace, '9.4'); await sensorBXRace.press('Tab');
  await oldCoverageStarted;
  assert.equal(await westOwner.isDisabled(), true, 'owner actions stay disabled while counts are stale');
  await page.getByText('Coverage suggestions are updating; previous counts are not current.').waitFor();
  assert.equal(await page.getByText('2 / 4 seats covered', { exact: true }).count(), 0, 'old counts are not presented as current');
  await typeSequentially(sensorBXRace, '9.25'); await sensorBXRace.press('Tab');
  await newCoverageFinished;
  await page.getByText('4 / 4 seats covered', { exact: true }).waitFor();
  assert.deepEqual(delayedCoverageRequest.proposedSensors.map((item) => item.uid).sort(), [SENSOR_A, SENSOR_B].sort(), 'the delayed request includes the complete proposed sensor set');
  assert.deepEqual(currentCoverageRequest.proposedSensors.map((item) => item.uid).sort(), [SENSOR_A, SENSOR_B].sort(), 'the newest request also includes every current proposal');
  assert.equal(await westOwner.inputValue(), SENSOR_A, 'the full union does not silently select a sensor owner');
  const westCoverage = page.getByTestId(westCoverageTestId);
  assert.equal(await page.getByRole('columnheader', { name: 'Draft status' }).count(), 1,
    'owner status is identified as private draft state rather than live occupancy');
  assert.match(await westCoverage.innerText(), /All seats covered/i);
  assert.match(await westCoverage.innerText(), /Needs attention.*draft owner must cover every seat \(2\/4\)/i,
    'the selected owner is evaluated separately from union coverage');
  const roundSuggestion = page.getByTestId(`location-table-use-suggestion-${roundTable.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`);
  assert.equal(await roundSuggestion.count(), 1, 'a distinct full-seat suggestion remains explicitly actionable');
  const reassignmentCoverageResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/coverage-suggestions'));
  await roundSuggestion.click();
  const roundOwner = page.getByLabel('Assigned owner for East round table');
  await page.waitForFunction((uid) => document.querySelector('[aria-label="Assigned owner for East round table"]')?.value === uid, SENSOR_B);
  await reassignmentCoverageResponse;
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, roundCoverageTestId);
  assert.equal(await roundOwner.inputValue(), SENSOR_B, 'accepting a suggestion explicitly assigns only its table');
  const latestWestCoverage = await westCoverage.innerText();
  await releaseOldCoverage();
  await oldCoverageFinished;
  assert.equal(await westCoverage.innerText(), latestWestCoverage, 'a late older response cannot replace the latest coverage result');
  assert.equal(await westOwner.inputValue(), SENSOR_A, 'a late older response cannot overwrite the newest candidate');
  await page.unroute('**/api/locations/drafts/*/coverage-suggestions');
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, westCoverageTestId);
  await westOwner.selectOption(SENSOR_B);
  assert.equal(await westOwner.inputValue(), SENSOR_B, 'the owner can be changed explicitly after current coverage arrives');
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, westCoverageTestId);
  const clearOwnerCoverage = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/coverage-suggestions'));
  await roundOwner.selectOption('');
  await clearOwnerCoverage;
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, roundCoverageTestId);
  assert.equal(await roundOwner.inputValue(), '', 'clearing the owner remains an explicit draft choice');
  assert.match(await page.getByTestId(roundCoverageTestId).innerText(), /Unknown/,
    'an unowned table remains unknown even when suggestions exist');
  const reassignRoundCoverage = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/coverage-suggestions'));
  await roundOwner.selectOption(SENSOR_B);
  await reassignRoundCoverage;
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, roundCoverageTestId);

  let failCoverageOnce = true;
  await page.route('**/api/locations/drafts/*/coverage-suggestions', async (route) => {
    if (failCoverageOnce && route.request().method() === 'POST') {
      failCoverageOnce = false;
      expectHttpConsoleFailure(route.request(), 503);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic coverage failure.' } }) });
      return;
    }
    await route.continue();
  });
  await sensorAButton.click();
  const retryPoseX = page.getByLabel('Position X (m)');
  await typeSequentially(retryPoseX, '3.77'); await retryPoseX.press('Tab');
  await page.getByRole('alert').filter({ hasText: 'Synthetic coverage failure.' }).waitFor();
  assert.equal(await retryPoseX.inputValue(), '3.77', 'suggestion failure preserves the unsaved local sensor pose');
  assert.equal(await page.getByLabel('Mirror orientation').isChecked(), true);
  await page.getByTestId('location-coverage-retry').click();
  await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"] select`)?.disabled, westCoverageTestId);
  await page.unroute('**/api/locations/drafts/*/coverage-suggestions');
  assert.equal(await retryPoseX.inputValue(), '3.77', 'Retry refreshes coverage without discarding the local pose');
  assert.equal(await westOwner.inputValue(), SENSOR_B, 'Retry retains the explicit draft owner');
  const expectedSensorAPose = {
    x: Number(await retryPoseX.inputValue()) * 100,
    y: Math.round(Number(await page.getByLabel('Position Y (m)').inputValue()) * 100 * 100) / 100,
    heightCm: Number(await page.getByLabel('Height (m)').inputValue()) * 100,
    yawDeg: Number(await page.getByLabel('Yaw (°)').inputValue()),
    mirror: await page.getByLabel('Mirror orientation').isChecked(),
  };
  await page.screenshot({ path: join(artifacts, 'location-sensors-union-owner-desktop.png'), fullPage: true });
  await page.getByTestId('location-sensors-save').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  let sensorDraft = await readDraft(adminContext, base, draftId);
  const savedSensorA = sensorDraft.document.sensorAssignments.find((assignment) => assignment.uid === SENSOR_A);
  const savedSensorB = sensorDraft.document.sensorAssignments.find((assignment) => assignment.uid === SENSOR_B);
  assert.deepEqual(savedSensorA.pose, expectedSensorAPose, 'keyboard/pointer pose and preserved mounting fields round-trip exactly');
  assert.deepEqual(savedSensorA.owns, [], 'changing the table owner removes its previous owner');
  assert.deepEqual(savedSensorB.pose, { x: 925, y: 250, heightCm: 400, yawDeg: 0, mirror: false });
  const sensorSceneEvidence = await generatedViewer.evaluate(async (viewer, uid) => {
    const THREE = await import('/location-model/vendor/three/three.module.js');
    const scene = viewer.scene;
    const token = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const marker = scene.overlay.getObjectByName(`draft-sensor-${token}`);
    const arrow = scene.overlay.getObjectByName(`draft-sensor-yaw-${token}`);
    const direction = arrow ? new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.quaternion) : null;
    return { position: marker?.position.toArray(), yawDirection: direction?.toArray() };
  }, SENSOR_B);
  assert.deepEqual(sensorSceneEvidence.position, [9.25, 4, -2.5], 'the generated sensor mesh keeps authored X/Y and its exact 4 m height above the wall top');
  assert.ok(Math.abs(sensorSceneEvidence.yawDirection[0] - 1) < 1e-6 && Math.abs(sensorSceneEvidence.yawDirection[2]) < 1e-6,
    'the sensor orientation arrow follows the authored zero-degree yaw');
  await page.getByTestId('location-room-preview-object-list').getByText('QA Ceiling Sensor B', { exact: false }).waitFor();
  assert.match(await page.getByTestId('location-room-preview-object-list').innerText(), /4\.00 m high/,
    'the text alternative exposes a sensor height above the 3 m wall top');
  assert.deepEqual(savedSensorB.owns.sort(), [roundTable.id, westTable.id].sort(), 'suggestion acceptance and explicit owner selection assign distinct tables to the same sensor');
  for (const uid of [SENSOR_A, SENSOR_B]) {
    const live = persistence.registry.nodes.get(uid);
    assert.equal(live?.floorId, null, 'private draft edits do not move live sensor assignment');
    assert.equal(live?.pose, null, 'private draft edits do not change live sensor pose');
  }

  // A later registry change makes B stale without deleting its authored private
  // assignment. Suggestions exclude it, and publish rechecks the latest state.
  const originalNodesFile = readFileSync(nodesPath);
  const staleNodesConfig = JSON.parse(originalNodesFile.toString('utf8'));
  const staleNode = staleNodesConfig.nodes.find((node) => node.uid === SENSOR_B);
  assert.ok(staleNode, 'the synthetic approved sensor exists in the isolated file registry');
  staleNode.floor = 'qa-legacy-floor';
  staleNode.pose = { ...savedSensorB.pose };
  staleNode.owns = [];
  staleNodesConfig.revision += 1;
  writeFileSync(nodesPath, JSON.stringify(staleNodesConfig));
  try {
    const staleProposalRequest = page.waitForRequest((request) => request.method() === 'POST'
      && new URL(request.url()).pathname.endsWith('/coverage-suggestions'));
    await page.reload();
    await page.getByRole('heading', { name: 'Sensors', exact: true }).waitFor();
    await page.getByTestId('location-sensor-stale-aa-bb-cc-dd-ee-22').waitFor();
    await page.getByText(/no longer eligible/i).first().waitFor();
    const staleProposal = await staleProposalRequest;
    assert.deepEqual(staleProposal.postDataJSON().proposedSensors.map((item) => item.uid), [SENSOR_A],
      'the complete proposal retains eligible placements and excludes the stale assignment');
    const staleDraft = await readDraft(adminContext, base, draftId);
    assert.deepEqual(staleDraft.document.sensorAssignments.find((item) => item.uid === SENSOR_B)?.owns.sort(),
      [roundTable.id, westTable.id].sort(), 'reload retains the stale assignment and its table ownership');
    const activeBeforeStalePublish = await persistence.published.getActive(staleDraft.locationId);
    const snapshotBeforeStalePublish = await persistence.snapshots.readSnapshot();
    const stalePublish = await adminContext.request.post(`${base}/api/locations/drafts/${encodeURIComponent(draftId)}/publications`, {
      data: { expectedDraftRevision: staleDraft.draftRevision, expectedPublishedRevision: null },
      headers: { 'x-tm-algo': '1', origin: base },
    });
    assert.equal(stalePublish.status(), 409, 'publish rejects the now-ineligible saved sensor assignment as a live registry conflict');
    const stalePublishBody = await stalePublish.json();
    assert.equal(stalePublishBody.error.code, 'CONFLICT');
    assert.deepEqual(await persistence.published.getActive(staleDraft.locationId), activeBeforeStalePublish,
      'stale publication rejection does not advance the active location revision');
    assert.deepEqual(await persistence.snapshots.readSnapshot(), snapshotBeforeStalePublish,
      'stale publication rejection does not mutate the live registry snapshot');
  } finally {
    writeFileSync(nodesPath, originalNodesFile);
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Sensors', exact: true }).waitFor();
  await page.getByTestId('location-sensor-aa-bb-cc-dd-ee-22').waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Sensors', exact: true }).waitFor();
  await page.getByTestId('location-sensor-aa-bb-cc-dd-ee-22').click();
  assert.equal(await page.getByLabel('Position X (m)').inputValue(), '9.25', 'sensor pose reloads from the private saved document');
  assert.equal(await page.getByLabel('Height (m)').inputValue(), '4');
  assert.equal(await page.getByLabel('Assigned owner for West rectangle').inputValue(), SENSOR_B, 'table owner reloads from the private saved document');
  assert.equal(await page.getByLabel('Assigned owner for East round table').inputValue(), SENSOR_B, 'the explicitly accepted suggestion reloads with the private draft');
  await page.getByTestId('location-step-details').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
  await page.getByRole('button', { name: 'QA partition', exact: true }).click();
  checks.push('eligible sensor filtering; unplaced pose/height bounds/mirror; Arrow/Shift+Arrow keyboard nudges and pointer drag change only X/Y while preserving height/yaw/mirror; suggestion failure/retry retention; suggestion acceptance and clear-to-Unknown; unique owners; private reload; stale retention/proposal exclusion and publish revalidation with live state unchanged passed');

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
    expectHttpConsoleFailure(route.request(), 503);
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
  expectHttpConsoleFailureAt('PUT', `/api/locations/drafts/${encodeURIComponent(draftId)}/assets/floor-plan`, 409);
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
  expectHttpConsoleFailureAt('GET', `/api/locations/drafts/${encodeURIComponent(draftId)}`, 503);
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
      expectHttpConsoleFailure(request, 503);
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

  // Exercise the actual signed-in model step, its same-origin module graph,
  // immutable upload metadata, in-memory GLB parsing and transform persistence.
  await page.addInitScript(() => {
    const evidence = { createdUrls: [], revokedUrls: [], imageBitmapAttempts: 0, imageBitmapsCreated: 0, imageBitmapDecodeFailures: 0, imageBitmapsClosed: 0, rendererContextFailureAttempts: 0 };
    const rendererFailurePending = sessionStorage.getItem('wizard-model-renderer-failure') === 'pending';
    if (rendererFailurePending) sessionStorage.setItem('wizard-model-renderer-failure', 'used');
    globalThis.__failLocationModelRenderer = rendererFailurePending;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (globalThis.__failLocationModelRenderer && String(type) === 'webgl2'
        && this.getAttribute('data-engine')?.startsWith('three.js r')) {
        evidence.rendererContextFailureAttempts += 1;
        // Three marks its renderer canvas before requesting WebGL. Throwing on
        // its first candidate fails this one constructor deterministically;
        // disarm synchronously before the viewer can be retried.
        globalThis.__failLocationModelRenderer = false;
        throw new Error('QA injected one-shot renderer construction failure');
      }
      return getContext.call(this, type, ...args);
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      evidence.createdUrls.push({ url, type: blob.type, stack: new Error().stack ?? '' });
      return url;
    };
    URL.revokeObjectURL = (url) => { evidence.revokedUrls.push(String(url)); return revoke(url); };
    const createBitmap = globalThis.createImageBitmap.bind(globalThis);
    globalThis.createImageBitmap = async (...args) => {
      evidence.imageBitmapAttempts += 1;
      try {
        const bitmap = await createBitmap(...args);
        evidence.imageBitmapsCreated += 1;
        return bitmap;
      } catch (error) {
        evidence.imageBitmapDecodeFailures += 1;
        throw error;
      }
    };
    const bitmapPrototype = globalThis.ImageBitmap?.prototype;
    const close = bitmapPrototype && Object.getOwnPropertyDescriptor(bitmapPrototype, 'close');
    if (close?.value && close.configurable) Object.defineProperty(bitmapPrototype, 'close', {
      ...close, value() { evidence.imageBitmapsClosed += 1; return close.value.call(this); },
    });
    Object.defineProperty(globalThis, '__locationModelResourceEvidence', { value: evidence, configurable: false });
  });
  await page.reload();
  await page.getByLabel('Location name').waitFor();
  await page.evaluate(() => { globalThis.__failLocationModelRenderer = false; });
  let failModelRead = true;
  await page.getByTestId('location-step-model').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
  await page.getByRole('heading', { name: 'Room view', exact: true }).waitFor();
  await page.route('**/api/locations/drafts/*/assets/*', async (route) => {
    const request = route.request();
    if (failModelRead && request.method() === 'GET' && request.headers().accept === 'model/gltf-binary') {
      failModelRead = false;
      expectHttpConsoleFailure(request, 503);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Synthetic model-preview failure.' } }) });
      return;
    }
    await route.continue();
  });
  let releaseModelUpload, markModelUploadStarted;
  let gatedModelUploadStatus;
  const modelUploadStarted = new Promise((done) => { markModelUploadStarted = done; });
  await page.route(`**/api/locations/drafts/${draftId}/assets/model`, async (route) => {
    const response = await route.fetch();
    gatedModelUploadStatus = response.status();
    markModelUploadStarted();
    await new Promise((done) => { releaseModelUpload = done; });
    await route.fulfill({ response });
  });
  const publicUploadResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `/api/locations/drafts/${draftId}/assets/model`, { timeout: 45000 })
    .then((response) => ({ response }), (error) => ({ error }));
  const modelFileInput = page.getByTestId('location-model-upload');
  await modelFileInput.waitFor({ state: 'visible' });
  assert.equal(await modelFileInput.isDisabled(), false, 'model upload is enabled after authoritative draft recovery');
  await modelFileInput.setInputFiles({
    name: 'QA textured alignment.glb', mimeType: 'model/gltf-binary', buffer: readFileSync(texturedGlb),
  });
  const uploadRouteStarted = await Promise.race([
    modelUploadStarted.then(() => true), new Promise((done) => setTimeout(() => done(false), 10000)),
  ]);
  assert.equal(uploadRouteStarted, true, `the GLB upload request reached the edge route; UI problem: ${await page.locator('.loc-alert').allInnerTexts()}`);
  try {
    await page.getByTestId('location-model-upload-progress').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('location-model-save-draft').isDisabled(), true,
      'draft writes cannot race an upload transaction');
    assert.equal(await page.getByTestId('location-model-continue').isDisabled(), true,
      'navigation cannot leave the upload transaction pending');
  } finally { releaseModelUpload(); }
  const uploadEvent = await publicUploadResponse;
  assert.ok('response' in uploadEvent, `the model upload returned a browser response: ${'error' in uploadEvent ? uploadEvent.error : ''}`);
  const publicUpload = uploadEvent.response;
  assert.equal(gatedModelUploadStatus, 200); assert.equal(publicUpload.status(), 200);
  await page.unroute(`**/api/locations/drafts/${draftId}/assets/model`);
  await page.getByTestId('location-model-preview-retry').waitFor();
  await page.getByTestId('location-model-preview-retry').click();
  await page.getByText('GLB preview loaded.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="location-model-viewer"] tm-location-model-viewer')?.scene?.modelRoot?.children?.length > 0);
  const firstModel = await readDraft(adminContext, base, draftId);
  const firstModelId = firstModel.document.modelAssetId;
  assert.ok(firstModelId);
  assert.equal(firstModel.assetCapabilities.modelAssetId.displayName, 'QA textured alignment.glb');
  assert.equal(firstModel.assetCapabilities.modelAssetId.fromPublishedBase, false);
  assert.equal(Object.hasOwn(firstModel.document, 'assetProvenance'), false, 'model provenance stays outside authored documents');
  assert.equal(Object.hasOwn(firstModel.assetCapabilities.modelAssetId, 'ownerId'), false, 'safe model capabilities omit owner IDs');
  assert.match(await page.getByTestId('location-model-delivery-status').innerText(), /student delivery will be verified during publication/);
  const allowedVendorFiles = ['three.module.js', 'GLTFLoader.js', 'BufferGeometryUtils.js', 'OrbitControls.js'];
  for (const file of allowedVendorFiles) {
    assert.ok(network.some((item) => item.path === `/location-model/vendor/three/${file}` && item.status === 200),
      `the signed browser import graph resolves ${file} from the edge release`);
  }
  assert.ok(network.some((item) => item.path === `/api/locations/drafts/${draftId}/assets/${firstModelId}` && item.status === 200),
    'uploaded model bytes are read only from the exact owned-draft asset route');
  assert.equal(await page.getByText(firstModelId, { exact: true }).count(), 0, 'the opaque asset ID is not displayed in the editor');
  await page.screenshot({ path: join(artifacts, 'model-preview-loaded.png'), fullPage: true });

  const previewPath = `/api/locations/drafts/${draftId}/assets/${firstModelId}`;
  const readCountBeforeTransform = network.filter((item) => item.path === previewPath && item.method === 'GET').length;
  const transformInputs = [
    ['Scale X', '1.25'], ['Rotation X (°)', '15.5'], ['Rotation Y (°)', '90'], ['Rotation Z (°)', '-30'],
    ['Position X (m)', '0.25'], ['Position Y (m)', '1.5'], ['Position Z (m)', '-2.125'],
  ];
  for (const [label, value] of transformInputs) { const field = page.getByLabel(label); await field.fill(value); await field.press('Tab'); }
  const transformState = await page.locator('[data-testid="location-model-viewer"] tm-location-model-viewer').evaluate((viewer) => ({
    scale: viewer.scene.modelRoot.scale.toArray(), rotation: viewer.scene.modelRoot.rotation.toArray(), position: viewer.scene.modelRoot.position.toArray(),
    overlayPosition: viewer.scene.overlay.position.toArray(), overlayCount: viewer.scene.overlay.children.length,
  }));
  assert.deepEqual(transformState.scale, [1.25, 1, 1]);
  assert.deepEqual(transformState.rotation.slice(0, 3), [15.5 * Math.PI / 180, Math.PI / 2, -Math.PI / 6]);
  assert.deepEqual(transformState.position, [0.25, 1.5, -2.125]);
  assert.deepEqual(transformState.overlayPosition, [0, 0, 0], 'the GLB transform never moves the fixed authored overlay group');
  assert.ok(transformState.overlayCount > 0, 'table, seat and current-draft sensor overlays stay in the separate scene group');
  assert.equal(network.filter((item) => item.path === previewPath && item.method === 'GET').length, readCountBeforeTransform,
    'numeric transform edits do not refetch immutable model bytes');
  await page.getByTestId('location-model-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  let alignedDraft = await readDraft(adminContext, base, draftId);
  assert.deepEqual(alignedDraft.document.modelTransform, {
    scale: { x: 1.25, y: 1, z: 1 }, rotationDeg: { x: 15.5, y: 90, z: -30 }, positionM: { x: 0.25, y: 1.5, z: -2.125 },
  });
  let failViewerModule = true;
  await page.route((url) => new URL(url).pathname === '/location-model-viewer.js', async (route) => {
    if (failViewerModule) {
      failViewerModule = false;
      expectedBrowserEvents.push({ kind: 'viewer-module-503', status: 503, path: '/location-model-viewer.js' });
      expectHttpConsoleFailure(route.request(), 503);
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic viewer-module failure.' });
      return;
    }
    await route.continue();
  });
  expectRendererFailure = true;
  await page.evaluate(() => sessionStorage.setItem('wizard-model-renderer-failure', 'pending'));
  await page.reload();
  await page.getByRole('heading', { name: 'Room view', exact: true }).waitFor();
  await page.getByTestId('location-model-viewer-retry').waitFor();
  assert.equal(expectedBrowserEvents.filter((item) => item.kind === 'viewer-module-503').length, 1, 'the route injects exactly one viewer module failure');
  await page.getByTestId('location-model-viewer-retry').click();
  assert.equal(expectedBrowserEvents.filter((item) => item.kind === 'intercepted-http-error'
    && item.method === 'GET' && item.path === '/location-model-viewer.js' && item.status === 503).length, 1,
  'the deliberate module error is consumed once for its exact GET path and 503 response');
  await page.getByRole('alert').filter({ hasText: /The 3D preview could not be started in this browser\..*2D editor and object list.*retry the viewer/i }).waitFor();
  assert.equal(expectedBrowserEvents.filter((item) => item.kind === 'renderer-construction-failure').length, 1,
    'only the injected renderer-construction error is consumed; later WebGL errors remain unexpected');
  assert.equal(await page.evaluate(() => globalThis.__locationModelResourceEvidence.rendererContextFailureAttempts), 1,
    'the failure is injected into exactly one Three renderer context request');
  assert.equal(await page.evaluate(() => globalThis.__failLocationModelRenderer), false,
    'the injected failure is disarmed when the single renderer-construction stack ends, before user retry');
  await page.getByTestId('location-model-viewer-retry').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="location-model-viewer"] tm-location-model-viewer')?.scene);
  await page.getByText('GLB preview loaded.', { exact: true }).waitFor();
  expectRendererFailure = false;
  alignedDraft = await readDraft(adminContext, base, draftId);
  assert.deepEqual(alignedDraft.document.modelTransform.positionM, { x: 0.25, y: 1.5, z: -2.125 },
    'the exact model transform survives private save and page reload');
  assert.equal(alignedDraft.assetCapabilities.modelAssetId.displayName, 'QA textured alignment.glb');
  assert.equal(await page.getByTestId('location-model-filename').innerText(), 'QA textured alignment.glb · This draft · private');
  const resourcesAfterFirstLoad = await page.evaluate(() => globalThis.__locationModelResourceEvidence);
  assert.ok(resourcesAfterFirstLoad.createdUrls.length >= 1, 'the embedded texture path created a temporary image URL');
  const embeddedTextureUrls = resourcesAfterFirstLoad.createdUrls.filter((item) => /GLTFLoader\.js/.test(item.stack)).map((item) => item.url);
  assert.ok(embeddedTextureUrls.length >= 1, 'the embedded GLB texture creates an image/png object URL');
  assert.deepEqual(resourcesAfterFirstLoad.revokedUrls.filter((url) => embeddedTextureUrls.includes(url)), embeddedTextureUrls,
    'successful embedded texture loading revokes every GLTFLoader image URL');
  const editorPlanResources = resourcesAfterFirstLoad.createdUrls.filter((item) => !/GLTFLoader\.js/.test(item.stack)
    && /^image\/(?:png|jpeg)$/.test(item.type));
  assert.ok(editorPlanResources.length > 0, 'the separate editor plan preview creates its own image Blob URL');
  assert.ok(editorPlanResources.every((item) => !resourcesAfterFirstLoad.revokedUrls.includes(item.url)),
    'the editor retains its plan-preview URL while the draft editor remains mounted');
  assert.ok(resourcesAfterFirstLoad.imageBitmapsClosed <= resourcesAfterFirstLoad.imageBitmapsCreated,
    'live preview bitmap cleanup never exceeds the number of browser-created resources');
  if (resourcesAfterFirstLoad.imageBitmapsCreated > 0) {
    assert.ok(resourcesAfterFirstLoad.imageBitmapsClosed < resourcesAfterFirstLoad.imageBitmapsCreated,
      'the active GLB retains its ImageBitmap until replacement or viewer unmount');
  }
  const loadedTextureEvidence = await page.locator('[data-testid="location-model-viewer"] tm-location-model-viewer').evaluate((viewer) => {
    const textures = new Set(), objects = [];
    viewer.scene.modelRoot.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      objects.push({ type: object.type, materials: materials.map((material) => ({ type: material.type, keys: Object.keys(material) })) });
      for (const material of materials) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    });
    return { count: textures.size, objects };
  });
  assert.ok(loadedTextureEvidence.count > 0, `the embedded GLB texture is present in the live scene: ${JSON.stringify(loadedTextureEvidence)}`);
  await page.screenshot({ path: join(artifacts, 'model-transform-reloaded.png'), fullPage: true });

  // Local preflight rejects malformed candidates before save or upload and
  // leaves both the persisted reference and unsaved local alignment untouched.
  const savedBeforeInvalid = await readDraft(adminContext, base, draftId);
  await page.getByLabel('Position X (m)').fill('0.375');
  await page.getByLabel('Position X (m)').press('Tab');
  const expectNoDraftWrite = () => page.waitForRequest((request) => request.method() === 'PUT'
    && new URL(request.url()).pathname.startsWith(`/api/locations/drafts/${draftId}`), { timeout: 1200 })
    .then(() => true, () => false);
  const invalidFiles = [
    { path: externalGlb, label: 'external resource' },
    { path: truncatedGlb, label: 'truncated' },
    { path: malformedHeaderGlb, label: 'malformed container' },
    { path: malformedEmbeddedImageGlb, label: 'malformed embedded image', displayName: 'QA malformed embedded image.glb' },
  ];
  for (const invalid of invalidFiles) {
    if (invalid.displayName) expectEmbeddedTextureFailure = true;
    const requestSent = expectNoDraftWrite();
    await page.getByTestId('location-model-upload').setInputFiles(invalid.displayName ? {
      name: invalid.displayName, mimeType: 'model/gltf-binary', buffer: readFileSync(invalid.path),
    } : invalid.path);
    await page.getByText(/could not be decoded for preview/i).waitFor();
    assert.equal(await requestSent, false, `${invalid.label} rejection sends no draft save or model upload request`);
    assert.equal(await page.getByTestId('location-model-upload-retry').isEnabled(), true);
    assert.equal(await page.getByTestId('location-model-save-draft').isDisabled(), true);
    assert.equal(await page.getByTestId('location-model-continue').isDisabled(), true);
    assert.equal(await page.getByLabel('Position X (m)').inputValue(), '0.375', 'preflight preserves unsaved alignment edits');
    assert.equal(await page.getByTestId('location-model-filename').innerText(), 'QA textured alignment.glb · This draft · private');
    const pendingText = await page.getByTestId('location-model-pending-file').innerText();
    assert.match(pendingText, /selected for private draft upload/);
    if (invalid.displayName) assert.ok(pendingText.includes(invalid.displayName));
    const unchanged = await readDraft(adminContext, base, draftId);
    assert.equal(unchanged.document.modelAssetId, firstModelId);
    assert.equal(unchanged.draftRevision, savedBeforeInvalid.draftRevision, 'preflight does not advance the saved draft revision');
    assert.deepEqual(unchanged.document.modelTransform, savedBeforeInvalid.document.modelTransform);
    await page.getByTestId('location-model-upload-clear').click();
    assert.equal(await page.getByTestId('location-model-save-draft').isEnabled(), true);
    if (invalid.displayName) expectEmbeddedTextureFailure = false;
  }
  const resourcesAfterBadImage = await page.evaluate(() => globalThis.__locationModelResourceEvidence);
  assert.ok(resourcesAfterBadImage.imageBitmapDecodeFailures > 0,
    'the malformed embedded image is counted as a failed decode, not as a leaked ImageBitmap');
  const malformedTextureUrls = resourcesAfterBadImage.createdUrls.filter((item) => /GLTFLoader\.js/.test(item.stack)).map((item) => item.url);
  assert.deepEqual(resourcesAfterBadImage.revokedUrls.filter((url) => malformedTextureUrls.includes(url)), malformedTextureUrls,
    'local malformed embedded-image parsing releases every GLTFLoader image URL');
  assert.equal(expectedBrowserEvents.filter((item) => item.kind === 'embedded-texture-parse-failure').length, 1,
    'the injected embedded-texture parser error is consumed once');
  assert.equal(externalBrowserRequests.length, 0, 'GLTF preflight and preview issue no off-edge requests');

  const sharedReplacementResources = await page.evaluate(async () => {
    const THREE = await import('/location-model/vendor/three/three.module.js');
    const counters = { geometry: 0, material: 0, texture: 0, image: 0 };
    const geometry = new THREE.BufferGeometry();
    const image = { close() { counters.image += 1; } };
    const texture = new THREE.Texture(image);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const trackDispose = (resource, key) => {
      const dispose = resource.dispose.bind(resource);
      resource.dispose = () => { counters[key] += 1; dispose(); };
    };
    trackDispose(geometry, 'geometry');
    trackDispose(material, 'material');
    trackDispose(texture, 'texture');
    const root = document.querySelector('[data-testid="location-model-viewer"] tm-location-model-viewer').scene.modelRoot;
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    Object.defineProperty(globalThis, '__sharedReplacementResources', { value: counters, configurable: true });
    return counters;
  });
  assert.deepEqual(sharedReplacementResources, { geometry: 0, material: 0, texture: 0, image: 0 },
    'resources shared by sibling meshes remain live until the current model is replaced');

  const replacementResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `/api/locations/drafts/${draftId}/assets/model`, { timeout: 10000 })
    .then((response) => ({ response }), (error) => ({ error }));
  await page.getByTestId('location-model-upload').setInputFiles({
    name: 'QA replacement textured.glb', mimeType: 'model/gltf-binary', buffer: readFileSync(dataUriTexturedGlb),
  });
  const replacementEvent = await replacementResponse;
  assert.ok('response' in replacementEvent,
    `replacement reaches the upload route; status=${await page.getByTestId('location-model-upload').isDisabled()}, pending=${await page.getByTestId('location-model-pending-file').allInnerTexts()}, message=${await page.locator('.loc-model-upload-status').allInnerTexts()}, wait=${'error' in replacementEvent ? replacementEvent.error : ''}`);
  assert.equal(replacementEvent.response.status(), 200);
  await page.getByText('GLB preview loaded.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__sharedReplacementResources),
    { geometry: 1, material: 1, texture: 1, image: 1 },
    'replacement disposes each geometry, material, texture, and shared image exactly once across sibling meshes');
  const replacedResources = await page.evaluate(() => globalThis.__locationModelResourceEvidence);
  assert.ok(replacedResources.imageBitmapsClosed > 0, 'replacing the successful textured model closes its released ImageBitmap');
  assert.equal(await page.getByTestId('location-model-filename').innerText(), 'QA replacement textured.glb · This draft · private');
  // A deliberate custom-to-generated source change clears the model only after
  // native confirmation, saves as a private draft, and leaves no model key.
  const customBeforeSourceSwitch = await readDraft(adminContext, base, draftId);
  const assetPathBeforeSourceSwitch = `/api/locations/drafts/${draftId}/assets/${customBeforeSourceSwitch.document.modelAssetId}`;
  const assetReadsBeforeSourceSwitch = network.filter((item) => item.method === 'GET' && item.path === assetPathBeforeSourceSwitch).length;
  let canceledSourcePrompt = '';
  page.once('dialog', (dialog) => { canceledSourcePrompt = dialog.message(); void dialog.dismiss(); });
  await page.getByTestId('location-room-source-generated').click();
  assert.match(canceledSourcePrompt, /published revision stays active/i, 'source confirmation describes the published-state boundary');
  assert.equal(await page.getByTestId('location-room-source-custom').isChecked(), true, 'canceling confirmation keeps the current custom source');
  const afterCanceledSourceSwitch = await readDraft(adminContext, base, draftId);
  assert.equal(afterCanceledSourceSwitch.document.modelAssetId, customBeforeSourceSwitch.document.modelAssetId);
  assert.equal(afterCanceledSourceSwitch.draftRevision, customBeforeSourceSwitch.draftRevision);

  let acceptedSourcePrompt = '';
  page.once('dialog', (dialog) => { acceptedSourcePrompt = dialog.message(); void dialog.accept(); });
  await page.getByTestId('location-room-source-generated').click();
  assert.match(acceptedSourcePrompt, /immutable asset and history are retained/i);
  assert.equal(await page.getByTestId('location-room-source-generated').isChecked(), true);
  await page.getByTestId('location-room-preview-status').filter({ hasText: 'Built-in room preview ready.' }).waitFor();
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="location-room-preview-canvas"] tm-location-model-viewer');
    return viewer?.scene?.source === 'generated' && viewer.scene.modelRoot.children.length === 0 && viewer.scene.walls.size === 4;
  });
  assert.equal(network.filter((item) => item.method === 'GET' && item.path === assetPathBeforeSourceSwitch).length, assetReadsBeforeSourceSwitch,
    'switching to the built-in source performs no GLB read');
  const savedCustomBeforeSwitch = await readDraft(adminContext, base, draftId);
  assert.equal(savedCustomBeforeSwitch.document.modelAssetId, customBeforeSourceSwitch.document.modelAssetId,
    'the source choice stays local until save');
  assert.deepEqual(savedCustomBeforeSwitch.document.modelTransform, customBeforeSourceSwitch.document.modelTransform,
    'the persisted transform stays intact until save');
  await page.getByTestId('location-model-save-draft').click();
  await page.getByText('Draft saved · private', { exact: true }).waitFor();
  const savedGeneratedSource = await readDraft(adminContext, base, draftId);
  assert.equal(savedGeneratedSource.document.proceduralRoom, 'simple-rectangle-v1');
  assert.equal(Object.hasOwn(savedGeneratedSource.document, 'modelAssetId'), false);
  assert.equal(Object.hasOwn(savedGeneratedSource.document, 'modelTransform'), false);
  assert.equal(savedGeneratedSource.visibility, customBeforeSourceSwitch.visibility, 'the source change preserves the draft visibility');
  assert.equal(savedGeneratedSource.basePublishedRevision, customBeforeSourceSwitch.basePublishedRevision,
    'saving a source change does not publish or advance the published base');
  const restoredModelUpload = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `/api/locations/drafts/${draftId}/assets/model`, { timeout: 10000 });
  await page.getByTestId('location-model-upload').setInputFiles({
    name: 'QA replacement textured.glb', mimeType: 'model/gltf-binary', buffer: readFileSync(dataUriTexturedGlb),
  });
  assert.equal((await restoredModelUpload).status(), 200, 'a successful upload switches the generated draft back to custom');
  await page.getByText('GLB preview loaded.', { exact: true }).waitFor();
  const restoredCustomSource = await readDraft(adminContext, base, draftId);
  assert.ok(restoredCustomSource.document.modelAssetId);
  assert.equal(Object.hasOwn(restoredCustomSource.document, 'proceduralRoom'), false,
    'a successful GLB upload clears the procedural marker before strict save');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByTestId('location-model-zoom-in').isVisible());
  assert.ok(await page.getByTestId('location-model-reset-view').isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the model step remains within a mobile viewport');
  const modelViewer = page.locator('[data-testid="location-model-viewer"] tm-location-model-viewer');
  const cameraDistanceBeforeZoom = await modelViewer.evaluate((viewer) => viewer.scene.camera.position.distanceTo(viewer.scene.controls.target));
  await page.getByTestId('location-model-zoom-in').click();
  const cameraDistanceAfterZoomIn = await modelViewer.evaluate((viewer) => viewer.scene.camera.position.distanceTo(viewer.scene.controls.target));
  assert.ok(cameraDistanceAfterZoomIn < cameraDistanceBeforeZoom, 'Zoom in moves the camera closer to the fixed target');
  await page.getByTestId('location-model-zoom-out').click();
  const cameraDistanceAfterZoomOut = await modelViewer.evaluate((viewer) => viewer.scene.camera.position.distanceTo(viewer.scene.controls.target));
  assert.ok(cameraDistanceAfterZoomOut > cameraDistanceAfterZoomIn, 'Zoom out moves the camera farther from the fixed target');
  await page.getByTestId('location-model-reset-view').click();
  await page.screenshot({ path: join(artifacts, 'model-preview-mobile.png'), fullPage: true });
  const retainedViewerState = await modelViewer.evaluate((viewer) => ({
    sameViewer: (globalThis.__retainedRoomViewer = viewer) === viewer,
    sameScene: (globalThis.__retainedRoomScene = viewer.scene) === viewer.scene,
    camera: viewer.scene.camera.position.toArray(),
    target: viewer.scene.controls.target.toArray(),
  }));
  await page.getByTestId('location-step-details').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
  await page.getByAltText('Private floor plan background preview').waitFor();
  const retainedPlanPreviewUrl = await page.getByAltText('Private floor plan background preview').getAttribute('src');
  assert.ok(retainedPlanPreviewUrl?.startsWith('blob:'), 'the editor keeps its plan preview through model-step navigation');
  assert.ok(editorPlanResources.some((item) => item.url === retainedPlanPreviewUrl),
    'the active plan image is the separately tracked non-GLTF Blob URL');
  assert.equal(await page.locator('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').count(), 1,
    'the generated/custom viewer host stays mounted as navigation changes editing steps');
  const viewerAfterStepChange = await page.locator('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').evaluate((viewer) => ({
    sameViewer: viewer === globalThis.__retainedRoomViewer,
    sameScene: viewer.scene === globalThis.__retainedRoomScene,
    camera: viewer.scene.camera.position.toArray(),
    target: viewer.scene.controls.target.toArray(),
  }));
  assert.equal(await page.getByTestId('location-room-live-preview-toggle').getAttribute('aria-expanded'), 'true',
    'the mobile preview pane starts expanded');
  await page.getByTestId('location-room-live-preview-toggle').click();
  assert.equal(await page.getByTestId('location-room-live-preview-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').count(), 1,
    'collapsing the mobile preview hides its pane without unmounting the viewer');
  await page.getByTestId('location-room-live-preview-toggle').click();
  const viewerAfterPaneToggle = await page.locator('[data-testid="location-room-preview-canvas"] tm-location-model-viewer').evaluate((viewer) => ({
    sameViewer: viewer === globalThis.__retainedRoomViewer,
    sameScene: viewer.scene === globalThis.__retainedRoomScene,
    camera: viewer.scene.camera.position.toArray(),
    target: viewer.scene.controls.target.toArray(),
  }));
  assert.equal(viewerAfterStepChange.sameViewer, true, 'step navigation retains the same mounted viewer element');
  assert.equal(viewerAfterStepChange.sameScene, true, 'step navigation retains the same Three.js scene instance');
  assert.equal(viewerAfterPaneToggle.sameViewer, true, 'mobile hide/show retains the same mounted viewer element');
  assert.equal(viewerAfterPaneToggle.sameScene, true, 'mobile hide/show retains the same Three.js scene instance');
  for (const axis of ['camera', 'target']) for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(viewerAfterPaneToggle[axis][index] - retainedViewerState[axis][index]) < 0.03,
      `step and pane changes retain ${axis} component ${index}`);
  }
  const releasedResources = await page.evaluate(() => globalThis.__locationModelResourceEvidence);
  assert.ok(releasedResources.imageBitmapsClosed < releasedResources.imageBitmapsCreated,
    'the active custom GLB retains its ImageBitmap while the persistent editor preview remains mounted');
  const allEmbeddedTextureUrls = releasedResources.createdUrls.filter((item) => /GLTFLoader\.js/.test(item.stack)).map((item) => item.url);
  assert.deepEqual(releasedResources.revokedUrls.filter((url) => allEmbeddedTextureUrls.includes(url)), allEmbeddedTextureUrls,
    'all successful and failed embedded-image parse paths revoke their object URLs');
  await page.getByTestId('location-step-model').click();
  await page.getByTestId('location-model-filename').waitFor();
  await page.getByTestId('location-model-continue').click();
  await page.getByRole('heading', { name: 'Review location', exact: true }).waitFor();
  assert.equal(await page.getByTestId('location-review-model-filename').innerText(), 'QA replacement textured.glb');
  assert.match(await page.locator('.loc-model-review').innerText(), /student delivery will be verified during publication/);
  checks.push('signed model upload progress and private capability; edge-hosted four-module import graph; authenticated in-memory textured preview; exact transform/save/reload without refetch; malformed upload and embedded-image retry; object URL/ImageBitmap disposal; mobile camera controls; public delivery remains pending until explicit publication passed');

  // Review is read-only and separate; no publication occurs from a save or upload.
  await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
  await page.getByRole('heading', { name: 'Review location' }).waitFor();
  await page.getByRole('heading', { name: 'Sensor coverage summary' }).waitFor();
  const reviewWestId = `location-review-coverage-${westTable.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const reviewWest = page.getByTestId(reviewWestId);
  await page.waitForFunction((testId) => {
    const row = document.querySelector(`[data-testid="${testId}"]`);
    return row?.textContent?.includes('seats covered by the proposed set')
      && row.textContent.includes('seats covered by this owner');
  }, reviewWestId);
  assert.match(await reviewWest.innerText(), /QA Ceiling Sensor B/, 'Review shows the selected primary owner');
  assert.match(await reviewWest.innerText(), /\d+ \/ 4 seats covered by the proposed set/, 'Review separates union counts');
  assert.match(await reviewWest.innerText(), /\d+ \/ 4 seats covered by this owner/, 'Review reports selected-owner counts separately');
  // Install both endpoints before Sensors mounts; its first eligible-sensor read
  // starts in the mount effect and could otherwise race the test stub.
  let emptyEligibleReads = 0;
  await page.route(`**/api/locations/drafts/${draftId}/sensors`, async (route) => {
    if (route.request().method() === 'GET') {
      emptyEligibleReads += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { locationId: detail.locationId, sensors: [] } }) });
      return;
    }
    await route.continue();
  });
  let emptyReviewCoverageRequestSeen = false;
  await page.route(`**/api/locations/drafts/${draftId}/coverage-suggestions`, async (route) => {
    const request = route.request().postDataJSON();
    assert.deepEqual(request.proposedSensors, [], 'an empty eligible list produces an empty coverage proposal');
    if (emptyEligibleReads >= 2) emptyReviewCoverageRequestSeen = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {
      locationId: detail.locationId,
      suggestions: detail.document.tables.map((table) => ({
        tableId: table.id, coveredBy: [], suggestedOwner: null,
        seatCoverage: { totalSeats: table.seats.length, coveredSeats: 0, bySensor: [] },
      })),
    } }) });
  });
  await page.getByTestId('location-review-edit-coverage').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/sensors$`));
  await page.getByRole('heading', { name: 'Sensors', exact: true }).waitFor();
  await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
  await page.getByRole('heading', { name: 'Review location' }).waitFor();
  await page.getByTestId('location-review-no-eligible-sensors').waitFor();
  assert.ok(emptyEligibleReads >= 2, 'Sensors and Review both read the stubbed empty eligible list');
  assert.equal(emptyReviewCoverageRequestSeen, true, 'Review loaded a matching empty coverage result after its eligible-sensor read');
  assert.match(await page.getByTestId('location-review-no-eligible-sensors').innerText(), /No eligible sensors are available/,
    'Review explains an empty eligible-sensor result instead of implying counts are available');
  await page.unroute(`**/api/locations/drafts/${draftId}/coverage-suggestions`);
  await page.unroute(`**/api/locations/drafts/${draftId}/sensors`);
  await page.getByTestId('location-review-edit-coverage').click();
  await page.waitForURL(new RegExp(`/locations/${draftId}/sensors$`));
  await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
  await page.getByRole('heading', { name: 'Review location' }).waitFor();
  await page.getByTestId(reviewWestId).waitFor();
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
  await page.getByTestId('location-canvas-zoom-in').click();
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
  await page.getByTestId('location-canvas-reset').click();
  await page.screenshot({ path: join(artifacts, 'location-editor-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% browser-like zoom reflows without horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(artifacts, 'location-editor-desktop-final.png'), fullPage: true });
  checks.push('rect/circle/polygon, seat, zones, plan privacy, failed/delayed upload, stale conflict, private Review union/owner summary, empty-eligible Review with empty proposal/table rows, and responsive/zoom checks passed');

  // Explicit publication is separate from saving/review and returns to the list.
  await page.getByRole('button', { name: 'Back to locations', exact: true }).click();
  await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  const resourcesAfterEditorUnmount = await page.evaluate(() => globalThis.__locationModelResourceEvidence);
  assert.ok(resourcesAfterEditorUnmount.revokedUrls.includes(retainedPlanPreviewUrl),
    'the retained floor-plan Blob URL is revoked when the actual editor component unmounts');
  const finalGlbImageUrls = resourcesAfterEditorUnmount.createdUrls.filter((item) => /GLTFLoader\.js/.test(item.stack)).map((item) => item.url);
  assert.deepEqual(resourcesAfterEditorUnmount.revokedUrls.filter((url) => finalGlbImageUrls.includes(url)), finalGlbImageUrls,
    'all GLTF-owned temporary URLs remain revoked after the editor unmounts');
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
      expectHttpConsoleFailure(route.request(), 503);
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
  const legacySensorsResponse = await operatorContext.request.get(`${base}/api/locations/drafts/${encodeURIComponent(legacyDraftId)}/sensors`);
  assert.equal(legacySensorsResponse.status(), 200);
  const legacySensors = await jsonFrom(legacySensorsResponse);
  assert.ok(legacySensors.sensors.some((sensor) => sensor.uid === RGB_SENSOR && sensor.rgb), 'RGB is eligible for the inherited console-only location');
  await operatorPage.getByTestId('location-step-sensors').click();
  await operatorPage.waitForURL(new RegExp(`/locations/${legacyDraftId}/sensors$`));
  await operatorPage.getByTestId('location-sensor-aa-bb-cc-dd-ee-23').waitFor();
  const untouchedSensorX = operatorPage.getByLabel('Position X (m)');
  assert.equal(await untouchedSensorX.inputValue(), '1.255', 'fractional centimetres display without rounding');
  await untouchedSensorX.focus(); await untouchedSensorX.press('Tab');
  assert.match(await operatorPage.locator('.loc-footer').innerText(), /Draft revision \d+ · private · live assignments unchanged/,
    'focusing and blurring a fractional pose does not dirty the inherited draft');
  const legacyPoseAfterNoopBlur = await readDraft(operatorContext, base, legacyDraftId);
  assert.equal(legacyPoseAfterNoopBlur.document.sensorAssignments.find((assignment) => assignment.uid === RGB_SENSOR)?.pose.x, 125.5,
    'a no-op metre blur preserves the exact 125.5 cm stored coordinate');
  await operatorPage.waitForFunction(() => document.querySelector('[data-testid="location-table-coverage-qa-legacy-table"]')?.textContent?.includes('1 / 1 seats covered'));
  assert.match(await operatorPage.getByTestId('location-table-coverage-qa-legacy-table').innerText(), /All seats covered/,
    'the original legacy perimeter seat is visibly included in exact 1/1 coverage');
  await operatorPage.getByTestId('location-step-details').click();
  await operatorPage.waitForURL(new RegExp(`/locations/${legacyDraftId}/details$`));
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
  checks.push('real operator legacy edit, exact 257-point/off-floor preservation, strict changed-seat rejection, exact 1/1 legacy coverage, and plan round-trip passed');
  checks.push('admin-uploaded published plan remains privately previewable by a second manager only through the exact owned base draft after save/reload');

  // Keep a minimal, sanitized result summary; never include cookies, request bodies, or auth data.
  assert.deepEqual(expectedHttpConsoleFailures, [], 'every expected HTTP console error is matched to its intercepted method, path, and status exactly once');
  assert.deepEqual(browserErrors, [], `unexpected browser errors: ${JSON.stringify(browserErrors)}`);
  writeFileSync(join(artifacts, 'browser-results.json'), JSON.stringify({
    runner: 'Local Playwright 1.63 / installed Chrome; real /auth/login sessions; temporary file persistence; loopback only',
    checks, network, expectedBrowserEvents, browserErrors,
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
  writeFileSync(join(artifacts, 'failure-trace.json'), JSON.stringify({ unexpectedFailure: safeMessage, network, expectedBrowserEvents, expectedHttpConsoleFailures, browserErrors }, null, 2));
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
