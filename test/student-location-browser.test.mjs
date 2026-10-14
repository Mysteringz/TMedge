import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createWebApp } from '../dist/src/web/main.js';

const PUSH_TOKEN = 'student-location-browser-edge-token';
const ASSET_ID = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a01';
const MODEL_TRANSFORM = {
  scale: { x: 1.25, y: 0.9, z: 1.1 },
  rotationDeg: { x: 10, y: 22, z: -5 },
  positionM: { x: 1.25, y: 0.5, z: -0.75 },
};
const ARTIFACT_DIR = process.env.TASK_2_3_ARTIFACTS;

test('signed student browser renders composite locations, aligned models, live status and recovery', { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'tmedge-student-locations-'));
  const web = await startWeb(join(temporary, 'main'));
  const emptyWeb = await startWeb(join(temporary, 'empty'));
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  const network = [];
  let moduleRetryEvidence = null;
  let traceStarted = false;
  let tracePath = null;
  try {
    await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
    const cookie = await signup(web.base, 'student-ui@connect.hku.hk');
    await context.addCookies([{ name: 'tm_session', value: cookie, url: web.base }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === web.base) network.push({ kind: 'request', method: request.method(), path: url.pathname });
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === web.base) network.push({ kind: 'response', status: response.status(), path: url.pathname });
    });
    if (ARTIFACT_DIR) {
      mkdirSync(ARTIFACT_DIR, { recursive: true });
      tracePath = join(ARTIFACT_DIR, 'student-location-browser.trace.zip');
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
    }

    const bytes = makeTriangleGlb();
    await uploadModel(web.base, bytes, 'site-a', 'edge-a');
    await pushSnapshot(web.base, makeSnapshot('edge-a', 'site-a', 'Building A', 'Site A study room', {
      model: { assetId: ASSET_ID, transform: MODEL_TRANSFORM },
    }));
    await pushSnapshot(web.base, makeSnapshot('edge-b', 'site-b', 'Building B', 'Site B study room', { model: null }));
    await pushSnapshot(web.base, makeSnapshot('edge-legacy', 'legacy-campus', 'Haking Wong Building', 'Makerspace A', {
      floorId: 'iw-maker-a', omitModel: true,
    }));

    await page.goto(`${web.base}/dashboard/`);
    await page.getByRole('heading', { name: 'Find a seat' }).waitFor();
    await page.getByTestId('student-location-search').waitFor();
    assert.equal(await page.locator('[data-testid^="student-location-card-"]').count() >= 2, true);
    await screenshot(page, 'student-dashboard');

    const siteOnly = await fetch(`${web.base}/api/search?seats=1&siteId=site-a`, { headers: { cookie: `tm_session=${cookie}` } });
    assert.equal(siteOnly.status, 400, 'siteId cannot select a floor by itself');
    const ambiguousSearch = await fetch(`${web.base}/api/search?seats=1&floor=shared-room`, { headers: { cookie: `tm_session=${cookie}` } });
    assert.equal(ambiguousSearch.status, 409, 'a duplicate floor ID requires its site ID');
    const scopedSearch = await fetch(`${web.base}/api/search?seats=1&floor=shared-room&siteId=site-b`, { headers: { cookie: `tm_session=${cookie}` } });
    assert.equal(scopedSearch.status, 200);
    const suggestions = await scopedSearch.json();
    assert.ok(suggestions.results.length > 0);
    assert.ok(suggestions.results.every((result) => result.siteId === 'site-b' && result.floorId === 'shared-room'));

    await page.goto(`${web.base}/dashboard/spaces/shared-room`);
    await page.getByText('This old link names more than one campus location.').waitFor();
    assert.equal(await page.getByTestId('student-ambiguity-choice-site-a-shared-room').count(), 1);
    assert.equal(await page.getByTestId('student-ambiguity-choice-site-b-shared-room').count(), 1);
    await screenshot(page, 'student-ambiguous-floor');
    await page.getByTestId('student-ambiguity-choice-site-a-shared-room').click();
    await page.waitForURL('**/dashboard/spaces/site-a/shared-room**');

    const mapId = 'student-floor-map-site-a-shared-room';
    assert.equal(await page.getByTestId(mapId).count(), 1);
    for (const tableId of ['rect-table', 'round-table', 'poly-table']) {
      assert.equal(await page.getByTestId(`student-map-table-site-a-shared-room-${tableId}`).count(), 1);
      assert.equal(await page.getByTestId(`student-table-list-${tableId}`).count(), 1);
    }
    assert.match(await page.getByTestId('student-table-list-poly-table').innerText(), /No live data/);
    assert.equal(await page.getByText('West study zone').count(), 1);
    assert.equal(await page.getByText('East study zone').count(), 1);
    assert.equal(await page.getByTestId('student-model-viewer-canvas').count(), 1);
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._model && viewer?._marks && viewer?._three);
    });
    await screenshot(page, 'student-composite-model-and-map');
    const modelState = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const plate = viewer._authoredTableRecords.get('rect-table').plate;
      return {
        scale: [viewer._model.scale.x, viewer._model.scale.y, viewer._model.scale.z],
        rotationOrder: viewer._model.rotation.order,
        rotation: [viewer._model.rotation.x, viewer._model.rotation.y, viewer._model.rotation.z],
        position: [viewer._model.position.x, viewer._model.position.y, viewer._model.position.z],
        overlay: [plate.position.x, plate.position.y, plate.position.z],
      };
    });
    assert.deepEqual(modelState.scale, [1.25, 0.9, 1.1]);
    assert.equal(modelState.rotationOrder, 'XYZ');
    assert.ok(Math.abs(modelState.rotation[0] - Math.PI / 18) < 1e-10);
    assert.ok(Math.abs(modelState.rotation[1] - 22 * Math.PI / 180) < 1e-10);
    assert.ok(Math.abs(modelState.rotation[2] + 5 * Math.PI / 180) < 1e-10);
    assert.deepEqual(modelState.position, [1.25, 0.5, -0.75]);
    assert.ok(modelState.overlay.every((value, index) => Math.abs(value - [0.9, 0.025, -0.7][index]) < 1e-12),
      'the table overlay stays in authored floor coordinates while the GLB root is transformed');

    const rectRow = page.getByTestId('student-table-list-rect-table');
    await rectRow.focus();
    await rectRow.press('Enter');
    assert.equal(await rectRow.getAttribute('aria-pressed'), 'true', 'the semantic table list is keyboard operable');
    await rectRow.press('Space');
    assert.equal(await rectRow.getAttribute('aria-pressed'), 'false');
    await rectRow.click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      viewer._three.controls.target.set(1, 0.25, -1);
      viewer._three.camera.position.set(4, 5, 6);
      viewer._three.controls.update();
    });
    const cameraBeforeLiveUpdate = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z];
    });
    const requestsBeforeLiveUpdate = network.filter((item) => item.kind === 'request' && item.path === `/api/models/${ASSET_ID}`).length;
    await pushSnapshot(web.base, makeSnapshot('edge-a', 'site-a', 'Building A', 'Site A study room', {
      model: { assetId: ASSET_ID, transform: MODEL_TRANSFORM }, rectFree: 0,
    }));
    await page.getByTestId('student-table-list-rect-table').getByText('Full').waitFor();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true', 'selection stays on the stable table ID after it becomes full');
    assert.match(await page.locator('[role="status"][aria-live="polite"]').innerText(), /Rectangle table: full/);
    assert.equal(network.filter((item) => item.kind === 'request' && item.path === `/api/models/${ASSET_ID}`).length, requestsBeforeLiveUpdate,
      'occupancy-only updates do not fetch the GLB again');
    const cameraAfterLiveUpdate = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z];
    });
    assert.ok(cameraBeforeLiveUpdate.every((value, index) => Math.abs(value - cameraAfterLiveUpdate[index]) < 1e-9),
      'occupancy-only updates do not reset the live camera');

    await page.setViewportSize({ width: 360, height: 800 });
    const mobile = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      tableTarget: document.querySelector('[data-testid="student-table-list-rect-table"]').getBoundingClientRect().height,
    }));
    assert.ok(mobile.width <= mobile.viewport + 1, 'mobile floor content does not overflow horizontally');
    assert.ok(mobile.tableTarget >= 44, 'mobile table list controls meet the touch target size');
    await exerciseTouchPinch(context, page);
    await screenshot(page, 'student-mobile-location');

    await page.setViewportSize({ width: 1280, height: 900 });
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true,
    }));
    const modelRequestCountBeforeGenerated = network.filter((item) => item.kind === 'request' && item.path.startsWith('/api/models/')).length;
    await page.goto(`${web.base}/dashboard/spaces/generated-site/iw-maker-a`);
    try { await page.getByTestId('student-simple-room-viewer').waitFor({ timeout: 8000 }); }
    catch {
      const pageText = await page.locator('body').innerText();
      throw new Error(`generated floor did not select its viewer; body=${pageText}; browserErrors=${errors.join(' | ')}; paths=${network.map((item) => item.path).join(',')}`);
    }
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._generatedShell && viewer?._generatedTableRecords?.size === 3 && viewer?._three);
    });
    assert.match(await page.locator('.panel-3d .panel-title').innerText(), /Built-in 3D room/i);
    assert.equal(await page.getByTestId('student-table-list-poly-table').count(), 1);
    await screenshot(page, 'student-generated-room-and-map');
    const generatedState = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const THREE = viewer._L.THREE;
      const rect = viewer._generatedTableRecords.get('rect-table');
      const round = viewer._generatedTableRecords.get('round-table');
      const polygon = viewer._generatedTableRecords.get('poly-table');
      const bounds = (mesh) => {
        const box = new THREE.Box3().setFromObject(mesh);
        return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
      };
      const polygonPoints = [
        [3.4025, -0.305], [4.6025, -0.305], [4.6025, -0.505],
        [4.0025, -0.505], [4.0025, -1.005], [3.4025, -1.005],
      ];
      const positions = polygon.plate.geometry.attributes.position;
      const topVertices = Array.from({ length: positions.count }, (_, index) => [
        positions.getX(index) + polygon.plate.position.x,
        positions.getY(index) + polygon.plate.position.y,
        positions.getZ(index) + polygon.plate.position.z,
      ]);
      const polygonVertices = polygonPoints.map(([x, z]) => topVertices.some((point) =>
        Math.abs(point[0] - x) < 1e-6 && Math.abs(point[1] - 0.75) < 1e-6 && Math.abs(point[2] - z) < 1e-6));
      const seat = rect.seats.get('rect-table-seat-1');
      const sidesAt = (x, z) => {
        const centreX = 3, centreZ = -2;
        viewer._three.camera.position.set(x, 4, z);
        viewer._three.controls.target.set(centreX, 0.2, centreZ);
        viewer._three.controls.dispatchEvent({ type: 'change' });
        return Object.fromEntries(Object.entries(viewer._walls).map(([side, wall]) => [side, wall.visible]));
      };
      return {
        source: viewer.getAttribute('procedural-room'),
        attributes: viewer.getAttributeNames(),
        shellParts: viewer._generatedShell.children.length,
        wallCount: Object.keys(viewer._walls).length,
        wallBounds: Object.fromEntries(Object.entries(viewer._walls).map(([side, wall]) => [side, bounds(wall)])),
        rect: bounds(rect.plate),
        round: bounds(round.plate),
        polygon: bounds(polygon.plate),
        polygonVertices,
        chairShapeTypes: [seat.geometry.type, round.seats.get('round-table-seat-1').geometry.type],
        seatPosition: [seat.position.x, seat.position.y, seat.position.z],
        cardinal: sidesAt(8, -2),
        diagonal: sidesAt(7, -6),
        otherCardinal: sidesAt(3, 4),
      };
    });
    assert.equal(generatedState.source, 'simple-rectangle-v1');
    assert.equal(generatedState.attributes.includes('src'), false, 'generated rooms never carry a model URL attribute');
    assert.equal(generatedState.shellParts, 2, 'generated shell has floor and walls, without a roof');
    assert.equal(generatedState.wallCount, 4);
    for (const wall of Object.values(generatedState.wallBounds)) {
      assert.ok(Math.abs(wall.min[1]) < 1e-8 && Math.abs(wall.max[1] - 3) < 1e-8, 'each generated wall is exactly 3 m high');
    }
    const rounded = (value) => { const result = Number(value.toFixed(6)); return result === 0 ? 0 : result; };
    assert.deepEqual(generatedState.rect.min.map(rounded), [0.4025, 0, -1.01]);
    assert.deepEqual(generatedState.rect.max.map(rounded), [1.405, 0.75, -0.405]);
    assert.deepEqual(generatedState.round.min.map(rounded), [1.85, 0, -1.3575]);
    assert.deepEqual(generatedState.round.max.map(rounded), [2.56, 0.75, -0.6475]);
    assert.deepEqual(generatedState.polygon.min.map(rounded), [3.4025, 0, -1.005]);
    assert.deepEqual(generatedState.polygon.max.map(rounded), [4.6025, 0.75, -0.305]);
    assert.deepEqual(generatedState.polygonVertices, [true, true, true, true, true, true], 'the concave authored vertices survive projection without rounding');
    assert.deepEqual(generatedState.chairShapeTypes, ['BoxGeometry', 'CylinderGeometry']);
    assert.deepEqual(generatedState.seatPosition, [0.6025, 0.1, -0.705], 'chair proxies stay at the exact public seat coordinate');
    assert.deepEqual(Object.entries(generatedState.cardinal).filter(([, visible]) => !visible).map(([side]) => side), ['east']);
    assert.deepEqual(Object.entries(generatedState.diagonal).filter(([, visible]) => !visible).map(([side]) => side).sort(), ['east', 'north']);
    assert.deepEqual(Object.entries(generatedState.otherCardinal).filter(([, visible]) => !visible).map(([side]) => side), ['south']);
    assert.equal(network.filter((item) => item.kind === 'request' && item.path.startsWith('/api/models/')).length,
      modelRequestCountBeforeGenerated, 'generated floors do not request a model asset');
    assert.equal(await page.locator('floor-viewer[src]').count(), 0);

    const generatedRow = page.getByTestId('student-table-list-rect-table');
    await generatedRow.click();
    assert.equal(await generatedRow.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      viewer._three.controls.target.set(3, 0.2, -2);
      viewer._three.camera.position.set(6.5, 5, -5.5);
      viewer._three.controls.dispatchEvent({ type: 'change' });
      const record = viewer._generatedTableRecords.get('rect-table');
      window.__studentGeneratedBefore = {
        record, geometry: record.plate.geometry,
        camera: [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z],
      };
    });
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true, rectFree: 0,
    }));
    await page.getByTestId('student-table-list-rect-table').getByText('Full').waitFor();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true', 'selected identity survives an occupancy-only update');
    assert.match(await page.locator('[role="status"][aria-live="polite"]').innerText(), /Rectangle table: full/);
    const generatedUpdate = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const record = viewer._generatedTableRecords.get('rect-table');
      return {
        sameRecord: record === window.__studentGeneratedBefore.record,
        sameGeometry: record.plate.geometry === window.__studentGeneratedBefore.geometry,
        camera: [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z],
        beforeCamera: window.__studentGeneratedBefore.camera,
        selected: viewer._generatedTableRecords.get('rect-table').plate.material.color.getHex(),
      };
    });
    assert.equal(generatedUpdate.sameRecord, true, 'status-only changes keep the table scene record mounted');
    assert.equal(generatedUpdate.sameGeometry, true, 'status-only changes keep table mesh geometry');
    assert.ok(generatedUpdate.beforeCamera.every((value, index) => Math.abs(value - generatedUpdate.camera[index]) < 1e-9),
      'status-only changes retain orbit and zoom');

    await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const record = viewer._generatedTableRecords.get('rect-table');
      window.__studentGeometryBefore = {
        record, x: record.plate.position.x,
        camera: [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z],
      };
    });
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true, rectFree: 0, rectXOffsetCm: 40,
    }));
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return viewer?._generatedTableRecords.get('rect-table')?.plate.position.x > window.__studentGeometryBefore.x + 0.3;
    });
    assert.equal(await generatedRow.getAttribute('aria-pressed'), 'true', 'an extant selected table survives a geometry update');
    const geometryUpdate = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const record = viewer._generatedTableRecords.get('rect-table');
      return {
        replacedRecord: record !== window.__studentGeometryBefore.record,
        camera: [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z],
        beforeCamera: window.__studentGeometryBefore.camera,
      };
    });
    assert.equal(geometryUpdate.replacedRecord, true, 'the changed table footprint replaces its scene record');
    assert.ok(geometryUpdate.beforeCamera.every((value, index) => Math.abs(value - geometryUpdate.camera[index]) < 1e-9),
      'geometry updates retain the orbit camera');

    moduleRetryEvidence = await assertViewerModuleRetry(browser, web);

    await page.getByTestId('student-directions-toggle').click();
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions');
    await page.evaluate(() => {
      const status = document.querySelector('[role="status"][aria-live="polite"]');
      window.__studentRemovalAnnouncementCount = 0;
      window.__studentRemovalAnnouncementObserver = new MutationObserver(() => {
        if (status.textContent.trim() === 'The selected table was removed from this location.') {
          window.__studentRemovalAnnouncementCount += 1;
        }
      });
      window.__studentRemovalAnnouncementObserver.observe(status, { childList: true, subtree: true, characterData: true });
    });
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true, rectFree: 0, removeTableId: 'rect-table',
    }));
    const removalMessage = 'The selected table was removed from this location.';
    await page.waitForFunction((message) =>
      document.querySelector('[role="status"][aria-live="polite"]')?.textContent.trim() === message, removalMessage);
    await page.getByTestId('student-table-list-rect-table').waitFor({ state: 'detached' });
    await page.getByTestId('student-map-table-generated-site-iw-maker-a-rect-table').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Get directions', 'removal clears directions');
    assert.equal(await page.getByTestId('student-table-list-round-table').getAttribute('aria-pressed'), 'false', 'removal clears table selection');
    const removalState = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      const layout = JSON.parse(viewer.getAttribute('location-layout'));
      const announcementCount = window.__studentRemovalAnnouncementCount;
      window.__studentRemovalAnnouncementObserver.disconnect();
      return { selectedTableId: layout.selectedTableId, announcementCount };
    });
    assert.equal(removalState.selectedTableId, null, 'the generated viewer receives the cleared selection');
    assert.equal(removalState.announcementCount, 1, 'the polite removal message is announced once');
    await screenshot(page, 'student-generated-table-removed');

    const firstFloor = makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true,
    }).floors[0];
    const secondFloor = makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Second Room', {
      floorId: 'iw-maker-b', proceduralRoom: true,
    }).floors[0];
    await pushSnapshot(web.base, {
      version: 2, edgeId: 'edge-generated', site: { id: 'generated-site', name: 'generated-site' },
      generatedAt: Date.now(), floors: [firstFloor, secondFloor],
    });
    const secondFloorCard = page.getByTestId('student-space-card-generated-site-iw-maker-b');
    await secondFloorCard.waitFor();
    await page.getByTestId('student-table-list-rect-table').click();
    await page.getByTestId('student-directions-toggle').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions');
    await secondFloorCard.click();
    await page.waitForFunction(() => location.pathname.endsWith('/iw-maker-b'));
    await page.waitForFunction(() => document.querySelector('[data-testid="student-table-list-rect-table"]')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Get directions', 'composite floor changes keep the existing reset behavior');

    await pushSnapshot(web.base, { version: 2, edgeId: 'edge-generated', site: { id: 'generated-site', name: 'generated-site' }, generatedAt: Date.now(), floors: [] });

    await page.route('**/assets/floors/makerspace-floor.glb', (route) => route.fulfill({
      status: 200, contentType: 'model/gltf-binary', body: bytes,
    }));
    await page.goto(`${web.base}/dashboard/spaces/legacy-campus/iw-maker-a`);
    await page.waitForFunction(() => document.querySelector('floor-viewer')?._model);
    const legacySrc = await page.locator('floor-viewer').getAttribute('src');
    assert.equal(legacySrc, '/assets/floors/makerspace-floor.glb', 'a unique legacy floor keeps its existing catalog model fallback');

    await pushSnapshot(web.base, makeSnapshot('edge-a', 'site-a', 'Building A', 'Site A study room', { model: null, rectFree: 0 }));
    await page.goto(`${web.base}/dashboard/spaces/site-a/shared-room`);
    await page.getByTestId(mapId).waitFor();
    assert.equal(await page.getByTestId('student-model-viewer-canvas').count(), 0, 'explicit model:null removes the uploaded GLB panel');
    assert.equal(await page.getByTestId('student-map-table-site-a-shared-room-rect-table').count(), 1, 'the geometric map remains usable');
    await screenshot(page, 'student-explicit-2d-location');

    await assertEmptyAndRetry(browser, emptyWeb);
    assert.deepEqual(errors, [], `browser console/page errors: ${errors.join('; ')}`);
    await storeArtifacts({ errors, network, moduleRetry: moduleRetryEvidence });
  } finally {
    if (traceStarted && tracePath) await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopWeb(emptyWeb);
    await stopWeb(web);
    rmSync(temporary, { recursive: true, force: true });
  }
});

