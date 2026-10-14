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
const TABLE_ASSET_ID = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a02';
const CHAIR_ASSET_ID = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a03';
const TABLE_OVERRIDE_ASSET_ID = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a04';
const STALE_ASSET_ID = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a05';
const STUDENT_FURNITURE = {
  version: 3,
  furnitureDefaults: {
    table: { assetId: TABLE_ASSET_ID, scale: 0.75, yawDeg: 15, elevationM: 0.2 },
    chair: { assetId: CHAIR_ASSET_ID, scale: 0.5, yawDeg: -10, elevationM: 0.05 },
  },
  furnitureOverrides: {
    'rect-table': { table: { assetId: TABLE_OVERRIDE_ASSET_ID, scale: 1.25, yawDeg: 30, elevationM: 0.3 } },
  },
};
const MODEL_TRANSFORM = {
  scale: { x: 1.25, y: 0.9, z: 1.1 },
  rotationDeg: { x: 10, y: 22, z: -5 },
  positionM: { x: 1.25, y: 0.5, z: -0.75 },
};
const ROOM_VIEW_MODE_KEY = 'hkumyseat.student.room-view-mode.v1';
const ARTIFACT_DIR = process.env.TASK_3D_ARTIFACTS || process.env.TASK_2_3_ARTIFACTS;

