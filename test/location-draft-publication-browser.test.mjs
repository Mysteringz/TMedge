// Real console publication flow against disposable file storage, without .env or production services.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

test('console publishes an older draft as the next revision and removes only that completed draft', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-publication-browser-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const sitePath = join(dir, 'site.json'), nodesPath = join(dir, 'nodes.json');
  writeFileSync(sitePath, JSON.stringify(siteJson()));
  writeFileSync(nodesPath, JSON.stringify({ nodes: [] }));
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
    const created = await request('POST', '/locations/drafts', { name: 'Original layout', building: 'Test building', widthCm: 1200, heightCm: 800 }, 201);
    const saved = await request('PUT', `/locations/drafts/${created.draftId}`, { expectedDraftRevision: 1, document: { ...created.document, zones: [{ id: 'draft-browser-zone', name: 'Room', polygon: [[0, 0], [1200, 0], [1200, 800], [0, 800]] }] } });
    await request('POST', `/locations/drafts/${created.draftId}/publications`, { expectedDraftRevision: saved.draftRevision, expectedPublishedRevision: null });
    const older = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 1 }, 201);
    const sibling = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 1 }, 201);
    const newer = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 1 }, 201);
    const edited = await request('PUT', `/locations/drafts/${newer.draftId}`, { expectedDraftRevision: 1, document: { ...newer.document, name: 'Newer layout' } });
    await request('POST', `/locations/drafts/${newer.draftId}/publications`, { expectedDraftRevision: edited.draftRevision, expectedPublishedRevision: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/locations/${older.draftId}/review`);
    await page.getByTestId('location-review-replacement').waitFor();
    assert.match(await page.getByTestId('location-review-replacement').innerText(), /replaces current revision 2.*revision 3/);
    await page.getByRole('button', { name: 'Publish location', exact: true }).click();
    await page.waitForURL(`${base}/locations`);
    await page.getByTestId('location-published-list').waitFor();
    assert.equal(await page.getByTestId(`location-continue-${older.draftId}`).count(), 0);
    assert.equal(await page.getByTestId(`location-continue-${newer.draftId}`).count(), 0);
    assert.equal(await page.getByTestId(`location-continue-${sibling.draftId}`).count(), 1);
    const active = (await request('GET', '/locations')).published.find(location => location.locationId === created.locationId);
    assert.equal(active.activeRevision, 3);
    assert.equal(active.name, 'Original layout');

    // A real concurrent publication after Review was loaded must still fail, preserving the other draft.
    await page.goto(`${base}/locations/${sibling.draftId}/review`);
    await page.getByTestId('location-review-replacement').waitFor();
    const concurrent = await request('POST', `/locations/${created.locationId}/drafts`, { expectedPublishedRevision: 3 }, 201);
    await request('POST', `/locations/drafts/${concurrent.draftId}/publications`, { expectedDraftRevision: 1, expectedPublishedRevision: 3 });
    await page.getByRole('button', { name: 'Publish location', exact: true }).click();
    await page.getByText('The active location changed. Reload latest before trying to publish.', { exact: true }).waitFor();
    assert.equal((await request('GET', '/locations')).drafts.some(draft => draft.draftId === sibling.draftId), true);
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
