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

test('Details and Sensors fit wide and tall rooms inside the shared viewport', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-viewport-browser-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const sitePath = join(dir, 'site.json'), nodesPath = join(dir, 'nodes.json');
  writeFileSync(sitePath, JSON.stringify(siteJson()));
  writeFileSync(nodesPath, JSON.stringify({ nodes: [{ uid: 'aa:bb:cc:dd:ee:21', label: 'Bottom-right sensor', simulated: false, rgb: false, detector: 'node' }] }));
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
    const page = await context.newPage();
    const rulerAlignment = async () => {
      return await page.locator('.loc-viewport-canvas.is-active .loc-canvas').evaluate(svg => {
        const matrix = svg.getScreenCTM();
        const surface = svg.closest('.loc-canvas-surface');
        const xRuler = surface.querySelector('.loc-ruler-x').getBoundingClientRect();
        const yRuler = surface.querySelector('.loc-ruler-y').getBoundingClientRect();
        const xTick = surface.querySelector('.loc-ruler-x-tick');
        const yTick = surface.querySelector('.loc-ruler-y-tick');
        const gridBox = svg.querySelector('.loc-metric-grid').getBBox();
        const gridTopLeft = new DOMPoint(gridBox.x, gridBox.y).matrixTransform(matrix);
        const gridBottomRight = new DOMPoint(gridBox.x + gridBox.width, gridBox.y + gridBox.height).matrixTransform(matrix);
        const svgBounds = svg.getBoundingClientRect();
        const xValue = Number(xTick.querySelector('b').textContent) * 100;
        const yValue = Number(svg.querySelector('.loc-floor').getAttribute('height')) - Number(yTick.querySelector('b').textContent) * 100;
        return { xError: Math.abs(xRuler.left + parseFloat(xTick.style.left) - new DOMPoint(xValue, 0).matrixTransform(matrix).x),
          yError: Math.abs(yRuler.top + parseFloat(yTick.style.top) - new DOMPoint(0, yValue).matrixTransform(matrix).y),
          gridCoversPreview: Math.abs(gridTopLeft.x - svgBounds.left - 1) < 2 && Math.abs(gridTopLeft.y - svgBounds.top - 1) < 2
            && Math.abs(gridBottomRight.x - svgBounds.right + 1) < 2 && Math.abs(gridBottomRight.y - svgBounds.bottom + 1) < 2,
          gridPointerEvents: getComputedStyle(svg.querySelector('.loc-metric-grid')).pointerEvents };
      });
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [widthCm, heightCm] of [[1200, 1000], [2000, 600], [600, 2000]]) {
      const draft = await request('POST', '/locations/drafts', { name: 'Room fit test', building: 'Test', widthCm, heightCm }, 201);
      await request('PUT', `/locations/drafts/${draft.draftId}`, { expectedDraftRevision: 1, document: { ...draft.document,
        sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:21', pose: { x: widthCm * 0.9, y: heightCm * 0.9, heightCm: 350, yawDeg: 0, mirror: false }, owns: [] }],
      } });
      for (const step of ['sensors', 'details']) {
        await page.goto(`${base}/locations/${draft.draftId}/${step}`);
        await page.getByTestId('location-canvas-mode-2d').check();
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 900, height: 900 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await page.getByTestId('location-canvas-reset').click();
          // Test rendered coordinates against the clipping container, rather than
          // trusting viewBox alone: an oversized SVG can still clip the room.
          const fit = await page.locator('.loc-viewport-canvas.is-active .loc-canvas').evaluate((svg) => {
            const viewport = svg.closest('.loc-shared-viewport').getBoundingClientRect();
            const bounds = svg.getBoundingClientRect();
            const floor = svg.querySelector('.loc-floor');
            const matrix = svg.getScreenCTM();
            const bottomRight = new DOMPoint(Number(floor.getAttribute('width')), Number(floor.getAttribute('height'))).matrixTransform(matrix);
            const topLeft = new DOMPoint(0, 0).matrixTransform(matrix);
            const caption = svg.closest('.loc-canvas-frame').querySelector('.loc-canvas-caption').getBoundingClientRect();
            return { viewport: { top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right },
              svg: { top: bounds.top, bottom: bounds.bottom, height: bounds.height }, captionBottom: caption.bottom,
              topLeft: { x: topLeft.x, y: topLeft.y }, bottomRight: { x: bottomRight.x, y: bottomRight.y } };
          });
          assert.equal(await page.getByTestId('location-ruler-x').isVisible(), true, 'X metre ruler is visible in both steps');
          assert.equal(await page.getByTestId('location-ruler-y').isVisible(), true, 'Y metre ruler is visible in both steps');
          const xBounds = await page.getByTestId('location-ruler-x').boundingBox();
          assert.ok(xBounds.y >= fit.svg.bottom - 1, 'X ticks sit along the bottom edge');
          assert.ok(xBounds.height <= 24, 'X axis uses a compact tick track rather than a ruler panel');
          assert.ok(fit.topLeft.x > fit.viewport.left + 8 && fit.topLeft.y > fit.svg.top + 8
            && fit.bottomRight.x < fit.viewport.right - 8 && fit.bottomRight.y < fit.svg.bottom - 8, 'fit view leaves a margin around the room');
          assert.match(await page.getByTestId('location-grid-scale').innerText(), /Grid · [\d.]+ m/);
          const alignment = await rulerAlignment();
          assert.ok(alignment.xError < 2 && alignment.yError < 2, `rulers align with floor coordinates: ${JSON.stringify(alignment)}`);
          assert.equal(alignment.gridCoversPreview, true, 'grid spans the complete preview including room margins');
          assert.equal(alignment.gridPointerEvents, 'none', 'grid never intercepts room editing');
          const label = `${step}, ${widthCm}×${heightCm} room, ${viewport.width}×${viewport.height} screen: ${JSON.stringify(fit)}`;
          assert.ok(fit.svg.height > 100 && fit.svg.bottom <= fit.viewport.bottom + 1 && fit.svg.top >= fit.viewport.top - 1, `canvas fits vertically: ${label}`);
          assert.ok(fit.captionBottom <= fit.viewport.bottom + 1, `caption fits below canvas: ${label}`);
          assert.ok(fit.topLeft.x >= fit.viewport.left - 1 && fit.topLeft.y >= fit.viewport.top - 1
            && fit.bottomRight.x <= fit.viewport.right + 1 && fit.bottomRight.y <= fit.viewport.bottom + 1, `entire room is visible: ${label}`);
          if (step === 'sensors') {
            const marker = page.getByTestId('location-canvas-sensor-aa-bb-cc-dd-ee-21');
            await marker.click();
            const xInput = page.getByLabel('Position X (m)');
            const originalX = Number(await xInput.inputValue());
            await page.locator('.loc-viewport-canvas.is-active .loc-canvas').press('ArrowRight');
            await page.waitForFunction(expected => Math.abs(Number(document.querySelector('[data-testid=location-sensor-position-x]').value) - expected) < 0.00001, originalX + 0.01);
            assert.ok(Math.abs(Number(await xInput.inputValue()) - originalX - 0.01) < 0.00001, 'bottom-right sensor remains clickable and keyboard-movable');
            await page.locator('.loc-viewport-canvas.is-active .loc-canvas').press('ArrowLeft');
            await page.waitForFunction(expected => Math.abs(Number(document.querySelector('[data-testid=location-sensor-position-x]').value) - expected) < 0.00001, originalX);
          }
          if (process.env.LOCATION_VIEWPORT_SCREENSHOTS && widthCm === 1200) {
            mkdirSync(process.env.LOCATION_VIEWPORT_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: join(process.env.LOCATION_VIEWPORT_SCREENSHOTS, `${step}-${viewport.width}.png`) });
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByTestId('location-canvas-reset').click();
        await page.getByTestId('location-canvas-zoom-in').click();
        await page.getByTestId('location-canvas-zoom-in').click();
        const svg = page.locator('.loc-viewport-canvas.is-active .loc-canvas');
        const beforePan = await svg.getAttribute('viewBox');
        const bounds = await svg.boundingBox();
        await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.3);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.5 + 30, bounds.y + bounds.height * 0.3 + 20, { steps: 4 });
        await page.mouse.up();
        assert.notEqual(await svg.getAttribute('viewBox'), beforePan, 'zoomed room can still be panned over the grid');
        const zoomedAlignment = await rulerAlignment();
        assert.equal(zoomedAlignment.gridCoversPreview, true, 'grid fills the preview after zoom and pan');
        assert.ok(zoomedAlignment.xError < 2 && zoomedAlignment.yError < 2, `rulers retain world coordinates after zoom and pan: ${JSON.stringify(zoomedAlignment)}`);
        await page.getByTestId('location-canvas-reset').click();
      }
    }
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