test('signed student browser renders composite locations, aligned models, live status and recovery', { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'tmedge-student-locations-'));
  const web = await startWeb(join(temporary, 'main'));
  const emptyWeb = await startWeb(join(temporary, 'empty'));
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  const network = [];
  let moduleRetryEvidence = null;
  let furnitureRetryEvidence = null;
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
    await uploadModel(web.base, bytes, 'site-a', 'edge-a', TABLE_ASSET_ID);
    await uploadModel(web.base, bytes, 'site-a', 'edge-a', CHAIR_ASSET_ID);
    await uploadModel(web.base, bytes, 'site-a', 'edge-a', TABLE_OVERRIDE_ASSET_ID);
    await pushSnapshot(web.base, makeSnapshot('edge-a', 'site-a', 'Building A', 'Site A study room', {
      ...STUDENT_FURNITURE, model: { assetId: ASSET_ID, transform: MODEL_TRANSFORM }, concavePolygon: true,
    }));
    await pushSnapshot(web.base, makeSnapshot('edge-b', 'site-b', 'Building B', 'Site B study room', {
      ...STUDENT_FURNITURE, model: null,
    }));
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
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._model && viewer?._marks && viewer?._three && viewer?._furnitureInstances?.size === 9);
    });
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.getByRole('radio', { name: '3D view' }).isChecked(), true,
      'a first visit defaults to 3D when the published custom model is available');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), null,
      'the source-based default does not write a preference before a deliberate choice');
    assert.equal(await page.getByTestId(mapId).count(), 0, 'the inactive map is not rendered in 3D mode');
    assert.equal(await page.getByTestId('student-model-viewer-canvas').isVisible(), true);
    await page.getByRole('radio', { name: '3D view' }).click();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d',
      'deliberately choosing the already active default view stores that preference');
    await screenshot(page, 'student-composite-model-3d');
    for (const assetId of [ASSET_ID, TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID]) {
      assert.equal(network.filter((item) => item.kind === 'request' && item.path === `/api/models/${assetId}`).length, 1,
        `the custom room and repeated furniture assignments request ${assetId} exactly once`);
    }
    const customFurniture = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [...viewer._furnitureInstances.entries()].map(([key, object]) => ({
        key,
        assetId: object.userData.assetId,
        tableId: object.userData.tableId,
        slot: object.userData.slot,
        seatId: object.userData.seatId ?? null,
        position: [object.position.x, object.position.y, object.position.z],
        scale: [object.scale.x, object.scale.y, object.scale.z],
        yaw: object.rotation.y,
      }));
    });
    assert.equal(customFurniture.length, 9, 'three tables and six chairs render as separately keyed instances');
    assert.equal(customFurniture.filter((item) => item.assetId === CHAIR_ASSET_ID).length, 6,
      'the inherited chair default produces one model per authored seat');
    assert.ok(customFurniture.filter((item) => item.assetId === TABLE_ASSET_ID).every((item) => item.slot === 'table'),
      'unoverridden table slots inherit the complete room default');
    assert.deepEqual(customFurniture.filter((item) => item.tableId === 'rect-table' && item.slot === 'table').map((item) => item.assetId),
      [TABLE_OVERRIDE_ASSET_ID], 'the complete table override replaces the default for that table only');
    const projectedFurniture = await page.evaluate(() => Object.fromEntries(
      JSON.parse(document.querySelector('floor-viewer').getAttribute('location-layout')).tables
        .map((table) => [table.id, table.furniture]),
    ));
    assert.deepEqual(projectedFurniture['rect-table'], {
      table: STUDENT_FURNITURE.furnitureOverrides['rect-table'].table,
      chair: STUDENT_FURNITURE.furnitureDefaults.chair,
    }, 'the bridge sends the complete table override and inherits the missing chair slot');
    assert.deepEqual(projectedFurniture['round-table'], STUDENT_FURNITURE.furnitureDefaults,
      'the bridge sends room defaults for an unoverridden table');
    const concaveTable = customFurniture.find((item) => item.tableId === 'poly-table' && item.slot === 'table');
    const expectedConcaveCenter = { x: 3.8333333333333335, z: -0.5944444444444443 };
    assert.ok(concaveTable.position.every((value, index) => Math.abs(value - [expectedConcaveCenter.x, 0.2, expectedConcaveCenter.z][index]) < 1e-8),
      'a nonrectangular table uses the console shoelace centroid for its furniture anchor');
    const rectTable = customFurniture.find((item) => item.tableId === 'rect-table' && item.slot === 'table');
    assert.ok(rectTable.position.every((value, index) => Math.abs(value - [0.9, 0.3, -0.7][index]) < 1e-8),
      'rectangular table furniture uses the footprint center and authored elevation');
    assert.deepEqual(rectTable.scale, [1.25, 1.25, 1.25], 'the model uses its authored uniform scale');
    assert.ok(Math.abs(rectTable.yaw - Math.PI / 6) < 1e-10, 'table yaw is applied in world Y');
    const roundTable = customFurniture.find((item) => item.tableId === 'round-table' && item.slot === 'table');
    assert.ok(roundTable.position.every((value, index) => Math.abs(value - [2.2, 0.2, -1][index]) < 1e-8),
      'circle table furniture uses its authored center');
    const rectChair = customFurniture.find((item) => item.tableId === 'rect-table' && item.slot === 'chair');
    assert.ok(Math.abs(rectChair.yaw - (Math.PI - Math.PI / 18)) < 1e-10,
      'chair assignment yaw composes with the canonical T-side orientation');
    assert.ok(customFurniture.filter((item) => item.tableId === 'rect-table' && item.slot === 'chair')[0].position
      .every((value, index) => Math.abs(value - [0.6, 0.05, -0.7][index]) < 1e-8),
      'chair bases stay on the projected authored seat coordinate plus elevation');
    const furnitureOverlayInWorld = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      let parent = viewer._furnitureInstances.values().next().value?.parent;
      while (parent) {
        if (parent === viewer._model) return false;
        parent = parent.parent;
      }
      return true;
    });
    assert.equal(furnitureOverlayInWorld, true, 'custom furniture anchors stay in floor coordinates outside the room GLB transform');
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
    assert.ok(modelState.overlay.every((value, index) => Math.abs(value - [0.9, 0.325, -0.7][index]) < 1e-12),
      'the table status overlay follows the assigned model height in authored floor coordinates');

    const initialViewer = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      viewer._three.controls.target.set(1, 0.25, -1);
      viewer._three.camera.position.set(4, 5, 6);
      viewer._three.controls.update();
      window.__studentOriginalViewer = viewer;
      return { position: [4, 5, 6], target: [1, 0.25, -1] };
    });
    await page.getByRole('radio', { name: '2D map' }).check();
    await assertSingleRenderer(page, '2d');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '2d',
      'a deliberate mode choice is remembered in one browser-local key');
    assert.equal(await page.getByTestId('student-3d-renderer').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.getByTestId('student-3d-renderer').getAttribute('inert'), '');
    assert.equal(await page.getByTestId('student-model-zoom-control').isVisible(), false,
      'inactive 3D controls are absent from the visible and keyboard-accessible view');
    for (const tableId of ['rect-table', 'round-table', 'poly-table']) {
      assert.equal(await page.getByTestId(`student-map-table-site-a-shared-room-${tableId}`).count(), 1);
      assert.equal(await page.getByTestId(`student-table-list-${tableId}`).count(), 1);
    }
    assert.match(await page.getByTestId('student-table-list-poly-table').innerText(), /No live data/);
    assert.equal(await page.getByText('West study zone').count(), 1);
    assert.equal(await page.getByText('East study zone').count(), 1);
    await screenshot(page, 'student-composite-model-2d-map');
    await page.getByTestId('student-map-table-site-a-shared-room-rect-table').focus();
    await page.getByTestId('student-map-table-site-a-shared-room-rect-table').press('Enter');
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true',
      'the map updates the same stable table selection as the 3D view and availability list');
    await page.getByRole('radio', { name: '3D view' }).check();
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true',
      'switching views preserves the selected table');
    const cameraAfterToggle = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return {
        sameViewer: viewer === window.__studentOriginalViewer,
        position: [viewer._three.camera.position.x, viewer._three.camera.position.y, viewer._three.camera.position.z],
        target: [viewer._three.controls.target.x, viewer._three.controls.target.y, viewer._three.controls.target.z],
      };
    });
    assert.equal(cameraAfterToggle.sameViewer, true, 'the 3D scene stays mounted while the map is active');
    assert.ok(cameraAfterToggle.position.every((value, index) => Math.abs(value - initialViewer.position[index]) < 1e-9),
      'switching views retains camera orbit and zoom');
    assert.ok(cameraAfterToggle.target.every((value, index) => Math.abs(value - initialViewer.target[index]) < 1e-9),
      'switching views retains the orbit target');
    await page.getByTestId('student-directions-toggle').click();
    await page.getByRole('radio', { name: '2D map' }).check();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    await page.getByRole('radio', { name: '3D view' }).check();
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions',
      'switching views preserves the directions state');
    await page.getByRole('radio', { name: '2D map' }).check();
    await page.reload();
    await page.getByTestId(mapId).waitFor();
    await assertSingleRenderer(page, '2d');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '2d',
      'the selected mode survives reloads');
    await page.getByRole('radio', { name: '3D view' }).check();
    await page.waitForFunction(() => Boolean(document.querySelector('floor-viewer')?._model));
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d');

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
      ...STUDENT_FURNITURE, model: { assetId: ASSET_ID, transform: MODEL_TRANSFORM }, rectFree: 0, concavePolygon: true,
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
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.getByTestId('student-floor-map-generated-site-iw-maker-a').count(), 0,
      'generated rooms do not render a second floor map below the 3D view');
    assert.equal(await page.getByTestId('student-table-list-poly-table').count(), 1);
    await screenshot(page, 'student-generated-room-3d');
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
      modelRequestCountBeforeGenerated, 'unassigned generated floors do not request model assets');
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

    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      floorId: 'iw-maker-a', proceduralRoom: true, rectFree: 2, rectXOffsetCm: 40,
    }));
    moduleRetryEvidence = await assertViewerModuleRetry(browser, web);

    const furnitureRequestsBefore2dOnly = network.filter((item) => item.kind === 'request'
      && [TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID].some((assetId) => item.path === `/api/models/${assetId}`)).length;
    await page.goto(`${web.base}/dashboard/spaces/site-b/shared-room`);
    await assertSingleRenderer(page, '2d');
    assert.equal(network.filter((item) => item.kind === 'request'
      && [TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID].some((assetId) => item.path === `/api/models/${assetId}`)).length,
    furnitureRequestsBefore2dOnly, 'v3 assignments on an explicit 2D-only source do not fetch furniture');
    assert.equal(await page.getByRole('radio', { name: '3D view' }).isDisabled(), true,
      'a valid 2D-only floor disables 3D with an explanation');
    assert.equal(await page.getByText('3D view is not available for this location.').count(), 1);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d',
      'a map-only floor does not overwrite the remembered 3D preference');
    await page.goto(`${web.base}/dashboard/spaces/generated-site/iw-maker-a`);
    await page.waitForFunction(() => Boolean(document.querySelector('floor-viewer')?._generatedShell));
    await assertSingleRenderer(page, '3d');

    await page.getByTestId('student-table-list-rect-table').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('student-directions-toggle').click();
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions');
    await page.getByRole('radio', { name: '2D map' }).check();
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
    await page.getByRole('radio', { name: '3D view' }).check();
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Get directions',
      'removing the selected table clears directions and the reset is retained across a mode switch');

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
    const furnitureRequestsBeforeLegacy = network.filter((item) => item.kind === 'request'
      && [TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID].some((assetId) => item.path === `/api/models/${assetId}`)).length;
    await page.goto(`${web.base}/dashboard/spaces/legacy-campus/iw-maker-a`);
    await page.waitForFunction(() => document.querySelector('floor-viewer')?._model);
    assert.equal(network.filter((item) => item.kind === 'request'
      && [TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID].some((assetId) => item.path === `/api/models/${assetId}`)).length,
    furnitureRequestsBeforeLegacy, 'legacy catalog rooms do not fetch unsupported furniture assignments');
    const legacySrc = await page.locator('floor-viewer').getAttribute('src');
    assert.equal(legacySrc, '/assets/floors/makerspace-floor.glb', 'a unique legacy floor keeps its existing catalog model fallback');

    await pushSnapshot(web.base, makeSnapshot('edge-a', 'site-a', 'Building A', 'Site A study room', { model: null, rectFree: 0 }));
    await page.goto(`${web.base}/dashboard/spaces/site-a/shared-room`);
    await page.getByTestId(mapId).waitFor();
    assert.equal(await page.getByTestId('student-model-viewer-canvas').count(), 0, 'explicit model:null removes the uploaded GLB panel');
    assert.equal(await page.getByTestId('student-map-table-site-a-shared-room-rect-table').count(), 1, 'the geometric map remains usable');
    await assertSingleRenderer(page, '2d');
    assert.equal(await page.getByRole('radio', { name: '3D view' }).isDisabled(), true);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d',
      'explicit 2D-only fallback retains the saved 3D preference for a later supported floor');
    await screenshot(page, 'student-explicit-2d-location');

    furnitureRetryEvidence = await assertGeneratedFurnitureRetry(browser, web);
    const storageFailureEvidence = await assertStorageUnavailable(browser, web);
    await assertEmptyAndRetry(browser, emptyWeb);
    assert.deepEqual(errors, [], `browser console/page errors: ${errors.join('; ')}`);
    await storeArtifacts({ errors, network, moduleRetry: moduleRetryEvidence, furnitureRetry: furnitureRetryEvidence, storageFailure: storageFailureEvidence });
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
  await page.addInitScript((key) => localStorage.setItem(key, '3d'), ROOM_VIEW_MODE_KEY);
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
    const unavailable = page.getByTestId('student-3d-fallback');
    await unavailable.waitFor();
    assert.match(await unavailable.innerText(), /3D view unavailable\. The floor map is shown instead\./);
    await assertSingleRenderer(page, '2d');
    assert.equal(await page.getByTestId('student-map-table-generated-site-iw-maker-a-rect-table').isVisible(), true,
      'the floor map is the active usable renderer while the 3D module is unavailable');
    assert.equal(await page.getByTestId('student-table-list-rect-table').count(), 1,
      'the live availability list remains visible during fallback');
    assert.equal(injectedFailures, 1, 'the harness injects exactly one failed module response');
    assert.equal(moduleRequests.length, 1, 'the initial renderer construction makes one OrbitControls module request');
    assert.equal(moduleResponses.length, 1);
    assert.equal(moduleResponses[0].status, 503);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d',
      'a transient renderer failure does not overwrite the saved preference');
    await screenshot(page, 'student-module-retry-unavailable');

    await page.getByTestId('student-table-list-rect-table').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('student-view-retry-3d').click();
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._three && viewer?._generatedShell && viewer?._generatedTableRecords?.size === 3);
    });
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.getByTestId('student-3d-fallback').count(), 0);
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true',
      'retry recovery preserves the selected table');
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

