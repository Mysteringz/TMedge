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

test('wizard progress, compact mobile controls, defaults and step focus remain usable', { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'location-ui-refinements-'));
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: 'manager', password } })).status(), 200);
    const request = async (method, path, body, expected = 200) => {
      const response = await context.request.fetch(`${base}/api${path}`, { method, headers: { origin: base, 'x-tm-algo': '1' }, ...(body ? { data: body } : {}) });
      assert.equal(response.status(), expected, await response.text());
      return (await response.json()).data;
    };


    const created = await request('POST', '/locations/drafts', { name: 'Mobile room', building: 'Test', widthCm: 1000, heightCm: 800 }, 201);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const artifacts = process.env.LOCATION_UI_ARTIFACT_DIR;
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const read = () => request('GET', `/locations/drafts/${created.draftId}`);
    const save = async () => {
      const written = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/${created.draftId}`));
      await page.getByTestId('location-save-draft').click();
      assert.equal((await written).status(), 200);
      await page.getByText(/Draft saved/).waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-testid="location-save-draft"]')?.disabled);
      return read();
    };
    const assertFocusedStep = async text => {
      await page.waitForFunction(text => document.activeElement?.textContent === text && document.activeElement?.tagName === 'H2', text);
    };
    const assertActionsVisible = async () => {
      const metrics = await page.getByTestId('location-save-draft').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: innerHeight, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element };
      });
      assert.ok(metrics.top >= 0 && metrics.bottom <= metrics.height && metrics.hit, JSON.stringify(metrics));
    };
    await page.goto(base + '/locations');
    await page.getByTestId(`location-continue-${created.draftId}`).click();
    await assertFocusedStep('Details & layout');
    await page.getByTestId('location-tool-add-rectangle').tap();
    const saved = await save();
    assert.equal(saved.document.tables[0].shape.width, 120);
    assert.equal(saved.document.tables[0].shape.height, 80);
    assert.equal(saved.document.tables[0].seats.length, 4);
    const position = page.getByTestId('location-table-position');
    assert.equal(await position.evaluate(element => element.open), false, 'mobile geometry starts collapsed');
    assert.equal(await page.getByTestId('location-table-furniture-options').evaluate(element => element.open), false);
    assert.equal(await page.getByTestId('location-room-objects').evaluate(element => element.open), false);
    await page.evaluate(() => scrollTo(0, 0));
    await assertActionsVisible();
    const layout = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
    assert.equal(layout.width, layout.viewportWidth, 'there is no horizontal page overflow');
    assert.ok(layout.height < 2200, `one-table mobile page is compact: ${JSON.stringify(layout)}`);
    if (artifacts) {
      writeFileSync(join(artifacts, 'mobile-metrics.json'), JSON.stringify(layout, null, 2));
      await page.screenshot({ path: join(artifacts, 'mobile-collapsed.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 360, height: 780 });
    await assertActionsVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow phones also avoid horizontal overflow');
    await page.setViewportSize({ width: 390, height: 844 });
    await position.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await position.evaluate(element => element.open), true, 'geometry disclosure works with the keyboard');
    const width = page.getByLabel('Table width (m)', { exact: true });
    await width.fill(''); await width.press('Tab');
    await position.locator('summary').click();
    await page.getByTestId('location-continue-sensors').tap();
    assert.match(page.url(), /\/details$/);
    assert.equal(await position.evaluate(element => element.open), true, 'validation reveals the collapsed invalid field');
    assert.equal(await width.inputValue(), '', 'collapsing a section retains its raw input');
    assert.equal(await width.evaluate(element => document.activeElement === element), true);
    await width.fill('1.2'); await width.press('Tab');
    await page.getByRole('button', { name: 'Back to canvas', exact: true }).tap();
    await page.waitForFunction(() => document.activeElement?.classList.contains('loc-canvas'));
    await page.getByTestId('location-continue-sensors').tap();
    await page.waitForURL(/\/sensors$/); await assertFocusedStep('Sensors');
    assert.match(await page.getByTestId('location-step-details').innerText(), /Visited/);
    await page.getByTestId('location-sensors-continue').tap();
    await page.waitForURL(/\/model$/); await assertFocusedStep('Room view');
    assert.match(await page.getByTestId('location-step-sensors').innerText(), /Visited/);
    await page.getByTestId('location-step-review').tap();
    await page.waitForURL(/\/review$/); await assertFocusedStep('Review location');
    assert.match(await page.getByTestId('location-step-model').innerText(), /Visited/);
    await page.reload();
    await assertFocusedStep('Review location');
    assert.match(await page.getByTestId('location-step-sensors').innerText(), /Visited/, 'visit history survives reload');
    await page.getByTestId('location-editor-back').tap();
    await page.waitForURL(base + '/locations');
    await page.getByTestId(`location-continue-${created.draftId}`).tap();
    await assertFocusedStep('Details & layout');
    assert.match(await page.getByTestId('location-step-model').innerText(), /Visited/, 'visit history survives reopening the draft');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('location-inspector-table-select').selectOption(saved.document.tables[0].id);
    await page.getByLabel('Table width (m)', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await position.evaluate(element => element.open), true, 'desktop exposes position and size by default');
    if (artifacts) await page.screenshot({ path: join(artifacts, 'desktop-inspector.png'), fullPage: true });

    // Uploaded-model summaries must send the user to the existing alignment controls.
    const draft = await read();
    const bytes = makeTriangleGlb();
    const upload = await context.request.put(`${base}/api/locations/drafts/${created.draftId}/assets/model`, {
      headers: { origin: base, 'x-tm-algo': '1', 'if-match': String(draft.draftRevision), 'content-type': 'model/gltf-binary' }, data: bytes,
    });
    assert.equal(upload.status(), 200, await upload.text());
    await page.reload();
    await page.getByTestId('location-step-review').click();
    await page.waitForURL(/\/review$/); await assertFocusedStep('Review location');
    assert.match(await page.locator('.loc-model-readonly-transform').innerText(), /Adjust alignment in the Room view step/);
    assert.doesNotMatch(await page.locator('.loc-model-readonly-transform').innerText(), /upload a GLB to change alignment/);
    await page.getByTestId('location-review-adjust-model').click();
    await page.waitForURL(/\/model$/); await assertFocusedStep('Room view');
    assert.equal(await page.getByTestId('location-model-transform-scale-x').isEnabled(), true);
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

// Build a self-contained room-model fixture so this regression runs in any checkout.
function makeTriangleGlb() {
  const binary = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'TMedge Task 4.1 browser fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.byteLength, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] }],
  }));
  const jsonLength = align4(json.byteLength), binaryLength = align4(binary.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binaryLength;
  const glb = Buffer.alloc(total, 0x20);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  const binaryHeader = 20 + jsonLength;
  glb.writeUInt32LE(binaryLength, binaryHeader); glb.writeUInt32LE(0x004e4942, binaryHeader + 4); binary.copy(glb, binaryHeader + 8);
  return glb;
}

function align4(length) { return Math.ceil(length / 4) * 4; }