async function assertViewerModuleRetry(browser, web) {
  const cookie = await signup(web.base, 'student-module-retry@connect.hku.hk');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'tm_session', value: cookie, url: web.base }]);
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  const moduleRequests = [];
  const moduleResponses = [];
  const modelRequests = [];
  const unexpectedErrors = [];
  let injectedFailures = 0;
  let expectedFailureConsoleEvents = 0;
  let failedUrl = null;
  page.on('pageerror', (error) => unexpectedErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    let sameFailedModule = false;
    try { sameFailedModule = failedUrl !== null && new URL(location).href === failedUrl; } catch { /* no source URL */ }
    if (sameFailedModule && /^Failed to load resource: the server responded with a status of 503\b/.test(message.text())) {
      expectedFailureConsoleEvents += 1;
      return;
    }
    unexpectedErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/three/OrbitControls.js')) moduleResponses.push({ url: url.href, status: response.status() });
  });
  await page.route(/\/vendor\/(?:v[0-9a-f]+\/)?three\/OrbitControls\.js(?:\?.*)?$/, async (route) => {
    const url = route.request().url();
    moduleRequests.push(url);
    if (injectedFailures === 0) {
      injectedFailures += 1;
      failedUrl = url;
      await route.fulfill({ status: 503, contentType: 'text/javascript', body: '// synthetic one-shot module load failure' });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/models/**', async (route) => {
    modelRequests.push(route.request().url());
    await route.continue();
  });
  try {
    await page.goto(`${web.base}/dashboard/spaces/generated-site/iw-maker-a`);
    const unavailable = page.locator('.viewer-error[role="status"]');
    await unavailable.waitFor();
    assert.match(await unavailable.innerText(), /3D view unavailable\. Use the floor map below\./);
    assert.equal(await page.getByTestId('student-map-table-generated-site-iw-maker-a-rect-table').count(), 1,
      'the accessible floor map remains usable while the 3D module is unavailable');
    assert.equal(injectedFailures, 1, 'the harness injects exactly one failed module response');
    assert.equal(moduleRequests.length, 1, 'the initial renderer construction makes one OrbitControls module request');
    assert.equal(moduleResponses.length, 1);
    assert.equal(moduleResponses[0].status, 503);
    await screenshot(page, 'student-module-retry-unavailable');

    await page.getByTestId('student-model-preview-retry').click();
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._three && viewer?._generatedShell && viewer?._generatedTableRecords?.size === 3);
    });
    assert.equal(await page.locator('.viewer-error[role="status"]').count(), 0);
    assert.equal(moduleRequests.length, 2, 'retry uses a fresh module URL after the rejected import');
    assert.notEqual(moduleRequests[0], moduleRequests[1]);
    assert.deepEqual(moduleResponses.map((response) => response.status), [503, 200]);
    assert.equal(expectedFailureConsoleEvents, 1,
      'only the console event for the exact injected 503 OrbitControls request is consumed');
    assert.deepEqual(unexpectedErrors, [], `unexpected module retry errors: ${unexpectedErrors.join('; ')}`);
    assert.equal(modelRequests.length, 0, 'generated module recovery does not request a model asset');
    assert.equal(await page.locator('floor-viewer[src]').count(), 0);
    await screenshot(page, 'student-module-retry-recovered');
    return { injectedFailures, moduleRequests, moduleResponses, expectedFailureConsoleEvents, unexpectedErrors, modelRequests };
  } finally {
    await context.close();
  }
}

async function assertEmptyAndRetry(browser, web) {
  const cookie = await signup(web.base, 'student-empty@connect.hku.hk');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'tm_session', value: cookie, url: web.base }]);
  const page = await context.newPage();
  try {
    await page.goto(`${web.base}/dashboard/`);
    await page.getByTestId('student-no-study-spaces').waitFor();
    await page.goto(`${web.base}/dashboard/spaces/`);
    await page.getByRole('heading', { name: 'No study spaces are available right now' }).waitFor();

    const bad = makeSnapshot('edge-retry', 'retry-campus', 'Retry Building', 'Retry Room', { model: null });
    bad.floors[0].totals.free += 1;
    assert.equal(web.store.put(bad), true);
    await page.goto(`${web.base}/dashboard/`);
    await page.getByRole('heading', { name: 'Location data could not be displayed' }).waitFor();
    await page.getByTestId('student-feed-retry').click();
    await page.getByRole('heading', { name: 'Location data could not be displayed' }).waitFor();

    await pushSnapshot(web.base, makeSnapshot('edge-retry', 'retry-campus', 'Retry Building', 'Retry Room', { model: null }));
    await page.getByTestId('student-no-study-spaces').waitFor({ state: 'detached' });
    await page.getByTestId(`student-location-card-${encodeURIComponent('dynamic:["retry-campus","Retry Building"]')}`).waitFor();
    await screenshot(page, 'student-feed-recovered');
  } finally {
    await context.close();
  }
}

async function startWeb(directory) {
  mkdirSync(directory, { recursive: true });
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: PUSH_TOKEN,
    sessionSecret: Buffer.from('task-4-1-browser-secret-that-is-not-production'),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 60_000,
  });
  await new Promise((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  return { ...web, base: `http://127.0.0.1:${web.server.address().port}` };
}

async function stopWeb(web) {
  web.server.closeAllConnections();
  await web.dispose();
  await new Promise((resolve) => web.server.close(resolve));
}

async function signup(base, email) {
  const response = await fetch(`${base}/signup`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, name: 'Browser student', password: 'local browser test password' }),
  });
  assert.equal(response.status, 200, 'signed test student session is created');
  const raw = response.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';', 1)[0] ?? '';
  assert.ok(cookie.startsWith('tm_session='));
  return cookie.slice('tm_session='.length);
}

async function uploadModel(base, bytes, locationId, edgeId) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const response = await fetch(`${base}/api/edge/location-assets/${locationId}/${ASSET_ID}`, {
    method: 'PUT', headers: {
      authorization: `Bearer ${PUSH_TOKEN}`, 'x-tm-edge-id': edgeId,
      'x-tm-sha256': sha256, 'content-type': 'model/gltf-binary',
    }, body: bytes,
  });
  assert.equal(response.status, 201);
}

async function pushSnapshot(base, value) {
  const response = await fetch(`${base}/api/edge/snapshot`, {
    method: 'POST', headers: { authorization: `Bearer ${PUSH_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
}

function makeSnapshot(edgeId, siteId, building, name, options = {}) {
  const floorId = options.floorId ?? 'shared-room';
  const rectFree = options.rectFree ?? 2;
  const generated = options.proceduralRoom === true;
  const rectSeats = seatPair('rect-table', rectFree, generated);
  const roundSeats = seatPair('round-table', 0, generated);
  const polygonSeats = seatPair('poly-table', null, generated);
  const rectX = (generated ? 40.25 : 40) + (options.rectXOffsetCm ?? 0);
  const tables = [
    table('rect-table', 'Rectangle table', 'zone-west', { type: 'rect', x: rectX, y: generated ? 40.5 : 40, width: generated ? 100.25 : 100, height: generated ? 60.5 : 60 }, rectSeats, rectFree),
    table('round-table', 'Round table', 'zone-west', { type: 'circle', cx: generated ? 220.5 : 220, cy: generated ? 100.25 : 100, radius: generated ? 35.5 : 35 }, roundSeats, 0),
    table('poly-table', 'Polygon table', 'zone-east', { type: 'polygon', points: generated
      ? [[340.25, 30.5], [460.25, 30.5], [460.25, 50.5], [400.25, 50.5], [400.25, 100.5], [340.25, 100.5]]
      : [[340, 30], [460, 30], [450, 100], [340, 90]] }, polygonSeats, null),
  ];
  const visibleTables = tables.filter((item) => item.id !== options.removeTableId);
  const knownTables = visibleTables.filter((item) => item.status !== 'unknown');
  const floor = {
    id: floorId, building, name, width: 600, height: 400,
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    zones: [
      { id: 'zone-west', name: 'West study zone', polygon: [[0, 0], [300, 0], [300, 400], [0, 400]], people: 3 },
      { id: 'zone-east', name: 'East study zone', polygon: [[300, 0], [600, 0], [600, 400], [300, 400]], people: 1 },
    ],
    tables: visibleTables,
    totals: {
      seats: visibleTables.reduce((sum, item) => sum + item.capacity, 0),
      free: knownTables.reduce((sum, item) => sum + (item.free ?? 0), 0),
      occupied: knownTables.reduce((sum, item) => sum + (item.occupied ?? 0), 0),
      unknownSeats: visibleTables.filter((item) => item.status === 'unknown').reduce((sum, item) => sum + item.capacity, 0),
      tablesFullyFree: knownTables.filter((item) => item.occupied === 0).length,
    },
  };
  if (generated) floor.proceduralRoom = 'simple-rectangle-v1';
  else if (!options.omitModel) floor.model = options.model ?? null;
  return { version: 2, edgeId, site: { id: siteId, name: siteId }, generatedAt: Date.now(), floors: [floor] };
}

function table(id, name, zoneId, shape, seats, free) {
  const rect = shape.type === 'circle'
    ? { x: shape.cx - shape.radius, y: shape.cy - shape.radius, width: shape.radius * 2, height: shape.radius * 2 }
    : shape.type === 'polygon'
      ? { x: Math.min(...shape.points.map((point) => point[0])), y: Math.min(...shape.points.map((point) => point[1])),
        width: Math.max(...shape.points.map((point) => point[0])) - Math.min(...shape.points.map((point) => point[0])),
        height: Math.max(...shape.points.map((point) => point[1])) - Math.min(...shape.points.map((point) => point[1])) }
      : { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  const unknown = free === null;
  return {
    id, name, zoneId, rect, shape, capacity: 2,
    occupied: unknown ? null : 2 - free, free,
    status: unknown ? 'unknown' : 'ok', seats,
  };
}

function seatPair(tableId, free, fractional = false) {
  const status = free === null ? [null, null] : [0, 1].map((index) => index >= free);
  return [0, 1].map((index) => ({
    id: `${tableId}-seat-${index + 1}`, x: (fractional ? 60.25 : 60) + index * 35, y: fractional ? 70.5 : 70,
    side: 'T', index, occupied: status[index],
    neighbors: [`${tableId}-seat-${index === 0 ? 2 : 1}`],
  }));
}

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

async function screenshot(page, name) {
  if (!ARTIFACT_DIR) return;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACT_DIR, `${name}.png`), fullPage: true });
}

async function exerciseTouchPinch(context, page) {
  const viewer = page.getByTestId('student-model-viewer-canvas');
  await viewer.scrollIntoViewIfNeeded();
  const bounds = await viewer.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100, 'the mobile 3D viewer has a touchable viewport');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const before = await page.evaluate(() => {
    const element = document.querySelector('floor-viewer');
    return element._three.camera.position.distanceTo(element._three.controls.target);
  });
  const session = await context.newCDPSession(page);
  try {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
      { id: 1, x: x - 35, y, radiusX: 4, radiusY: 4, force: 1 },
      { id: 2, x: x + 35, y, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
      { id: 1, x: x - 70, y, radiusX: 4, radiusY: 4, force: 1 },
      { id: 2, x: x + 70, y, radiusX: 4, radiusY: 4, force: 1 },
    ] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
  const after = await page.evaluate(() => {
    const element = document.querySelector('floor-viewer');
    return element._three.camera.position.distanceTo(element._three.controls.target);
  });
  assert.ok(after < before, 'two-finger pinch changes the mobile viewer zoom without changing alignment data');
}

async function storeArtifacts(value) {
  if (!ARTIFACT_DIR) return;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, 'student-browser-network.json'), JSON.stringify(value, null, 2));
}