async function assertGeneratedFurnitureRetry(browser, web) {
  const bytes = makeTriangleGlb();
  for (const assetId of [TABLE_ASSET_ID, CHAIR_ASSET_ID, TABLE_OVERRIDE_ASSET_ID]) {
    await uploadModel(web.base, bytes, 'generated-site', 'edge-generated', assetId);
  }
  await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
    ...STUDENT_FURNITURE, floorId: 'iw-maker-a', proceduralRoom: true,
  }));
  const cookie = await signup(web.base, 'student-furniture-retry@connect.hku.hk');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'tm_session', value: cookie, url: web.base }]);
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  await page.addInitScript((key) => localStorage.setItem(key, '3d'), ROOM_VIEW_MODE_KEY);
  const modelRequests = [];
  const errors = [];
  let injectedFurnitureFailure = 0;
  let releaseFurnitureFailure;
  let markFurnitureRequestStarted;
  const furnitureFailureGate = new Promise((resolve) => { releaseFurnitureFailure = resolve; });
  const furnitureRequestStarted = new Promise((resolve) => { markFurnitureRequestStarted = resolve; });
  let releaseStaleResponse;
  let markStaleRequestStarted;
  const staleResponseGate = new Promise((resolve) => { releaseStaleResponse = resolve; });
  const staleRequestStarted = new Promise((resolve) => { markStaleRequestStarted = resolve; });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/models/')) modelRequests.push(url.pathname);
  });
  await page.route(`**/api/models/${CHAIR_ASSET_ID}`, async (route) => {
    if (injectedFurnitureFailure === 0) {
      injectedFurnitureFailure += 1;
      markFurnitureRequestStarted();
      await furnitureFailureGate;
      await route.fulfill({ status: 503, contentType: 'application/octet-stream', body: 'temporary model failure' });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/models/${STALE_ASSET_ID}`, async (route) => {
    markStaleRequestStarted();
    await staleResponseGate;
    await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: bytes }).catch(() => {});
  });
  try {
    await page.goto(`${web.base}/dashboard/spaces/generated-site/iw-maker-a`);
    await furnitureRequestStarted;
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._three && viewer?._generatedShell
        && viewer?._furnitureLoads?.get('4a0c1020-54cb-4a39-8d73-9f27fd1b7a03')?.status === 'loading');
    });
    await assertSingleRenderer(page, '3d');
    await page.getByTestId('student-table-list-rect-table').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('student-directions-toggle').click();
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions');
    releaseFurnitureFailure();
    await page.getByTestId('student-3d-fallback').waitFor();
    await assertSingleRenderer(page, '2d');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d',
      'a failed furniture asset does not replace the saved view preference');
    assert.equal(await page.getByTestId('student-table-list-rect-table').count(), 1,
      'the stable table list remains available while the 3D scene falls back');
    assert.equal(injectedFurnitureFailure, 1, 'the harness fails only the first chair asset request');
    const initialFailureState = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return {
        failed: viewer?._furnitureHadFailure,
        failedAssets: [...(viewer?._furnitureLoads || [])]
          .filter(([, entry]) => entry.status === 'error').map(([assetId]) => assetId),
      };
    });
    assert.deepEqual(initialFailureState, { failed: true, failedAssets: [CHAIR_ASSET_ID] },
      'the fallback is caused by the expected unresolved chair asset');
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true',
      'table selection survives automatic fallback');
    assert.equal(await page.evaluate(() => document.querySelector('floor-viewer')?.getAttribute('directions')), '1',
      'the enabled directions state survives automatic fallback');
    await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      window.__studentFurnitureLifecycle = [];
      for (const type of ['viewer-ready', 'model-ready', 'model-error']) {
        viewer.addEventListener(type, () => window.__studentFurnitureLifecycle.push({
          type,
          furnitureFailure: viewer._furnitureHadFailure,
          failedAssets: [...(viewer._furnitureLoads || [])]
            .filter(([, entry]) => entry.status === 'error').map(([assetId]) => assetId),
        }));
      }
    });
    await page.getByTestId('student-table-list-rect-table').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByTestId('student-3d-fallback').count(), 1,
      'table selection cannot clear the 3D fallback while furniture remains failed');
    await page.getByTestId('student-table-list-rect-table').click();
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('student-3d-fallback').count(), 1,
      'reselecting a table cannot clear the 3D fallback while furniture remains failed');
    const updateLifecycle = await page.evaluate(() => window.__studentFurnitureLifecycle);
    assert.equal(updateLifecycle.some((event) => event.type === 'viewer-ready'), false,
      'routine selection updates do not emit a false recovery event');
    await page.getByTestId('student-view-retry-3d').click();
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._three && viewer?._generatedShell && viewer?._furnitureInstances?.size === 9);
    });
    await page.getByTestId('student-3d-fallback').waitFor({ state: 'detached' });
    await assertSingleRenderer(page, '3d');
    assert.equal(await page.getByTestId('student-3d-fallback').count(), 0);
    assert.equal(await page.getByTestId('student-table-list-rect-table').getAttribute('aria-pressed'), 'true',
      'furniture retry retains the selected logical table');
    assert.equal(await page.getByTestId('student-directions-toggle').innerText(), 'Hide directions',
      'furniture retry retains the directions state');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), ROOM_VIEW_MODE_KEY), '3d');
    const recoveredLifecycle = await page.evaluate(() => window.__studentFurnitureLifecycle);
    assert.equal(recoveredLifecycle.filter((event) => event.type === 'viewer-ready').length, 1,
      'an explicit retry emits one recovery event after the failed asset loads');
    assert.deepEqual(recoveredLifecycle.find((event) => event.type === 'viewer-ready'), {
      type: 'viewer-ready', furnitureFailure: false, failedAssets: [],
    });
    assert.equal(modelRequests.filter((path) => path === `/api/models/${TABLE_ASSET_ID}`).length, 1,
      'retry keeps the successful default table asset loaded');
    assert.equal(modelRequests.filter((path) => path === `/api/models/${TABLE_OVERRIDE_ASSET_ID}`).length, 1,
      'retry keeps the successful overridden table asset loaded');
    assert.equal(modelRequests.filter((path) => path === `/api/models/${CHAIR_ASSET_ID}`).length, 2,
      'retry requests only the failed chair asset again');
    assert.equal(modelRequests.includes(`/api/models/${ASSET_ID}`), false,
      'generated furniture does not request a custom whole-room model');
    const furniture = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [...viewer._furnitureInstances.values()].map((object) => ({
        assetId: object.userData.assetId, tableId: object.userData.tableId, slot: object.userData.slot,
        position: [object.position.x, object.position.y, object.position.z],
      }));
    });
    const polygonTable = furniture.find((item) => item.tableId === 'poly-table' && item.slot === 'table');
    const expected = { x: 3.835833333333331, z: -0.5994444444444443 };
    assert.ok(polygonTable.position.every((value, index) => Math.abs(value - [expected.x, 0.2, expected.z][index]) < 1e-8),
      'generated-room furniture uses the exact centroid of a concave projected footprint');
    const proxyAndCueState = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [...viewer._generatedTableRecords].map(([tableId, record]) => ({
        tableId,
        tableProxies: record.tableFallback.children.length,
        chairProxies: record.chairFallback.children.length,
        hasStatusOverlay: Boolean(record.tableStatus?.material && record.tableStatus.parent === record.group),
      }));
    });
    assert.ok(proxyAndCueState.every((record) => record.tableProxies === 0 && record.chairProxies === 0),
      'assigned generated table and chair GLBs replace every corresponding primitive proxy');
    assert.ok(proxyAndCueState.every((record) => record.hasStatusOverlay),
      'status overlays remain mounted separately from generated furniture models');

    await uploadModel(web.base, bytes, 'generated-site', 'edge-generated', STALE_ASSET_ID);
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      version: 3, floorId: 'iw-maker-a', proceduralRoom: true,
      furnitureDefaults: {
        table: { assetId: STALE_ASSET_ID, scale: 0.8, yawDeg: 0, elevationM: 0 },
        chair: STUDENT_FURNITURE.furnitureDefaults.chair,
      },
      furnitureOverrides: STUDENT_FURNITURE.furnitureOverrides,
    }));
    await staleRequestStarted;
    await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
      version: 3, floorId: 'iw-maker-a', proceduralRoom: true,
    }));
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      const layout = JSON.parse(viewer?.getAttribute('location-layout') || 'null');
      return Boolean(layout && layout.tables.every((table) => !table.furniture)
        && !viewer._furnitureLoads?.has('4a0c1020-54cb-4a39-8d73-9f27fd1b7a05')
        && viewer._furnitureInstances?.size === 0);
    });
    releaseStaleResponse();
    await page.waitForTimeout(100);
    const staleAssetAdded = await page.evaluate((assetId) => {
      const viewer = document.querySelector('floor-viewer');
      return [...(viewer?._furnitureInstances?.values() || [])].some((object) => object.userData.assetId === assetId);
    }, STALE_ASSET_ID);
    assert.equal(staleAssetAdded, false, 'a delayed response for a removed assignment cannot re-enter the current scene');
    await screenshot(page, 'student-generated-furniture-retry-recovered');
    assert.deepEqual(errors, [], `furniture fetch failure and retry do not create browser exceptions: ${errors.join('; ')}`);
    return { injectedFurnitureFailure, modelRequests, errors, recoveredInstances: furniture.length };
  } finally {
    releaseFurnitureFailure();
    releaseStaleResponse();
    await context.close();
  }
}

async function assertStorageUnavailable(browser, web) {
  await pushSnapshot(web.base, makeSnapshot('edge-generated', 'generated-site', 'Generated Building', 'Built-in Room', {
    floorId: 'iw-maker-a', proceduralRoom: true,
  }));
  const cookie = await signup(web.base, 'student-view-storage@connect.hku.hk');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'tm_session', value: cookie, url: web.base }]);
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked for this browser context', 'SecurityError'); },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(`${web.base}/dashboard/spaces/generated-site/iw-maker-a`);
    await page.waitForFunction(() => Boolean(document.querySelector('floor-viewer')?._generatedShell));
    await assertSingleRenderer(page, '3d');
    await page.getByRole('radio', { name: '2D map' }).check();
    await assertSingleRenderer(page, '2d');
    await page.getByRole('radio', { name: '3D view' }).check();
    await page.waitForFunction(() => Boolean(document.querySelector('floor-viewer')?._generatedShell));
    await assertSingleRenderer(page, '3d');
    assert.deepEqual(errors, [], `storage access failures are handled without browser errors: ${errors.join('; ')}`);
    await screenshot(page, 'student-storage-unavailable-view-switch');
    return { errors, readAndWriteAccessDenied: true, viewSwitchingRemainedAvailable: true };
  } finally {
    await context.close();
  }
}

async function assertSingleRenderer(page, mode) {
  const is3d = mode === '3d';
  const stage3d = page.getByTestId('student-3d-renderer');
  const stage2d = page.getByTestId('student-2d-renderer');
  assert.equal(await stage3d.isVisible(), is3d, `3D renderer visibility matches ${mode} mode`);
  assert.equal(await stage2d.isVisible(), !is3d, `2D renderer visibility matches ${mode} mode`);
  assert.equal(await page.getByRole('region', { name: is3d ? '3D room view' : '2D floor map' }).count(), 1,
    'the active viewport has one accessible region name');
  assert.equal(await page.getByRole('radio', { name: is3d ? '3D view' : '2D map' }).isChecked(), true,
    'the radio selection matches the active renderer');
  if (!is3d && await stage3d.count()) {
    assert.equal(await stage3d.getAttribute('aria-hidden'), 'true');
    assert.equal(await stage3d.getAttribute('inert'), '');
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

async function uploadModel(base, bytes, locationId, edgeId, assetId = ASSET_ID) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const response = await fetch(`${base}/api/edge/location-assets/${locationId}/${assetId}`, {
    method: 'PUT', headers: {
      authorization: `Bearer ${PUSH_TOKEN}`, 'x-tm-edge-id': edgeId,
      'x-tm-sha256': sha256, 'content-type': 'model/gltf-binary',
    }, body: bytes,
  });
  assert.ok([200, 201].includes(response.status), `public test asset upload succeeds (status ${response.status})`);
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
    table('poly-table', 'Polygon table', 'zone-east', { type: 'polygon', points: options.concavePolygon
      ? [[340, 30], [460, 30], [460, 50], [400, 50], [400, 100], [340, 100]]
      : generated
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
  if (options.furnitureDefaults !== undefined) floor.furnitureDefaults = options.furnitureDefaults;
  if (options.furnitureOverrides) {
    for (const [tableId, furnitureOverrides] of Object.entries(options.furnitureOverrides)) {
      const target = tables.find((item) => item.id === tableId);
      if (target) target.furnitureOverrides = furnitureOverrides;
    }
  }
  if (generated) floor.proceduralRoom = 'simple-rectangle-v1';
  else if (!options.omitModel) floor.model = options.model ?? null;
  return { version: options.version ?? 2, edgeId, site: { id: siteId, name: siteId }, generatedAt: Date.now(), floors: [floor] };
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
