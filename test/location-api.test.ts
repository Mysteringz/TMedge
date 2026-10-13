import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import test from 'node:test';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { FileLocationAssetStore } from '../src/infrastructure/location-config/file-location-asset-store.js';
import { computeLocationCoverageSuggestions } from '../src/infrastructure/location-config/location-coverage.js';
import type { LocationDraft, PublishedLocationState } from '../src/modules/location-config/domain/location-records.js';
import { LocationConflictError } from '../src/modules/location-config/domain/location-records.js';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import type {
  LocationDraftRepository, LocationRegistrySnapshot, LocationRegistrySnapshotRepository,
  PreparedLocationRuntime, PublishedLocationRepository, RegistryMutationCoordinator,
} from '../src/modules/location-config/repositories/location-storage.js';
import { createLocationRouter } from '../src/modules/location-config/routes/location-router.js';
import type { ValidatedLocationCandidate } from '../src/modules/location-config/domain/location-candidate.js';
import { parseTrustedLegacyBaseline } from '../src/infrastructure/location-config/legacy-location-mapper.js';
import { siteJson } from './fixtures.js';

const GLB = makeGlb({ asset: { version: '2.0' }, buffers: [] });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('location routes enforce capability, write guard, ownership and immutable upload preview boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'location-api-'));
  const app = express();
  const persistence = makePersistence(directory);
  const users = new AlgoUsers(join(directory, 'algo-users.json'));
  for (const [name, role] of [
    ['admin', 'admin'], ['operator', 'operator'], ['operator-two', 'operator'],
    ['engineer', 'engineer'], ['viewer', 'viewer'],
  ] as const) await users.add(name, 'correct horse battery', role);
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 's'.repeat(40), ALGO_USERS_FILE: users.path }, 'test-admin-password'));
  app.use('/api', createLocationRouter({
    auth,
    edgeId: 'edge-api-test', siteSeed: siteJson(),
    ...persistence,
    assets: persistence.assets,
    assetMetadata: persistence.assets,
    runtime: fakeRuntime as unknown as import('../src/modules/location-config/routes/location-router.js').LocationRouterDependencies['runtime'],
    suggestCoverage: computeLocationCoverageSuggestions,
    now: () => 100,
  }));
  app.use(auth.router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = async (username: string) => {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct horse battery' }),
      });
      assert.equal(response.status, 200);
      return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    const [adminCookie, operatorCookie, secondOperatorCookie, engineerCookie, viewerCookie] = await Promise.all([
      login('admin'), login('operator'), login('operator-two'), login('engineer'), login('viewer'),
    ]);
    const json = (method: string, path: string, body?: unknown, cookie = operatorCookie, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1', origin: base, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await fetch(`${base}/api/locations`)).status, 401);
    assert.equal((await json('GET', '/api/locations', undefined, engineerCookie)).status, 403);
    assert.equal((await json('GET', '/api/locations', undefined, viewerCookie)).status, 403);
    assert.equal((await json('GET', '/api/locations', undefined, adminCookie)).status, 200);
    assert.equal((await json('POST', '/api/locations/drafts', { name: 'Room', building: 'North', widthCm: 400, heightCm: 300 }, operatorCookie, { 'x-tm-algo': '' })).status, 403);
    assert.equal((await json('POST', '/api/locations/drafts', { name: 'Room', building: 'North', widthCm: 400, heightCm: 300 }, operatorCookie, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await fetch(`${base}/api/locations/drafts`, {
      method: 'POST', headers: { cookie: operatorCookie, 'content-type': 'application/json', 'x-tm-algo': '1' },
      body: JSON.stringify({ name: 'Room', building: 'North', widthCm: 400, heightCm: 300 }),
    })).status, 403, 'mutations require an Origin header even with the write guard');
    assert.equal((await json('POST', '/api/locations/drafts', {
      name: 'Room', building: 'North', widthCm: 400, heightCm: 300, visibility: 'console',
    })).status, 422);

    const created = await json('POST', '/api/locations/drafts', { name: 'Room', building: 'North', widthCm: 400, heightCm: 300 });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { draftId: string; locationId: string; basePublishedRevision: number | null; visibility: string; document: Record<string, unknown> } };
    const draftId = createdBody.data.draftId;
    assert.match(createdBody.data.locationId, /^location_edge-api-test_[0-9a-f-]{36}$/);
    assert.equal(createdBody.data.basePublishedRevision, null);
    assert.equal(createdBody.data.visibility, 'public', 'visibility remains safe read-only draft metadata');
    assert.equal(Object.hasOwn(createdBody.data.document, 'visibility'), false, 'authored requests and document DTOs omit server-managed visibility');
    assert.equal((await fetch(`${base}/api/locations/drafts/${draftId}`, { headers: { cookie: secondOperatorCookie } })).status, 404);
    const secondList = await json('GET', '/api/locations', undefined, secondOperatorCookie);
    assert.equal(((await secondList.json()) as { data: { drafts: unknown[] } }).data.drafts.length, 0,
      'another manager cannot list this private draft');

    const freeUid = 'aa:bb:cc:dd:ee:21';
    const sameLocationUid = 'aa:bb:cc:dd:ee:22';
    const otherLocationUid = 'aa:bb:cc:dd:ee:23';
    const rgbUid = 'aa:bb:cc:dd:ee:24';
    const otherFloorId = (siteJson() as { floors: Array<{ id: string }> }).floors[0]!.id;
    const consoleFloorId = (siteJson() as { floors: Array<{ id: string; visibility?: string }> }).floors.find((floor) => floor.visibility === 'console')!.id;
    const pose = { x: 200, y: 180, heightCm: 350, yawDeg: 0, mirror: false };
    persistence.setSnapshotNodes([
      { uid: freeUid, label: 'Free sensor', floorId: null, pose: null, owns: [], simulated: false, rgb: false, detector: 'node' },
      { uid: sameLocationUid, label: 'Already here', floorId: createdBody.data.locationId, pose, owns: [], simulated: false, rgb: false, detector: 'node' },
      { uid: otherLocationUid, label: 'Other location', floorId: otherFloorId, pose, owns: [], simulated: false, rgb: false, detector: 'node' },
      { uid: rgbUid, label: 'RGB sensor', floorId: consoleFloorId, pose, owns: [], simulated: false, rgb: true, detector: 'node' },
    ]);
    const eligibleSensors = await json('GET', `/api/locations/drafts/${draftId}/sensors`);
    const eligibleUids = ((await eligibleSensors.json()) as { data: { sensors: Array<{ uid: string }> } }).data.sensors.map((sensor) => sensor.uid);
    assert.deepEqual(eligibleUids, [freeUid, sameLocationUid], 'only unplaced or same-location non-RGB sensors are returned');

    const coverageDocument = {
      name: 'Room', building: 'North', widthCm: 400, heightCm: 300,
      outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [{ id: 'API-ZONE', name: 'Room area', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
      tables: [{ id: 'WIZARD-API-TABLE', name: 'Table', zoneId: 'API-ZONE', capacity: 1,
        shape: { type: 'rect', x: 160, y: 120, width: 80, height: 60 },
        seats: [{ id: 'WIZARD-API-SEAT', x: 200, y: 180, neighbors: [] }] }],
      sensorAssignments: [],
    };
    const suggestions = await json('POST', `/api/locations/drafts/${draftId}/coverage-suggestions`, {
      document: coverageDocument, proposedSensors: [{ uid: freeUid, pose }],
    });
    assert.equal(suggestions.status, 200, await suggestions.clone().text());
    assert.deepEqual(((await suggestions.json()) as { data: { suggestions: Array<{
      tableId: string; coveredBy: string[]; suggestedOwner: string | null;
      seatCoverage: { totalSeats: number; coveredSeats: number; bySensor: Array<{ uid: string; coveredSeats: number }> };
    }> } }).data.suggestions,
      [{ tableId: 'WIZARD-API-TABLE', coveredBy: [freeUid], suggestedOwner: freeUid,
        seatCoverage: { totalSeats: 1, coveredSeats: 1, bySensor: [{ uid: freeUid, coveredSeats: 1 }] } }]);
    for (const uid of [otherLocationUid, rgbUid]) {
      const ineligible = await json('POST', `/api/locations/drafts/${draftId}/coverage-suggestions`, {
        document: coverageDocument, proposedSensors: [{ uid, pose }],
      });
      assert.equal(ineligible.status, 422, `sensor ${uid} is not eligible for a public location`);
    }

    const forged = await json('PUT', `/api/locations/drafts/${draftId}`, { expectedDraftRevision: 1, document: { creatorId: 'other' } });
    assert.equal(forged.status, 422);
    const forgedBaseCapability = await json('PUT', `/api/locations/drafts/${draftId}`, {
      expectedDraftRevision: 1,
      document: {
        name: 'Room', building: 'North', widthCm: 400, heightCm: 300,
        outline: [[0, 0], [400, 0], [400, 300], [0, 300]], zones: [], tables: [], sensorAssignments: [],
        fromPublishedBase: true,
      },
    });
    assert.equal(forgedBaseCapability.status, 422, 'the safe inherited-source projection cannot be supplied in a draft request');

    const rejectedMedia = await fetch(`${base}/api/locations/drafts/${draftId}/assets/floor-plan`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'application/octet-stream', 'if-match': '1' }, body: PNG,
    });
    assert.equal(rejectedMedia.status, 415);

    const planUpload = await fetch(`${base}/api/locations/drafts/${draftId}/assets/floor-plan`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'image/png', 'if-match': '1' }, body: PNG,
    });
    assert.equal(planUpload.status, 200);
    const planBody = await planUpload.json() as { data: { assetId: string; draftRevision: number } };
    assert.equal(planBody.data.draftRevision, 2);
    const planPreview = await fetch(`${base}/api/locations/drafts/${draftId}/assets/${planBody.data.assetId}`, { headers: { cookie: operatorCookie } });
    assert.equal(planPreview.status, 200);
    assert.equal(planPreview.headers.get('cache-control'), 'private, no-store');
    assert.equal(planPreview.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await planPreview.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/api/locations/drafts/${draftId}/assets/${planBody.data.assetId}`, { headers: { cookie: secondOperatorCookie } })).status, 404);

    const malformedDisplayName = await fetch(`${base}/api/locations/drafts/${draftId}/assets/model`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'model/gltf-binary', 'if-match': '2', 'x-asset-display-name': '%E0%A4%A' }, body: GLB,
    });
    assert.equal(malformedDisplayName.status, 422, 'malformed display-name percent escapes are rejected before writing');
    const planDisplayName = await fetch(`${base}/api/locations/drafts/${draftId}/assets/floor-plan`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'image/png', 'if-match': '2', 'x-asset-display-name': 'plan.png' }, body: PNG,
    });
    assert.equal(planDisplayName.status, 422, 'display names are model metadata only');

    const modelUpload = await fetch(`${base}/api/locations/drafts/${draftId}/assets/model`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'model/gltf-binary', 'if-match': '2', 'x-asset-display-name': 'private%5Cmodel%20one.glb' }, body: GLB,
    });
    assert.equal(modelUpload.status, 200);
    const modelBody = await modelUpload.json() as { data: { assetId: string; draftRevision: number; displayName?: string } };
    assert.equal(modelBody.data.draftRevision, 3);
    assert.equal(modelBody.data.displayName, 'model one.glb', 'upload returns only a normalized basename');
    const detail = await json('GET', `/api/locations/drafts/${draftId}`);
    const detailBody = await detail.json() as { data: { assetCapabilities: Record<string, { previewAvailable: boolean; alignmentEditable: boolean; fromPublishedBase: boolean; displayName?: string }>; assetProvenance?: unknown } };
    assert.equal(detailBody.data.assetCapabilities.planAssetId?.previewAvailable, true);
    assert.equal(detailBody.data.assetCapabilities.modelAssetId?.alignmentEditable, true);
    assert.equal(detailBody.data.assetCapabilities.modelAssetId?.fromPublishedBase, false, 'new draft uploads are not mislabeled as inherited');
    assert.equal(detailBody.data.assetCapabilities.modelAssetId?.displayName, 'model one.glb', 'safe model detail returns only the stored display label');
    assert.equal(Object.hasOwn(detailBody.data, 'assetProvenance'), false);
    const modelPreview = await fetch(`${base}/api/locations/drafts/${draftId}/assets/${modelBody.data.assetId}`, { headers: { cookie: operatorCookie } });
    assert.equal(modelPreview.status, 200);
    assert.deepEqual(Buffer.from(await modelPreview.arrayBuffer()), GLB);

    const baseModel = await persistence.assets.put('original-model-owner', 'model', 'model/gltf-binary', GLB, 120, 'venue/published-base.glb');
    const baseDocument = parseLocationDocument({
      schemaVersion: 1, locationId: 'published-model-floor', name: 'Published model', building: 'North', visibility: 'public',
      widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [], tables: [], sensorAssignments: [], modelAssetId: baseModel.assetId,
      modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
    });
    persistence.setPublishedLocation({
      locationId: baseDocument.locationId, activeRevision: 4,
      history: [{ locationId: baseDocument.locationId, revision: 4, createdBy: 'seed', createdAt: 120,
        document: baseDocument, assetProvenance: { modelAssetId: { kind: 'upload', ownerId: 'original-model-owner' } } }],
    });
    const inheritedStart = await json('POST', `/api/locations/${baseDocument.locationId}/drafts`, { expectedPublishedRevision: 4 });
    assert.equal(inheritedStart.status, 201, await inheritedStart.clone().text());
    const inherited = (await inheritedStart.json() as { data: { draftId: string; draftRevision: number } }).data;
    const inheritedDetail = await json('GET', `/api/locations/drafts/${inherited.draftId}`);
    const inheritedDto = (await inheritedDetail.json() as { data: { document: { modelAssetId?: string }; assetCapabilities: Record<string, { fromPublishedBase: boolean; displayName?: string }> } }).data;
    assert.equal(inheritedDto.document.modelAssetId, baseModel.assetId);
    assert.equal(inheritedDto.assetCapabilities.modelAssetId?.fromPublishedBase, true, 'same pinned-base model is safely labeled after reload');
    assert.equal(inheritedDto.assetCapabilities.modelAssetId?.displayName, 'published-base.glb', 'cross-manager inheritance resolves only the sanitized filename through trusted provenance');
    const inheritedPreview = await fetch(`${base}/api/locations/drafts/${inherited.draftId}/assets/${baseModel.assetId}`, { headers: { cookie: operatorCookie } });
    assert.equal(inheritedPreview.status, 200, 'the exact published-base reference can be previewed through the new manager-owned draft');
    assert.deepEqual(Buffer.from(await inheritedPreview.arrayBuffer()), GLB, 'inherited bytes remain under their original immutable owner');
    assert.equal(JSON.stringify(inheritedDto).includes('original-model-owner'), false, 'the safe capability DTO does not disclose the original asset owner');
    assert.equal(JSON.stringify(inheritedDto).includes('assetProvenance'), false);
    const inheritedSave = await json('PUT', `/api/locations/drafts/${inherited.draftId}`, {
      expectedDraftRevision: 1,
      document: {
        name: baseDocument.name, building: baseDocument.building, widthCm: baseDocument.widthCm, heightCm: baseDocument.heightCm,
        outline: baseDocument.outline, zones: baseDocument.zones, tables: baseDocument.tables,
        sensorAssignments: baseDocument.sensorAssignments, modelAssetId: baseDocument.modelAssetId, modelTransform: baseDocument.modelTransform,
      },
    });
    assert.equal(inheritedSave.status, 200, 'ordinary authored save remains accepted and returns its committed write result');
    assert.equal(Object.hasOwn((await inheritedSave.json() as { data: Record<string, unknown> }).data, 'assetCapabilities'), false,
      'write result does not invent a post-commit capability projection');
    const inheritedAfterSave = await json('GET', `/api/locations/drafts/${inherited.draftId}`);
    const savedInheritedDto = (await inheritedAfterSave.json() as { data: { assetCapabilities: Record<string, { fromPublishedBase: boolean; displayName?: string }> } }).data;
    assert.equal(savedInheritedDto.assetCapabilities.modelAssetId?.fromPublishedBase, true, 'confirmed editor saves recover the capability from authoritative detail');
    assert.equal(savedInheritedDto.assetCapabilities.modelAssetId?.displayName, 'published-base.glb');
    const replacement = await fetch(`${base}/api/locations/drafts/${inherited.draftId}/assets/model`, {
      method: 'PUT', headers: { cookie: operatorCookie, 'x-tm-algo': '1', origin: base, 'content-type': 'model/gltf-binary', 'if-match': '2', 'x-asset-display-name': 'replacement.glb' }, body: GLB,
    });
    assert.equal(replacement.status, 200, await replacement.clone().text());
    const replacedDetail = await json('GET', `/api/locations/drafts/${inherited.draftId}`);
    const replacedDto = (await replacedDetail.json() as { data: { document: { modelAssetId?: string }; assetCapabilities: Record<string, { fromPublishedBase: boolean; displayName?: string }> } }).data;
    assert.notEqual(replacedDto.document.modelAssetId, baseModel.assetId);
    assert.equal(replacedDto.assetCapabilities.modelAssetId?.fromPublishedBase, false, 'replacement upload is distinguishable after reload');
    assert.equal(replacedDto.assetCapabilities.modelAssetId?.displayName, 'replacement.glb', 'replacement display metadata follows the exact new asset reference');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy editor DTO round-trips exact inherited geometry through unchanged save and plan upload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'location-legacy-api-'));
  const app = express();
  const persistence = makePersistence(directory);
  const users = new AlgoUsers(join(directory, 'algo-users.json'));
  await users.add('legacy-operator', 'correct horse battery', 'operator');
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 'l'.repeat(40), ALGO_USERS_FILE: users.path }, 'test-admin-password'));
  const legacyDocument = parseTrustedLegacyBaseline({
    schemaVersion: 1, locationId: 'legacy-room', name: 'Legacy room', building: 'Old building', visibility: 'console',
    widthCm: 400, heightCm: 300,
    outline: [[-10, -10], [410, -10], [400, 300]],
    zones: [{ id: 'legacy-zone', name: 'Legacy area', polygon: [[-10, -10], [410, -10], [400, 300]] }],
    tables: [{ id: 'legacy-table', name: 'Legacy table', zoneId: 'legacy-zone', capacity: 1,
      rect: { x: 0, y: 100, width: 40, height: 60 }, seats: [{ id: 'legacy-seat', x: -35, y: 130, neighbors: [] }] }],
    sensorAssignments: [],
  });
  const legacyState: PublishedLocationState = {
    locationId: legacyDocument.locationId,
    activeRevision: 0,
    history: [{ locationId: legacyDocument.locationId, revision: 0, createdBy: 'seed', createdAt: 0, document: legacyDocument }],
  };
  persistence.setPublishedLocation(legacyState);
  app.use('/api', createLocationRouter({
    auth, edgeId: 'edge-legacy-api', siteSeed: siteJson(), ...persistence,
    assets: persistence.assets, assetMetadata: persistence.assets,
    runtime: fakeRuntime as unknown as import('../src/modules/location-config/routes/location-router.js').LocationRouterDependencies['runtime'],
    suggestCoverage: computeLocationCoverageSuggestions, now: () => 200,
  }));
  app.use(auth.router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'legacy-operator', password: 'correct horse battery' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const json = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1', origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const start = await json('POST', '/api/locations/legacy-room/drafts', { expectedPublishedRevision: 0 });
    assert.equal(start.status, 201, await start.clone().text());
    const startData = (await start.json() as { data: DraftDto }).data;
    assert.equal(startData.visibility, 'console');
    assert.deepEqual(startData.document.outline, legacyDocument.outline);
    assert.deepEqual(startData.document.zones[0]?.polygon, legacyDocument.zones[0]?.polygon);
    assert.equal(startData.document.tables[0]?.shape, undefined, 'legacy rect is represented without a synthesized shape tag');
    assert.deepEqual(startData.document.tables[0]?.rect, { x: 0, y: 100, width: 40, height: 60 });
    assert.equal(startData.document.tables[0]?.seats[0]?.x, -35);
    assert.equal(Object.hasOwn(startData.document, 'visibility'), false);
    assert.equal(Object.hasOwn(startData, 'legacySpatial'), false);
    assert.equal(Object.hasOwn(startData, 'assetProvenance'), false);

    const getDraft = () => json('GET', `/api/locations/drafts/${startData.draftId}`);
    const detail = await getDraft();
    assert.equal(detail.status, 200);
    const detailData = (await detail.json() as { data: DraftDto }).data;
    assert.deepEqual(detailData.document, startData.document, 'GET exposes the same exact base-derived edit DTO');

    const legacySensorUid = 'aa:bb:cc:dd:ee:35';
    const legacyPose = { x: -35, y: 130, heightCm: 150, yawDeg: 0, mirror: false };
    persistence.setSnapshotNodes([{
      uid: legacySensorUid, label: 'Legacy sensor', floorId: 'legacy-room', pose: legacyPose,
      owns: [], simulated: false, rgb: false, detector: 'node',
    }]);
    const legacyCoverage = await json('POST', `/api/locations/drafts/${startData.draftId}/coverage-suggestions`, {
      document: startData.document,
      proposedSensors: [{ uid: legacySensorUid, pose: legacyPose }],
    });
    assert.equal(legacyCoverage.status, 200, await legacyCoverage.clone().text());
    const legacySuggestions = ((await legacyCoverage.json()) as { data: { suggestions: Array<{
      tableId: string; coveredBy: string[]; seatCoverage: { totalSeats: number; coveredSeats: number };
    }> } }).data.suggestions;
    assert.deepEqual(legacySuggestions[0], {
      tableId: 'legacy-table', coveredBy: [legacySensorUid], suggestedOwner: legacySensorUid,
      seatCoverage: { totalSeats: 1, coveredSeats: 1, bySensor: [{ uid: legacySensorUid, coveredSeats: 1 }] },
    }, 'coverage evaluates the exact inherited off-floor seat, not the safe placeholder');

    const saveUnchanged = await json('PUT', `/api/locations/drafts/${startData.draftId}`, {
      expectedDraftRevision: 1, document: structuredClone(startData.document),
    });
    assert.equal(saveUnchanged.status, 200, await saveUnchanged.clone().text());
    const savedData = (await saveUnchanged.json() as { data: DraftDto }).data;
    assert.equal(savedData.draftRevision, 2);
    assert.deepEqual(savedData.document, startData.document, 'unchanged legacy fields survive the authored-only save boundary');

    const changedInvalid = structuredClone(savedData.document) as DraftDto['document'];
    changedInvalid.zones[0]!.polygon[0]![0] = -11;
    const changedResponse = await json('PUT', `/api/locations/drafts/${startData.draftId}`, {
      expectedDraftRevision: 2, document: changedInvalid,
    });
    assert.equal(changedResponse.status, 422, 'changed invalid inherited geometry is not grandfathered');
    for (const key of ['schemaVersion', 'locationId', 'visibility', 'legacySpatial', 'assetProvenance']) {
      const forged = structuredClone(savedData.document) as Record<string, unknown>;
      forged[key] = {};
      const response = await json('PUT', `/api/locations/drafts/${startData.draftId}`, {
        expectedDraftRevision: 2, document: forged,
      });
      assert.equal(response.status, 422, `PUT rejects client-set ${key}`);
    }

    const upload = await fetch(`${base}/api/locations/drafts/${startData.draftId}/assets/floor-plan`, {
      method: 'PUT', headers: { cookie, 'x-tm-algo': '1', origin: base, 'content-type': 'image/png', 'if-match': '2' }, body: PNG,
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const uploadData = (await upload.json() as { data: { assetId: string; draftRevision: number } }).data;
    assert.equal(uploadData.draftRevision, 3);
    const afterUpload = await getDraft();
    const afterData = (await afterUpload.json() as { data: DraftDto }).data;
    assert.deepEqual(afterData.document.outline, legacyDocument.outline);
    assert.deepEqual(afterData.document.zones[0]?.polygon, legacyDocument.zones[0]?.polygon);
    assert.equal(afterData.document.tables[0]?.shape, undefined);
    assert.equal(afterData.document.tables[0]?.seats[0]?.x, -35);
    assert.equal(afterData.document.planAssetId, uploadData.assetId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

const fakeRuntime = {
  prepare() { return {}; }, refresh(generation: object) { return generation; }, activate() {}, quarantine() {},
} as unknown as PreparedLocationRuntime<object>;

function makePersistence(directory: string) {
  const assetStore = new FileLocationAssetStore(directory);
  const draftsById = new Map<string, LocationDraft>();
  const locationsById = new Map<string, PublishedLocationState>();
  let snapshotNodes: LocationRegistrySnapshot['nodes'] = [];
  let lockHeld = false;
  const coordinator: RegistryMutationCoordinator = {
    async withMutationLock(operation) {
      if (lockHeld) throw new Error('nested location lock');
      lockHeld = true;
      try { return await operation(); } finally { lockHeld = false; }
    },
    assertHealthy() { if (!lockHeld) throw new Error('location lock required'); },
    quarantine() { throw new Error('unexpected quarantine'); },
  };
  const drafts: LocationDraftRepository = {
    async createDraft(draft) {
      if (draftsById.has(draft.draftId)) throw new LocationConflictError();
      draftsById.set(draft.draftId, structuredClone(draft));
      return { kind: 'committed', durability: 'confirmed', contentSha256: 'a'.repeat(64), draft: structuredClone(draft) };
    },
    async getDraft(creatorId, draftId) {
      const draft = draftsById.get(draftId);
      return draft?.creatorId === creatorId ? structuredClone(draft) : null;
    },
    async getDraftForRead(creatorId, draftId) {
      return this.getDraft(creatorId, draftId);
    },
    async getDraftForReadWithinMutation(creatorId, draftId) {
      return this.getDraft(creatorId, draftId);
    },
    async listDrafts(creatorId) { return [...draftsById.values()].filter((draft) => draft.creatorId === creatorId).map((draft) => structuredClone(draft)); },
    async saveDraft(creatorId, draftId, expectedRevision, candidate: ValidatedLocationCandidate, updatedAt) {
      const current = draftsById.get(draftId);
      if (!current || current.creatorId !== creatorId) throw new Error('draft not found');
      if (current.draftRevision !== expectedRevision) throw new LocationConflictError();
      const draft = { ...current, draftRevision: expectedRevision + 1, updatedAt, document: candidate.document, legacySpatial: candidate.legacySpatial, assetProvenance: candidate.assetProvenance };
      draftsById.set(draftId, structuredClone(draft));
      return { kind: 'committed', durability: 'confirmed', contentSha256: 'b'.repeat(64), draft: structuredClone(draft) };
    },
  };
  const snapshots: LocationRegistrySnapshotRepository = {
    async readSnapshot() {
      return { registryRevision: 0, nodes: snapshotNodes, locations: [...locationsById.values()].map((state) => structuredClone(state)) } satisfies LocationRegistrySnapshot;
    },
  };
  const published: PublishedLocationRepository = {
    async assertLocationIdAvailable(locationId) { if (locationsById.has(locationId)) throw new LocationConflictError(); },
    async getActive(locationId) { const state = locationsById.get(locationId); return state ? structuredClone(state) : null; },
    async listActive() { return [...locationsById.values()].map((state) => structuredClone(state)); },
    async listHistory(locationId) { return structuredClone(locationsById.get(locationId)?.history ?? []); },
    async commitWithinMutation() { throw new Error('unused'); }, async registryRevision() { return 0; },
  };
  return {
    coordinator, drafts, snapshots, published, assets: assetStore,
    setSnapshotNodes(nodes: LocationRegistrySnapshot['nodes']) { snapshotNodes = structuredClone(nodes); },
    setPublishedLocation(state: PublishedLocationState) { locationsById.set(state.locationId, structuredClone(state)); },
  };
}

interface DraftDto {
  draftId: string; locationId: string; draftRevision: number; basePublishedRevision: number | null; visibility: string;
  document: { outline: number[][]; zones: Array<{ polygon: number[][] }>; tables: Array<{
    shape?: unknown; rect?: { x: number; y: number; width: number; height: number }; seats: Array<{ x: number }>;
  }>; planAssetId?: string };
}

function makeGlb(root: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(root), 'utf8');
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const output = Buffer.alloc(20 + jsonLength, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}
