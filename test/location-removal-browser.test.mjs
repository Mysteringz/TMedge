// Real console publication flow against disposable file storage, without .env or production services.
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

test('published location removal confirms, releases sensors and blocks retained draft publication', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'location-removal-browser-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const sitePath = join(dir, 'site.json'), nodesPath = join(dir, 'nodes.json');
  writeFileSync(sitePath, JSON.stringify(siteJson()));
  writeFileSync(nodesPath, JSON.stringify({ nodes: [{ uid: 'aa:bb:cc:dd:ee:21', label: 'Reusable sensor', simulated: false, rgb: false, detector: 'node' }] }));
  let persistence, runtime, handle, browser;
  try {
    persistence = initializeFileLocationPersistence(sitePath, nodesPath, dir);
    runtime = createEdgeRuntime({ edgeId: 'draft-browser', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath, nodesPath, dataDir: dir,
      recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'local-test', flashToken: null, pushUrls: [], pushToken: '',
      publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null }, persistence.registry);
    const users = new AlgoUsers(join(dir, 'users.json'));
    const password = randomBytes(24).toString('hex');
    await users.add('manager', password, 'admin');
    await users.add('viewer', password, 'viewer');
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
    const created = await request('POST', '/locations/drafts', { name: 'Remove this room', building: 'Test building', widthCm: 1200, heightCm: 800 }, 201);
    const saved = await request('PUT', `/locations/drafts/${created.draftId}`, { expectedDraftRevision: 1, document: { ...created.document,
      zones: [{ id: 'removal-zone', name: 'Room', polygon: [[0, 0], [1200, 0], [1200, 800], [0, 800]] }],
      sensorAssignments: [{ uid: 'aa:bb:cc:dd:ee:21', pose: { x: 200, y: 200, heightCm: 350, yawDeg: 0, mirror: false }, owns: [] }],
    } });
    await request('POST', `/locations/drafts/${created.draftId}/publications`, { expectedDraftRevision: saved.draftRevision, expectedPublishedRevision: null });
    const retained = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 1 }, 201);
    const viewer = await browser.newContext();
    await viewer.request.post(`${base}/auth/login`, { data: { username: 'viewer', password } });
    assert.equal((await viewer.request.delete(`${base}/api/locations/${created.locationId}`, { headers: { origin: base, 'x-tm-algo': '1' }, data: { expectedPublishedRevision: 1 } })).status(), 403);
    await viewer.close();
    assert.equal((await context.request.delete(`${base}/api/locations/${created.locationId}`, { data: { expectedPublishedRevision: 1 } })).status(), 403, 'write guard is required');
    await request('DELETE', `/locations/${created.locationId}`, { expectedPublishedRevision: -1 }, 422);
    await request('DELETE', `/locations/${created.locationId}`, { expectedPublishedRevision: 1, creatorId: 'forged' }, 422);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let deleteRequests = 0;
    page.on('request', req => { if (req.method() === 'DELETE') deleteRequests++; });
    await page.goto(`${base}/locations`);
    const remove = page.getByRole('button', { name: 'Remove location Remove this room', exact: true });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'Remove location?', exact: true });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Remove this room/);
    assert.match(await dialog.innerText(), /sensors will be unassigned/);
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(button => button === document.activeElement), true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await remove.evaluate(button => button === document.activeElement), true);
    await remove.click(); await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(deleteRequests, 0, 'opening, Cancel and Escape never remove a location');
    await remove.click();
    // Another publication after confirmation was opened invalidates the observed revision.
    await request('POST', `/locations/drafts/${retained.draftId}/publications`, { expectedDraftRevision: 1, expectedPublishedRevision: 1 });
    await dialog.getByRole('button', { name: 'Remove location', exact: true }).click();
    await dialog.getByText('The location changed or was removed. Reload the list and review it before removing it.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Remove location', exact: true }).isDisabled(), true);
    assert.ok(runtime.reg.floors.some(floor => floor.id === created.locationId));
    const survivingDraft = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 2 }, 201);
    await dialog.getByRole('button', { name: 'Reload list', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await remove.click();
    if (process.env.LOCATION_REMOVAL_SCREENSHOTS) {
      mkdirSync(process.env.LOCATION_REMOVAL_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.LOCATION_REMOVAL_SCREENSHOTS, 'confirm-location-removal.png') });
    }
    await dialog.getByRole('button', { name: 'Remove location', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Location removed. Its sensors are available for other locations.', { exact: true }).waitFor();
    assert.equal(await remove.count(), 0);
    assert.equal(await page.locator('#loc-published-title').evaluate(heading => heading === document.activeElement), true);
    assert.equal((await request('GET', '/locations')).published.some(row => row.locationId === created.locationId), false);
    assert.equal((await request('GET', '/locations')).drafts.some(row => row.draftId === survivingDraft.draftId), true);
    assert.ok(!runtime.reg.floors.some(floor => floor.id === created.locationId));
    assert.ok(!runtime.publicSnapshot(runtime.latest).floors.some(floor => floor.id === created.locationId), 'student snapshot excludes removed location');
    const sensor = runtime.reg.nodes.get('aa:bb:cc:dd:ee:21');
    assert.equal(sensor.floorId, null); assert.equal(sensor.pose, null); assert.deepEqual(sensor.owns, []);
    assert.equal((await persistence.published.listHistory(created.locationId)).length, 2);
    await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 2 }, 409);
    await request('POST', `/locations/drafts/${survivingDraft.draftId}/publications`, { expectedDraftRevision: 1, expectedPublishedRevision: 2 }, 409);
    await page.goto(`${base}/locations/${survivingDraft.draftId}/review`);
    await page.getByText('This location has been removed. This private draft is retained for reference and cannot be published.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Publish location', exact: true }).isDisabled(), true);
    for (const location of (await request('GET', '/locations')).published) {
      await request('DELETE', `/locations/${location.locationId}`, { expectedPublishedRevision: location.activeRevision });
    }
    assert.equal(runtime.reg.floors.length, 0, 'removing the last location activates an empty runtime');
    assert.deepEqual(runtime.publicSnapshot(runtime.latest).floors, [], 'student snapshot contains no removed seed floors');
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
