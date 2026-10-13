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
const ARTIFACT_DIR = process.env.TASK_4_1_ARTIFACTS;

test('signed student browser renders composite locations, aligned models, live status and recovery', { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'tmedge-student-locations-'));
  const web = await startWeb(join(temporary, 'main'));
  const emptyWeb = await startWeb(join(temporary, 'empty'));
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  const network = [];
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
      const plate = viewer._marks.children.find((child) => child.userData.tableId === 'rect-table');
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
    assert.deepEqual(modelState.overlay, [0.9, 0.025, -0.7], 'the table overlay stays in authored floor coordinates while the GLB root is transformed');

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
    await storeArtifacts({ errors, network });
  } finally {
    if (traceStarted && tracePath) await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopWeb(emptyWeb);
    await stopWeb(web);
    rmSync(temporary, { recursive: true, force: true });
  }
});

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
  const rectSeats = seatPair('rect-table', rectFree);
  const roundSeats = seatPair('round-table', 0);
  const polygonSeats = seatPair('poly-table', null);
  const tables = [
    table('rect-table', 'Rectangle table', 'zone-west', { type: 'rect', x: 40, y: 40, width: 100, height: 60 }, rectSeats, rectFree),
    table('round-table', 'Round table', 'zone-west', { type: 'circle', cx: 220, cy: 100, radius: 35 }, roundSeats, 0),
    table('poly-table', 'Polygon table', 'zone-east', { type: 'polygon', points: [[340, 30], [460, 30], [450, 100], [340, 90]] }, polygonSeats, null),
  ];
  const floor = {
    id: floorId, building, name, width: 600, height: 400,
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    zones: [
      { id: 'zone-west', name: 'West study zone', polygon: [[0, 0], [300, 0], [300, 400], [0, 400]], people: 3 },
      { id: 'zone-east', name: 'East study zone', polygon: [[300, 0], [600, 0], [600, 400], [300, 400]], people: 1 },
    ],
    tables,
    totals: {
      seats: 6, free: rectFree ?? 0, occupied: (rectFree === null ? 0 : 2 - rectFree) + 2,
      unknownSeats: 2, tablesFullyFree: rectFree === 2 ? 1 : 0,
    },
  };
  if (!options.omitModel) floor.model = options.model ?? null;
  return { version: 2, edgeId, site: { id: siteId, name: siteId }, generatedAt: Date.now(), floors: [floor] };
}

function table(id, name, zoneId, shape, seats, free) {
  const rect = shape.type === 'circle'
    ? { x: shape.cx - shape.radius, y: shape.cy - shape.radius, width: shape.radius * 2, height: shape.radius * 2 }
    : shape.type === 'polygon'
      ? { x: 340, y: 30, width: 120, height: 70 }
      : { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  const unknown = free === null;
  return {
    id, name, zoneId, rect, shape, capacity: 2,
    occupied: unknown ? null : 2 - free, free,
    status: unknown ? 'unknown' : 'ok', seats,
  };
}

function seatPair(tableId, free) {
  const status = free === null ? [null, null] : [0, 1].map((index) => index >= free);
  return [0, 1].map((index) => ({
    id: `${tableId}-seat-${index + 1}`, x: 60 + index * 35, y: 70,
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
