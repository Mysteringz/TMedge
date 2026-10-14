import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { AlgoUsers } from '../dist/src/algo/auth.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { JsonStudentAccountRepository } from '../dist/src/infrastructure/web/json-student-account-repository.js';
import { loadPostgresConnectionConfig } from '../dist/src/infrastructure/postgres/config.js';
import { closePostgres, openPostgres } from '../dist/src/infrastructure/postgres/data-source.js';
import { PostgresRegistryMutationCoordinator } from '../dist/src/infrastructure/location-config/postgres-registry-mutation-coordinator.js';
import { PostgresPublishedLocationRepository } from '../dist/src/infrastructure/postgres/location-configuration-repositories.js';
import { PostgresRegistryRepository } from '../dist/src/infrastructure/postgres/registry-repository.js';
import { identity, personAt, report } from '../dist/test/fixtures.js';

const PROFILE = process.env.TASK_4_2_PROFILE;
const EDGE_ID = 'qaedge42';
const SENSOR_UID = 'aa:bb:cc:dd:42:01';
const PENDING_SENSOR_UID = 'aa:bb:cc:dd:42:02';
const WEB_TOKEN = 'task-4-2-synthetic-web-push-token';
const PROVISIONING_TOKEN = 'task-4-2-synthetic-provisioning-token';
const MANAGER_PASSWORD = 'Correct-Horse-Test-2026!';
const STUDENT_EMAIL = 'student.qa@hku.hk';
const STUDENT_PASSWORD = 'Student-Test-Password-2026!';
const LOCATION_TRANSFORM = {
  scale: { x: 1.15, y: 0.95, z: 1.05 },
  rotationDeg: { x: 3, y: 18, z: -2 },
  positionM: { x: 0.75, y: 0.4, z: -0.5 },
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test(`Task 4.2 real-process workflow (${PROFILE ?? 'profile required'})`, {
  skip: PROFILE !== 'file' && PROFILE !== 'postgres',
  timeout: 600_000,
}, async (t) => {
  const root = join(process.cwd(), 'tmp', 'wizard-e2e');
  mkdirSync(root, { recursive: true });
  const runDir = join(root, `${PROFILE}-${Date.now()}-${randomUUID()}`);
  mkdirSync(runDir, { recursive: true });
  const artifacts = process.env.TASK_4_2_ARTIFACTS ? resolve(process.env.TASK_4_2_ARTIFACTS) : join(runDir, 'evidence');
  mkdirSync(artifacts, { recursive: true });
  const evidence = {
    profile: PROFILE,
    stages: [],
    http: [],
    browser: { pageErrors: [], consoleErrors: [], network: [], publicPayloadChecks: [] },
    processRestarts: [],
    migrations: [],
  };
  const processes = new Set();
  const task5FurnitureAssetIds = new Set();
  let task5FurnitureAssetsCleaned = false;
  let browser;
  let browserContext;
  let edge;
  let web1;
  let web2;
  let web1PushProxy;
  let web2PushProxy;
  let migrationCount = 0;
  let migrationDownCount = 0;
  globalThis.__task42Evidence = evidence;

  const stage = (name, detail = {}) => evidence.stages.push({ name, ...detail });
  try {
    const fixture = createFixtureFiles(runDir);
    const gracefulStopModule = join(runDir, 'graceful-stop.mjs');
    writeFileSync(gracefulStopModule, `let input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => {\n  input += chunk;\n  if (input.includes('TASK42_STOP\\n')) process.emit('SIGTERM');\n});\n`);
    const ports = {
      edgeConsole: await availablePort(),
      edgeAlgo: await availablePort(),
      edgeUdp: await availableUdpPort(),
      web1: await availablePort(),
      web2: await availablePort(),
      web1Push: await availablePort(),
      web2Push: await availablePort(),
    };
    const edgeBase = `http://127.0.0.1:${ports.edgeAlgo}`;
    const web1Base = `http://127.0.0.1:${ports.web1}`;
    const web2Base = `http://127.0.0.1:${ports.web2}`;
    const web1PushBase = `http://127.0.0.1:${ports.web1Push}`;
    const web2PushBase = `http://127.0.0.1:${ports.web2Push}`;
    const dbEnv = PROFILE === 'postgres' ? postgresEnvironment() : {};

    if (PROFILE === 'postgres') {
      const preflight = await inspectPostgresCleanup(dbEnv);
      assert.deepEqual(preflight, { registeredNodes: null, migrationRows: 0, publicTables: ['migrations'] },
        'the isolated synthetic database must match the exact known fixture baseline before this profile');
      evidence.migrations.push({ direction: 'preflight', ...preflight, result: 'PASS' });
      const migrationFiles = readdirSync(resolve('dist/src/infrastructure/postgres/migrations'))
        .filter((name) => name.endsWith('.js')).sort();
      const up = await runTool('dist/src/tools/postgres-migrate.js', ['up'], { ...dbEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only' });
      const applied = Number(/Applied (\d+) migration\(s\)\./.exec(up.stdout)?.[1] ?? -1);
      migrationCount = Math.max(applied, 0);
      assert.equal(applied, migrationFiles.length, `synthetic database must apply every compiled migration (${migrationFiles.length}); result=${up.stdout.trim()}`);
      evidence.migrations.push({ direction: 'up', count: applied, files: migrationFiles, result: 'PASS' });
    }

    const usersPath = join(fixture.edgeData, 'algo', 'users.json');
    const users = new AlgoUsers(usersPath);
    await users.add('qa-admin-a', MANAGER_PASSWORD, 'admin');
    await users.add('qa-operator-b', MANAGER_PASSWORD, 'operator');
    await users.add('qa-admin-c', MANAGER_PASSWORD, 'admin');
    await users.add('qa-engineer', MANAGER_PASSWORD, 'engineer');
    await users.add('qa-viewer', MANAGER_PASSWORD, 'viewer');
    for (const webData of [fixture.web1Data, fixture.web2Data]) {
      const accounts = new JsonStudentAccountRepository(join(webData, 'users.json'), ['hku.hk']);
      await accounts.create(STUDENT_EMAIL, 'Synthetic integration student', STUDENT_PASSWORD);
    }

    if (PROFILE === 'postgres') {
      await seedPostgresNodes(fixture.site, fixture.nodes, dbEnv);
    }

    const webEnv = (port, dataDir, suffix) => ({
      WEB_HOST: '127.0.0.1', WEB_PORT: String(port),
      WEB_PUSH_TOKEN: WEB_TOKEN,
      SESSION_SECRET: `task-4-2-${suffix}-student-session-secret-0123456789`,
      DATA_DIR: dataDir,
      USERS_FILE: join(dataDir, 'users.json'),
      SIGNUP_OPEN: '0',
      ALLOWED_EMAIL_DOMAINS: 'hku.hk',
      STALE_MS: '60000',
    });
    const startWeb1 = () => spawnOwned('web-target-1', 'dist/src/web/main.js', [], webEnv(ports.web1, fixture.web1Data, 'target-one'), processes, gracefulStopModule);
    const startWeb2 = () => spawnOwned('web-target-2', 'dist/src/web/main.js', [], webEnv(ports.web2, fixture.web2Data, 'target-two'), processes, gracefulStopModule);
    const startEdge = () => spawnOwned('edge', 'dist/src/edge/main.js', [], {
      PERSISTENCE_MODE: PROFILE,
      SITE_CONFIG: fixture.sitePath,
      NODES_CONFIG: fixture.nodesPath,
      DATA_DIR: fixture.edgeData,
      EDGE_ID,
      TM_KEY: 'test-key',
      ALLOW_UNSIGNED: '0',
      UDP_HOST: '127.0.0.1', UDP_PORT: String(ports.edgeUdp),
      CONSOLE_HOST: '127.0.0.1', CONSOLE_PORT: String(ports.edgeConsole),
      ADMIN_PASSWORD: 'synthetic-console-password',
      ALGO_PORT: String(ports.edgeAlgo),
      ALGO_USERS_FILE: usersPath,
      ALGO_SESSION_SECRET: 'task-4-2-edge-algo-session-secret-0123456789',
      TMFLASH_TOKEN: PROVISIONING_TOKEN,
      WEB_PUSH_URLS: `${web1PushBase},${web2PushBase}`,
      WEB_PUSH_TOKEN: WEB_TOKEN,
      PUBLISH_MS: '200',
      GATEWAY_PORT: '0', NODE_PORT: '0',
      ...dbEnv,
    }, processes, gracefulStopModule);

    web1 = startWeb1();
    web2 = startWeb2();
    await waitHttp(`${web1Base}/login/`, 200, web1, 'first web target ready');
    await waitHttp(`${web2Base}/login/`, 200, web2, 'second web target ready');
    web1PushProxy = await createSnapshotRecordingProxy(web1Base, ports.web1Push);
    web2PushProxy = await createSnapshotRecordingProxy(web2Base, ports.web2Push);
    edge = startEdge();
    await waitHttp(`${edgeBase}/login`, 200, edge, 'edge algo sign-in page ready');
    stage('real entrypoints ready', { profile: PROFILE, separateWebTargets: 2, persistence: PROFILE });

    const managers = {};
    for (const name of ['qa-admin-a', 'qa-operator-b', 'qa-admin-c', 'qa-engineer', 'qa-viewer']) {
      managers[name] = await loginManager(edgeBase, name);
    }
    for (const name of Object.keys(managers)) {
      const me = await fetch(`${edgeBase}/api/me`, { headers: { cookie: managers[name] } });
      assert.equal(me.status, 200, `${name} can use the existing manager identity API`);
      const workspace = await fetch(`${edgeBase}/api/workspace/`, { headers: { cookie: managers[name] } });
      assert.equal(workspace.status, 200, `${name} can use the existing workspace API`);
      const locations = await getJson(edgeBase, '/api/locations', managers[name]);
      assert.equal(locations.response.status, ['qa-admin-a', 'qa-operator-b', 'qa-admin-c'].includes(name) ? 200 : 403,
        `${name} location capability is role scoped`);
    }
    stage('signed manager role matrix', { managers: 5, manageRoles: 3, deniedRoles: 2, siblingApis: 'all five 200' });

    const student1 = await loginStudent(web1Base);
    const student2 = await loginStudent(web2Base);
    const studentCookie = `tm_session=${student1}`;
    const student2Cookie = `tm_session=${student2}`;
    await waitFor(async () => {
      const view = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
      return fixture.publicSeedFloorIds.every((id) => view.floors.some((floor) => floor.id === id));
    }, edge, 'initial legacy seed snapshot on the student web target');
    const seedViewBeforeMutation = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    const seedFloorBaseline = new Map(seedViewBeforeMutation.floors
      .filter((floor) => fixture.publicSeedFloorIds.includes(floor.id))
      .map((floor) => [floor.id, stableFloorConfig(floor)]));
    assert.equal(seedFloorBaseline.size, fixture.publicSeedFloorIds.length, 'the initial current snapshot contains each public legacy seed floor');
    const beforePrivateSave = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } });
    assert.equal(beforePrivateSave.status, 200);

    const created = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', '/api/locations/drafts', {
      name: 'QA Published Location', building: 'Task 4.2 Integration', widthCm: 800, heightCm: 400,
    });
    assert.equal(created.response.status, 201, `create private draft returned ${created.response.status}`);
    const initialDraft = created.body.data;
    const locationId = initialDraft.locationId;
    const draftId = initialDraft.draftId;
    const uncommittedView = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    assert.equal(uncommittedView.floors.some((floor) => floor.id === locationId), false, 'private create is not active or public');
    const preflightAsset = await fetch(`${web1Base}/api/models/${randomUUID()}`, { headers: { cookie: studentCookie } });
    assert.equal(preflightAsset.status, 404);

    const privateAssetDraft = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', '/api/locations/drafts', {
      name: 'QA A Private Asset', building: 'Task 4.2 Private', widthCm: 400, heightCm: 300,
    });
    assert.equal(privateAssetDraft.response.status, 201);
    const privateUpload = await managerUpload(edgeBase, managers['qa-admin-a'], privateAssetDraft.body.data.draftId,
      'model', 1, makeTriangleGlb(), 'private-only.glb', 'model/gltf-binary');
    assert.equal(privateUpload.response.status, 200);
    const privateAssetId = privateUpload.body.data.assetId;
    assert.equal((await fetch(`${web1Base}/api/models/${privateAssetId}`, { headers: { cookie: studentCookie } })).status, 404,
      'an unreferenced private model never becomes student-readable');

    const planUpload = await managerUpload(edgeBase, managers['qa-admin-a'], draftId, 'floor-plan', 1, PNG, undefined, 'image/png');
    assert.equal(planUpload.response.status, 200);
    const modelBytes = makeTriangleGlb();
    const modelUpload = await managerUpload(edgeBase, managers['qa-admin-a'], draftId, 'model', 2, modelBytes, 'QA full workflow.glb', 'model/gltf-binary');
    assert.equal(modelUpload.response.status, 200);
    let modelAssetId = modelUpload.body.data.assetId;
    const firstPublishedModelAssetId = modelAssetId;
    const modelDisplayName = 'QA full workflow.glb';
    const planPreviewA = await fetch(`${edgeBase}/api/locations/drafts/${draftId}/assets/${planUpload.body.data.assetId}`, { headers: { cookie: managers['qa-admin-a'] } });
    assert.equal(planPreviewA.status, 200, 'the plan is privately previewable only through the owned draft route');
    assert.deepEqual(Buffer.from(await planPreviewA.arrayBuffer()), PNG);
    const anotherManagerPlanGuess = await fetch(`${edgeBase}/api/locations/drafts/${draftId}/assets/${planUpload.body.data.assetId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(anotherManagerPlanGuess.status, 404, 'another manager cannot read a private plan by guessing its asset ID');
    const privateLocationListB = await getJson(edgeBase, '/api/locations', managers['qa-operator-b']);
    assert.equal(privateLocationListB.body.data.drafts.some((item) => item.locationId === locationId), false,
      'another manager does not see the private draft in list responses');
    const privateLocationDetailB = await fetch(`${edgeBase}/api/locations/drafts/${draftId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(privateLocationDetailB.status, 404, 'another manager cannot read the private draft detail');
    for (const role of ['qa-engineer', 'qa-viewer']) {
      const deniedPrivateDetail = await fetch(`${edgeBase}/api/locations/drafts/${draftId}`, { headers: { cookie: managers[role] } });
      assert.equal(deniedPrivateDetail.status, 403, `${role} cannot read manager-only draft details`);
    }
    const anonymousLocationList = await fetch(`${edgeBase}/api/locations`);
    assert.equal(anonymousLocationList.status, 401, 'anonymous requests cannot enumerate manager locations');
    const authored = authorDocument(modelUpload.body.data.assetId, planUpload.body.data.assetId);
    const sensor = { uid: SENSOR_UID, pose: { x: 400, y: 200, heightCm: 350, yawDeg: 0, mirror: false } };
    const coverage = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${draftId}/coverage-suggestions`, {
      document: authored, proposedSensors: [sensor],
    });
    assert.equal(coverage.response.status, 200, `coverage response status ${coverage.response.status}`);
    const rectangleCoverage = coverage.body.data.suggestions.find((item) => item.tableId === 'qa-rect');
    assert.equal(rectangleCoverage?.seatCoverage.coveredSeats, 3, 'the proposed sensor covers all rectangle seats');
    authored.sensorAssignments = [{ uid: SENSOR_UID, pose: sensor.pose, owns: ['qa-rect'] }];
    const save = await managerJson(edgeBase, managers['qa-admin-a'], 'PUT', `/api/locations/drafts/${draftId}`, {
      expectedDraftRevision: 3, document: authored,
    });
    assert.equal(save.response.status, 200, `private geometry save returned ${save.response.status}`);
    assert.equal(save.body.data.draftRevision, 4);
    const reloadedDraft = await getJson(edgeBase, `/api/locations/drafts/${draftId}`, managers['qa-admin-a']);
    assert.equal(reloadedDraft.response.status, 200);
    assert.equal(reloadedDraft.body.data.document.tables.length, 3, 'rect, circle, and polygon tables survive reload');
    assert.equal(reloadedDraft.body.data.document.zones[0].id, 'qa-room');
    assert.equal(reloadedDraft.body.data.document.modelAssetId, modelAssetId);
    const sensorsBeforePublish = await getJson(edgeBase, `/api/locations/drafts/${draftId}/sensors`, managers['qa-admin-a']);
    const proposedNodeBeforePublish = sensorsBeforePublish.body.data.sensors.find((item) => item.uid === SENSOR_UID);
    assert.ok(proposedNodeBeforePublish, 'the approved unplaced sensor is available in draft choices');
    assert.equal(proposedNodeBeforePublish.pose, null, 'private sensor pose remains unplaced in the live registry before publication');
    assert.equal(sensorsBeforePublish.body.data.sensors.some((item) => item.uid === '2c:cf:67:0b:c0:94'), false,
      'public draft choices exclude RGB sensors restricted to console locations');
    assert.equal(sensorsBeforePublish.body.data.sensors.some((item) => item.uid === '30:ed:a0:cb:f5:f8'), false,
      'draft choices exclude sensors already assigned to a different floor');
    assert.equal((await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json())).floors
      .some((floor) => floor.id === locationId), false, 'private save still does not activate the candidate');
    stage('private authoring, upload and coverage', { locationId, shapes: ['rect', 'circle', 'polygon'], sensorOwner: true, unknownTables: 2, planKeptPrivate: true });

    web2.stop();
    await web2.wait();
    web2 = null;
    const failedPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${draftId}/publications`, {
      expectedDraftRevision: 4, expectedPublishedRevision: null,
    });
    assert.equal(failedPublish.response.status, 503, 'one stopped configured web target blocks a public GLB commit');
    const unchangedList = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    assert.equal(unchangedList.body.data.published.some((item) => item.locationId === locationId), false,
      'failed target acknowledgement leaves published revision absent');
    assert.equal((await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: studentCookie } })).status, 404,
      'target 1 bytes are not authorized before the winning snapshot references them');
    web2 = startWeb2();
    await waitHttp(`${web2Base}/login/`, 200, web2, 'second target recovered');
    const publish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${draftId}/publications`, {
      expectedDraftRevision: 4, expectedPublishedRevision: null,
    });
    assert.equal(publish.response.status, 200, `retry after target recovery returned ${publish.response.status}`);
    assert.equal(publish.body.data.publishedRevision, 1);
    const sensorsAfterPublish = await getJson(edgeBase, `/api/locations/drafts/${draftId}/sensors`, managers['qa-admin-a']);
    assert.deepEqual(sensorsAfterPublish.body.data.sensors.find((item) => item.uid === SENSOR_UID).pose, sensor.pose,
      'the same candidate pose becomes live only after publication succeeds');
    await waitFor(async () => {
      const [one, two] = await Promise.all([
        fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: studentCookie } }),
        fetch(`${web2Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${student2}` } }),
      ]);
      return one.status === 200 && two.status === 200;
    }, edge, 'both student web targets accept the current snapshot and model');
    for (const [base, cookie] of [[web1Base, studentCookie], [web2Base, `tm_session=${student2}`]]) {
      const response = await fetch(`${base}/api/models/${modelAssetId}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type')?.split(';')[0], 'model/gltf-binary');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), modelBytes);
    }
    const publicViewResponse = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } });
    const publicView = await publicViewResponse.json();
    const publishedFloor = publicView.floors.find((floor) => floor.siteId === 'hku-innowing' && floor.id === locationId);
    assert.ok(publishedFloor, 'edge publication appears in the real student view');
    assert.equal(publishedFloor.tables.find((table) => table.id === 'qa-rect')?.status, 'unknown');
    assert.equal(publishedFloor.model.assetId, modelAssetId);
    assert.equal(publicView.floors.some((floor) => floor.id === 'iw-intern-demo'), false,
      'console-only locations are omitted from the student occupancy API');
    const privatePayloadMarkers = [privateAssetId, planUpload.body.data.assetId, modelDisplayName, 'QA replacement.glb', SENSOR_UID,
      'assetProvenance', draftId, privateAssetDraft.body.data.draftId, 'qa-admin-a'];
    const serializedStudentView = JSON.stringify(publicView);
    for (const privateValue of privatePayloadMarkers) {
      assert.equal(serializedStudentView.includes(privateValue), false, `student occupancy excludes ${privateValue === SENSOR_UID ? 'sensor identity' : 'private asset metadata'}`);
    }
    for (const actual of publicView.floors) {
      if (!fixture.publicSeedFloorIds.includes(actual.id)) continue;
      assert.deepEqual(stableFloorConfig(actual), seedFloorBaseline.get(actual.id), `published seed floor ${actual.id} retains exact geometry/table placements`);
    }
    const listAfterPublish = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    const publishedIds = new Set(listAfterPublish.body.data.published.map((item) => item.locationId));
    for (const seedFloor of fixture.seedFloorIds) assert.equal(publishedIds.has(seedFloor), true, `legacy seed location ${seedFloor} remains present`);
    assert.equal(publishedIds.has(locationId), true, 'the additive location is present beside every legacy seed');
    const nodesAfterPublish = JSON.parse(readFileSync(fixture.nodesPath, 'utf8'));
    for (const seedNode of fixture.seedNodes) {
      const persisted = nodesAfterPublish.nodes.find((node) => node.uid === seedNode.uid);
      assert.ok(persisted, `seed node ${seedNode.uid} remains registered after additive publication`);
      for (const key of ['uid', 'label', 'simulated', 'rgb', 'detector', 'owns']) {
        assert.deepEqual(persisted[key], seedNode[key], `seed node ${seedNode.uid} ${key} is preserved`);
      }
    }
    const planNotPublished = await fetch(`${web1Base}/api/models/${planUpload.body.data.assetId}`, { headers: { cookie: studentCookie } });
    assert.equal(planNotPublished.status, 404, 'a plan image is never exposed through the student model route');
    const furnitureWorkflow = await captureManagerBrowser({
      edgeBase, cookie: managers['qa-admin-a'], crossManagerCookie: managers['qa-operator-b'], artifacts, evidence,
      furnitureAssetIds: task5FurnitureAssetIds,
    });
    stage('two-target durable public model publication', { failureBeforeCommit: '503', retry: 'revision 1', targets: 2, identicalBytes: true, planRoute: 404 });

    const replacementDraft = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 1 });
    assert.equal(replacementDraft.response.status, 201);
    const replacementUpload = await managerUpload(edgeBase, managers['qa-admin-a'], replacementDraft.body.data.draftId,
      'model', replacementDraft.body.data.draftRevision, makeTriangleGlb(), 'QA replacement.glb', 'model/gltf-binary');
    assert.equal(replacementUpload.response.status, 200);
    const replacementAssetId = replacementUpload.body.data.assetId;
    web2.stop(); await web2.wait(); web2 = null;
    const failedReplacementPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${replacementDraft.body.data.draftId}/publications`, {
      expectedDraftRevision: replacementUpload.body.data.draftRevision, expectedPublishedRevision: 1,
    });
    assert.equal(failedReplacementPublish.response.status, 503, 'missing target blocks a replacement of an already-published GLB');
    const afterFailedReplacementList = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    assert.equal(afterFailedReplacementList.body.data.published.find((item) => item.locationId === locationId).activeRevision, 1,
      'failed replacement preserves the previous active revision');
    const oldModelAfterFailure = await fetch(`${web1Base}/api/models/${firstPublishedModelAssetId}`, { headers: { cookie: studentCookie } });
    assert.equal(oldModelAfterFailure.status, 200, 'old published model stays authorized after replacement ACK failure');
    assert.deepEqual(Buffer.from(await oldModelAfterFailure.arrayBuffer()), modelBytes);
    const unpublishedReplacement = await fetch(`${web1Base}/api/models/${replacementAssetId}`, { headers: { cookie: studentCookie } });
    assert.equal(unpublishedReplacement.status, 404, 'replacement bytes are not authorized before the new winning snapshot');
    const publicModelDuringFailure = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    assert.equal(publicModelDuringFailure.floors.find((floor) => floor.id === locationId).model.assetId, firstPublishedModelAssetId,
      'student snapshot keeps the previous model during failed replacement');
    web2 = startWeb2(); await waitHttp(`${web2Base}/login/`, 200, web2, 'second web target recovered for replacement');
    const replacementPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${replacementDraft.body.data.draftId}/publications`, {
      expectedDraftRevision: replacementUpload.body.data.draftRevision, expectedPublishedRevision: 1,
    });
    assert.equal(replacementPublish.response.status, 200);
    assert.equal(replacementPublish.body.data.publishedRevision, 2);
    modelAssetId = replacementAssetId;
    await waitFor(async () => (await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: studentCookie } })).status === 200,
      edge, 'replacement becomes readable after all target acknowledgements');
    assert.equal((await fetch(`${web1Base}/api/models/${firstPublishedModelAssetId}`, { headers: { cookie: studentCookie } })).status, 404,
      'the superseded immutable model is no longer authorized after replacement wins');
    stage('failed and successful model replacement', { priorRevisionPreserved: 1, failedAck: 503, oldModelStayedLive: true, replacementRevision: 2 });

    const studentSearchUnknown = await fetch(`${web1Base}/api/search?seats=1&siteId=hku-innowing&floor=${encodeURIComponent(locationId)}`, { headers: { cookie: studentCookie } });
    assert.equal(studentSearchUnknown.status, 200);
    const unknownSearch = await studentSearchUnknown.json();
    assert.equal(unknownSearch.results.some((result) => result.tableIds.includes('qa-circle') || result.tableIds.includes('qa-polygon')), false,
      'unknown/unowned tables are never suggested as free');
    assert.equal((await fetch(`${web1Base}/api/search?seats=1&siteId=hku-innowing`, { headers: { cookie: studentCookie } })).status, 400,
      'site identity must be paired with the floor identity');
    const activity = await fetch(`${web1Base}/api/activity`, {
      method: 'POST', headers: { cookie: studentCookie, origin: web1Base, 'content-type': 'application/json', 'x-tm-student-activity': '1' },
      body: JSON.stringify({ action: 'space-view', seats: 1, siteId: 'hku-innowing', floorId: locationId }),
    });
    assert.equal(activity.status, 202);
    const activityBody = await activity.json();
    const privateSearchText = JSON.stringify(unknownSearch);
    for (const privateValue of privatePayloadMarkers) {
      assert.equal(privateSearchText.includes(privateValue), false, 'public search excludes private asset, sensor, and provenance metadata');
    }
    for (const privateValue of privatePayloadMarkers) {
      assert.equal(JSON.stringify(activityBody).includes(privateValue), false, 'activity responses exclude private asset and sensor metadata');
    }

    const legacyBase = await managerJson(edgeBase, managers['qa-operator-b'], 'POST', '/api/locations/qa-legacy-static/drafts', { expectedPublishedRevision: 0 });
    assert.equal(legacyBase.response.status, 201, 'operator can edit the trusted legacy-static seed revision');
    const legacyDetails = await getJson(edgeBase, `/api/locations/drafts/${legacyBase.body.data.draftId}`, managers['qa-operator-b']);
    assert.equal(legacyDetails.body.data.assetCapabilities.modelAssetId?.source, 'legacy-static');
    const privateGuess = await fetch(`${edgeBase}/api/locations/drafts/${legacyBase.body.data.draftId}/assets/${privateAssetId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(privateGuess.status, 404, 'unrelated manager-private asset IDs do not authorize a read');
    const legacyDocument = legacyDetails.body.data.document;
    assert.equal(legacyDocument.tables[0]?.shape, undefined, 'legacy bootstrap emits no authored shape tag');
    assert.equal(legacyDocument.tables[0]?.seats[0]?.x, -35, 'legacy perimeter seat remains off-floor in the exact candidate');
    assert.ok(legacyDocument.outline[0][0] < 0, 'legacy outline retains its previously accepted out-of-bounds point');
    assert.ok(legacyDocument.zones[0].polygon[0][0] < 0, 'legacy zone retains its previously accepted out-of-bounds point');
    const legacyAuthored = { ...legacyDocument };
    delete legacyAuthored.schemaVersion; delete legacyAuthored.locationId; delete legacyAuthored.visibility;
    const legacySaved = await managerJson(edgeBase, managers['qa-operator-b'], 'PUT', `/api/locations/drafts/${legacyBase.body.data.draftId}`, {
      expectedDraftRevision: legacyBase.body.data.draftRevision, document: legacyAuthored,
    });
    assert.equal(legacySaved.response.status, 200, 'unchanged inherited legacy geometry can be saved through the exact-base bridge');
    const legacyReload = await getJson(edgeBase, `/api/locations/drafts/${legacyBase.body.data.draftId}`, managers['qa-operator-b']);
    assert.equal(legacyReload.body.data.document.tables[0].seats[0].x, -35, 'legacy geometry survives save and reload before publication');
    const legacyPublish = await managerJson(edgeBase, managers['qa-operator-b'], 'POST', `/api/locations/drafts/${legacyBase.body.data.draftId}/publications`, {
      expectedDraftRevision: legacySaved.body.data.draftRevision, expectedPublishedRevision: 0,
    });
    assert.equal(legacyPublish.response.status, 200, 'unchanged legacy-static references survive their server provenance path');
    const legacyStudentSnapshot = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    const legacyStudentFloor = legacyStudentSnapshot.floors.find((floor) => floor.id === 'qa-legacy-static');
    assert.ok(legacyStudentFloor, 'the public legacy floor remains visible after edit and publish');
    assert.equal(legacyStudentFloor.tables[0]?.shape, undefined, 'legacy rectangle remains shape-less in the public v2 snapshot');
    assert.equal(legacyStudentFloor.tables[0]?.seats[0]?.x, -35, 'legacy generated off-floor seat remains exact in the public snapshot');
    assert.ok(legacyStudentFloor.outline.some(([x, y]) => x < 0 || y < 0), 'legacy outline remains exact after publication');
    assert.ok(legacyStudentFloor.zones[0].polygon.some(([x, y]) => x < 0 || y < 0), 'legacy zone remains exact after publication');
    const staticNotDistributed = await fetch(`${web1Base}/api/models/${fixture.staticAssetId}`, { headers: { cookie: studentCookie } });
    assert.equal(staticNotDistributed.status, 404, 'legacy static fallback is not transferred as an uploaded GLB');
    assert.equal(readdirSync(join(fixture.web1Data, 'published-models')).includes(`${fixture.staticAssetId}.glb`), false);

    const transitionId = 'qa-generated-transition';
    const transitionBase = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/${transitionId}/drafts`, {
      expectedPublishedRevision: 0,
    });
    assert.equal(transitionBase.response.status, 201, 'the separate canonical fixture starts at its revision-zero static base');
    const transitionDraftId = transitionBase.body.data.draftId;
    assert.equal(transitionBase.body.data.document.modelAssetId, fixture.generatedStaticAssetId);
    const transitionDetail = await getJson(edgeBase, `/api/locations/drafts/${transitionDraftId}`, managers['qa-admin-a']);
    assert.equal(transitionDetail.body.data.assetCapabilities.modelAssetId.source, 'legacy-static');
    const transitionLegacyFloor = (await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json()))
      .floors.find((floor) => floor.id === transitionId);
    assert.ok(transitionLegacyFloor, 'the revision-zero static fixture is part of the initial student feed');
    assert.equal(Object.hasOwn(transitionLegacyFloor, 'proceduralRoom'), false, 'the old publication has no generated source marker');

    const bypass2d = { ...transitionBase.body.data.document };
    delete bypass2d.modelAssetId;
    delete bypass2d.modelTransform;
    const legacy2dBypass = await managerJson(edgeBase, managers['qa-admin-a'], 'PUT', `/api/locations/drafts/${transitionDraftId}`, {
      expectedDraftRevision: 1, document: bypass2d,
    });
    assert.equal(legacy2dBypass.response.status, 404, 'legacy-static cannot be switched directly to explicit 2D');

    const generatedPrivateDocument = { ...transitionBase.body.data.document };
    delete generatedPrivateDocument.modelAssetId;
    delete generatedPrivateDocument.modelTransform;
    generatedPrivateDocument.proceduralRoom = 'simple-rectangle-v1';
    const generatedPrivateSave = await managerJson(edgeBase, managers['qa-admin-a'], 'PUT', `/api/locations/drafts/${transitionDraftId}`, {
      expectedDraftRevision: 1, document: generatedPrivateDocument,
    });
    assert.equal(generatedPrivateSave.response.status, 200, 'an explicit generated source replacement saves privately');
    assert.equal(generatedPrivateSave.body.data.draftRevision, 2);
    assert.equal(generatedPrivateSave.body.data.document.proceduralRoom, 'simple-rectangle-v1');
    assert.equal(Object.hasOwn(generatedPrivateSave.body.data.document, 'modelAssetId'), false);
    assert.equal(Object.hasOwn(generatedPrivateSave.body.data.document, 'modelTransform'), false);
    const generatedPrivateDetail = await getJson(edgeBase, `/api/locations/drafts/${transitionDraftId}`, managers['qa-admin-a']);
    assert.equal(Object.hasOwn(generatedPrivateDetail.body.data.assetCapabilities, 'modelAssetId'), false,
      'generated drafts expose no dormant model capability or asset stash');
    const privateTransitionList = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    assert.equal(privateTransitionList.body.data.published.find((item) => item.locationId === transitionId).activeRevision, 0,
      'saving generated source does not advance the active static publication');
    const legacyStillPublicOne = (await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json()))
      .floors.find((floor) => floor.id === transitionId);
    const legacyStillPublicTwo = (await fetch(`${web2Base}/api/occupancy`, { headers: { cookie: student2Cookie } }).then((r) => r.json()))
      .floors.find((floor) => floor.id === transitionId);
    assert.equal(legacyStillPublicOne?.proceduralRoom, undefined, 'student target 1 keeps the old source before publication');
    assert.equal(legacyStillPublicTwo?.proceduralRoom, undefined, 'student target 2 keeps the old source before publication');
    const privatelySavedState = await readDurablePublishedState(fixture, transitionId, dbEnv);
    assert.equal(privatelySavedState.activeRevision, 0, 'the durable published pointer remains on revision zero after private save');
    assert.equal(privatelySavedState.history[0]?.document.modelAssetId, fixture.generatedStaticAssetId,
      'the immutable revision-zero static model remains in published history');

    edge.stop(); await edge.wait(); edge = null;
    edge = startEdge();
    await waitHttp(`${edgeBase}/login`, 200, edge, 'edge reopened from the same location store');
    managers['qa-admin-a'] = await loginManager(edgeBase, 'qa-admin-a');
    const reopenedGeneratedDraft = await getJson(edgeBase, `/api/locations/drafts/${transitionDraftId}`, managers['qa-admin-a']);
    assert.equal(reopenedGeneratedDraft.response.status, 200, 'the private generated draft is available after an edge process restart');
    assert.equal(reopenedGeneratedDraft.body.data.document.proceduralRoom, 'simple-rectangle-v1');
    assert.equal(reopenedGeneratedDraft.body.data.draftRevision, 2);
    const afterPrivateRestartList = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    assert.equal(afterPrivateRestartList.body.data.published.find((item) => item.locationId === transitionId).activeRevision, 0,
      'edge reconstruction keeps the original publication active until explicit publish');
    const transferFilesBeforeGenerated = publishedModelFiles(fixture.web1Data);
    const transferFilesBeforeGeneratedTwo = publishedModelFiles(fixture.web2Data);

    web2.stop(); await web2.wait(); web2 = null;
    const generatedPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${transitionDraftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 0,
    });
    assert.equal(generatedPublish.response.status, 200, 'generated publication commits while one student target is offline because no GLB ACK is required');
    assert.equal(generatedPublish.body.data.publishedRevision, 1);
    await waitFor(async () => {
      const view = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
      const floor = view.floors.find((item) => item.id === transitionId);
      return floor?.proceduralRoom === 'simple-rectangle-v1' && !Object.hasOwn(floor, 'model');
    }, edge, 'student target 1 receives the generated source with no model key');
    assert.deepEqual(publishedModelFiles(fixture.web1Data), transferFilesBeforeGenerated,
      'generated publication adds no uploaded-model transfer to the first web target');
    assert.equal(publishedModelFiles(fixture.web1Data).includes(`${fixture.generatedStaticAssetId}.glb`), false,
      'the replaced static source is not uploaded to the web model store');
    web2 = startWeb2(); await waitHttp(`${web2Base}/login/`, 200, web2, 'second web target recovered after generated publish');
    const student2AfterGenerated = await loginStudent(web2Base);
    const student2AfterGeneratedCookie = `tm_session=${student2AfterGenerated}`;
    await waitFor(async () => {
      const view = await fetch(`${web2Base}/api/occupancy`, { headers: { cookie: student2AfterGeneratedCookie } }).then((r) => r.json());
      const floor = view.floors.find((item) => item.id === transitionId);
      return floor?.proceduralRoom === 'simple-rectangle-v1' && !Object.hasOwn(floor, 'model');
    }, edge, 'student target 2 receives the generated source with no model key');
    assert.deepEqual(publishedModelFiles(fixture.web2Data), transferFilesBeforeGeneratedTwo,
      'the recovered second web target receives the generated snapshot without a model transfer');

    const generatedToCustom = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/${transitionId}/drafts`, {
      expectedPublishedRevision: 1,
    });
    assert.equal(generatedToCustom.response.status, 201);
    const transitionModelBytes = makeTriangleGlb();
    const generatedModelUpload = await managerUpload(edgeBase, managers['qa-admin-a'], generatedToCustom.body.data.draftId,
      'model', 1, transitionModelBytes, 'generated replacement.glb', 'model/gltf-binary');
    assert.equal(generatedModelUpload.response.status, 200, 'a successful uploaded GLB switches the generated draft to custom');
    const transitionModelAssetId = generatedModelUpload.body.data.assetId;
    const customDraftDetail = await getJson(edgeBase, `/api/locations/drafts/${generatedToCustom.body.data.draftId}`, managers['qa-admin-a']);
    assert.equal(customDraftDetail.body.data.document.modelAssetId, transitionModelAssetId);
    assert.equal(Object.hasOwn(customDraftDetail.body.data.document, 'proceduralRoom'), false);
    assert.equal(customDraftDetail.body.data.assetCapabilities.modelAssetId.source, 'upload');
    const customPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${generatedToCustom.body.data.draftId}/publications`, {
      expectedDraftRevision: generatedModelUpload.body.data.draftRevision, expectedPublishedRevision: 1,
    });
    assert.equal(customPublish.response.status, 200, 'custom GLB publication follows the established all-target ACK path');
    assert.equal(customPublish.body.data.publishedRevision, 2);
    await waitFor(async () => Promise.all([[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]].map(async ([base, cookie]) =>
      (await fetch(`${base}/api/models/${transitionModelAssetId}`, { headers: { cookie } })).status === 200)).then((results) => results.every(Boolean)),
    edge, 'both targets acknowledge and authorize the custom replacement GLB');
    for (const [base, cookie] of [[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]]) {
      const response = await fetch(`${base}/api/models/${transitionModelAssetId}`, { headers: { cookie } });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), transitionModelBytes);
      const view = await fetch(`${base}/api/occupancy`, { headers: { cookie } }).then((r) => r.json());
      const floor = view.floors.find((item) => item.id === transitionId);
      assert.equal(Object.hasOwn(floor, 'proceduralRoom'), false);
      assert.equal(floor.model.assetId, transitionModelAssetId);
    }

    const customTo2d = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/${transitionId}/drafts`, {
      expectedPublishedRevision: 2,
    });
    assert.equal(customTo2d.response.status, 201);
    const twoDDocument = { ...customTo2d.body.data.document };
    delete twoDDocument.modelAssetId;
    delete twoDDocument.modelTransform;
    delete twoDDocument.proceduralRoom;
    const twoDSave = await managerJson(edgeBase, managers['qa-admin-a'], 'PUT', `/api/locations/drafts/${customTo2d.body.data.draftId}`, {
      expectedDraftRevision: 1, document: twoDDocument,
    });
    assert.equal(twoDSave.response.status, 200, 'custom can be explicitly switched to 2D by clearing the active model reference');
    const twoDPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${customTo2d.body.data.draftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 2,
    });
    assert.equal(twoDPublish.response.status, 200);
    assert.equal(twoDPublish.body.data.publishedRevision, 3);
    await waitFor(async () => Promise.all([[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]].map(async ([base, cookie]) => {
      const view = await fetch(`${base}/api/occupancy`, { headers: { cookie } }).then((r) => r.json());
      const floor = view.floors.find((item) => item.id === transitionId);
      return floor?.model === null && !Object.hasOwn(floor, 'proceduralRoom');
    })).then((results) => results.every(Boolean)), edge, 'both targets receive the explicit 2D source');
    for (const [base, cookie] of [[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]]) {
      assert.equal((await fetch(`${base}/api/models/${transitionModelAssetId}`, { headers: { cookie } })).status, 404,
        'explicit 2D publication revokes access to the superseded GLB');
    }

    const twoDToGenerated = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/${transitionId}/drafts`, {
      expectedPublishedRevision: 3,
    });
    assert.equal(twoDToGenerated.response.status, 201);
    const generatedAgainDocument = { ...twoDToGenerated.body.data.document, proceduralRoom: 'simple-rectangle-v1' };
    const generatedAgainSave = await managerJson(edgeBase, managers['qa-admin-a'], 'PUT', `/api/locations/drafts/${twoDToGenerated.body.data.draftId}`, {
      expectedDraftRevision: 1, document: generatedAgainDocument,
    });
    assert.equal(generatedAgainSave.response.status, 200);
    const generatedAgainPublish = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${twoDToGenerated.body.data.draftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 3,
    });
    assert.equal(generatedAgainPublish.response.status, 200);
    assert.equal(generatedAgainPublish.body.data.publishedRevision, 4);
    await waitFor(async () => Promise.all([[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]].map(async ([base, cookie]) => {
      const view = await fetch(`${base}/api/occupancy`, { headers: { cookie } }).then((r) => r.json());
      const floor = view.floors.find((item) => item.id === transitionId);
      return floor?.proceduralRoom === 'simple-rectangle-v1' && !Object.hasOwn(floor, 'model');
    })).then((results) => results.every(Boolean)), edge, 'both targets receive the final generated source with no model descriptor');
    for (const [base, cookie] of [[web1Base, studentCookie], [web2Base, student2AfterGeneratedCookie]]) {
      assert.equal((await fetch(`${base}/api/models/${transitionModelAssetId}`, { headers: { cookie } })).status, 404,
        'generated return revokes the superseded GLB without a generated model route');
    }
    assert.equal(publishedModelFiles(fixture.web1Data).includes(`${fixture.generatedStaticAssetId}.glb`), false);
    const transitionHistory = await readDurablePublishedState(fixture, transitionId, dbEnv);
    assert.equal(transitionHistory.activeRevision, 4, 'the final generated revision is durably active');
    assert.deepEqual(transitionHistory.history.map((revision) => revision.revision), [0, 1, 2, 3, 4],
      'the static, generated, custom, explicit 2D, and generated revisions remain immutable in history');
    assert.equal(transitionHistory.history[0].document.modelAssetId, fixture.generatedStaticAssetId);
    assert.equal(transitionHistory.history[1].document.proceduralRoom, 'simple-rectangle-v1');
    assert.equal(transitionHistory.history[2].document.modelAssetId, transitionModelAssetId);
    assert.equal(transitionHistory.history[3].document.modelAssetId, undefined);
    assert.equal(transitionHistory.history[4].document.proceduralRoom, 'simple-rectangle-v1');
    stage('generated source integrated file and PostgreSQL lifecycle', {
      locationId: transitionId, persistence: PROFILE, transitions: ['legacy-static', 'generated', 'uploaded-GLB', 'explicit-2D', 'generated'],
      privateSaveSurvivesEdgeRestart: true, oldPublicationStayedActiveUntilPublish: true,
      generatedWithWebTargetOffline: 'published without GLB ACK', generatedAssetTransfers: 0,
      customTargetAcks: 2, activeRevision: 4, history: [0, 1, 2, 3, 4],
    });

    const consoleEdit = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', '/api/locations/iw-intern-demo/drafts', { expectedPublishedRevision: 0 });
    assert.equal(consoleEdit.response.status, 201, 'the server-managed console seed can be edited without changing visibility');
    const consoleUpload = await managerUpload(edgeBase, managers['qa-admin-a'], consoleEdit.body.data.draftId,
      'model', consoleEdit.body.data.draftRevision, modelBytes, 'console-only.glb', 'model/gltf-binary');
    assert.equal(consoleUpload.response.status, 200);
    const consolePublished = await managerJson(edgeBase, managers['qa-admin-a'], 'POST', `/api/locations/drafts/${consoleEdit.body.data.draftId}/publications`, {
      expectedDraftRevision: consoleUpload.body.data.draftRevision, expectedPublishedRevision: 0,
    });
    assert.equal(consolePublished.response.status, 200, 'console-only model publication does not require web delivery');
    const consoleAssetId = consoleUpload.body.data.assetId;
    assert.equal((await fetch(`${web1Base}/api/models/${consoleAssetId}`, { headers: { cookie: studentCookie } })).status, 404);
    assert.equal(readdirSync(join(fixture.web1Data, 'published-models')).includes(`${consoleAssetId}.glb`), false,
      'console-only model bytes remain on the edge and do not transfer to student web');
    stage('legacy-static and console-only model boundaries', { legacyStatic: 'omitted/no transfer', consoleModel: 'edge-local/no transfer', visibilityReadOnly: true });

    const bEdit = await managerJson(edgeBase, managers['qa-operator-b'], 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 2 });
    assert.equal(bEdit.response.status, 201);
    const bDraftId = bEdit.body.data.draftId;
    const bDetail = await getJson(edgeBase, `/api/locations/drafts/${bDraftId}`, managers['qa-operator-b']);
    assert.equal(bDetail.body.data.assetCapabilities.modelAssetId.fromPublishedBase, true);
    assert.equal(bDetail.body.data.assetCapabilities.planAssetId.source, 'upload');
    assert.equal(bDetail.body.data.assetCapabilities.planAssetId.previewAvailable, true);
    const bPreview = await fetch(`${edgeBase}/api/locations/drafts/${bDraftId}/assets/${modelAssetId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(bPreview.status, 200, 'manager B previews only the exact asset pinned by the published base');
    assert.deepEqual(Buffer.from(await bPreview.arrayBuffer()), modelBytes);
    const bPlanPreview = await fetch(`${edgeBase}/api/locations/drafts/${bDraftId}/assets/${planUpload.body.data.assetId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(bPlanPreview.status, 200, 'manager B previews the exact inherited plan through the owned draft');
    assert.deepEqual(Buffer.from(await bPlanPreview.arrayBuffer()), PNG);
    const bPose = { ...bDetail.body.data.document.sensorAssignments[0].pose, x: 410 };
    const bSaved = await saveRenamedDraft(edgeBase, managers['qa-operator-b'], bDraftId, bDetail.body.data, 'QA Published Location B', {
      sensorAssignments: [{ ...bDetail.body.data.document.sensorAssignments[0], pose: bPose }],
    });
    assert.equal(bSaved.draftRevision, 2);
    const bLiveSensorsBeforePublish = await getJson(edgeBase, `/api/locations/drafts/${bDraftId}/sensors`, managers['qa-operator-b']);
    assert.equal(bLiveSensorsBeforePublish.body.data.sensors.find((item) => item.uid === SENSOR_UID).pose.x, sensor.pose.x,
      'manager B draft pose remains private until publication');
    const publicAfterBPrivateSave = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    assert.equal(publicAfterBPrivateSave.floors.find((floor) => floor.id === locationId).name, 'QA Published Location',
      'manager B private save does not change the published floor');
    assert.equal(publicAfterBPrivateSave.floors.find((floor) => floor.id === locationId).model.assetId, modelAssetId,
      'manager B private save does not replace the active student model');
    assert.equal((await getJson(edgeBase, '/api/locations', managers['qa-admin-a'])).body.data.published
      .find((item) => item.locationId === locationId).activeRevision, 2, 'manager B private save does not advance the active revision');
    const bReload = await getJson(edgeBase, `/api/locations/drafts/${bDraftId}`, managers['qa-operator-b']);
    assert.equal(bReload.body.data.assetCapabilities.modelAssetId.fromPublishedBase, true);
    assert.equal(bReload.body.data.assetCapabilities.modelAssetId.displayName, 'QA replacement.glb');
    assert.equal(JSON.stringify(bReload.body.data).includes('qa-admin-a'), false, 'private owner IDs are not returned in capability DTOs');
    const bPublish = await managerJson(edgeBase, managers['qa-operator-b'], 'POST', `/api/locations/drafts/${bDraftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 2,
    });
    assert.equal(bPublish.response.status, 200, 'manager B can publish the exact inherited asset without ownership transfer');
    const bLiveSensorsAfterPublish = await getJson(edgeBase, `/api/locations/drafts/${bDraftId}/sensors`, managers['qa-operator-b']);
    assert.deepEqual(bLiveSensorsAfterPublish.body.data.sensors.find((item) => item.uid === SENSOR_UID).pose, bPose,
      'manager B sensor pose becomes live only after its publication');

    edge.stop();
    await edge.wait();
    edge = null;
    edge = startEdge();
    await waitHttp(`${edgeBase}/login`, 200, edge, 'edge restarted between manager B and C edits');
    managers['qa-operator-b'] = await loginManager(edgeBase, 'qa-operator-b');
    managers['qa-admin-c'] = await loginManager(edgeBase, 'qa-admin-c');
    const bAfterRestart = await getJson(edgeBase, `/api/locations/drafts/${bDraftId}`, managers['qa-operator-b']);
    assert.equal(bAfterRestart.response.status, 200, 'manager B draft and exact-base asset provenance survive an edge restart');
    assert.equal(bAfterRestart.body.data.assetCapabilities.modelAssetId.fromPublishedBase, true);
    assert.equal(bAfterRestart.body.data.assetCapabilities.planAssetId.previewAvailable, true);
    for (const assetId of [modelAssetId, planUpload.body.data.assetId]) {
      const reopenedPreview = await fetch(`${edgeBase}/api/locations/drafts/${bDraftId}/assets/${assetId}`, { headers: { cookie: managers['qa-operator-b'] } });
      assert.equal(reopenedPreview.status, 200, 'inherited plan/model preview remains authorized after edge restart');
      assert.deepEqual(Buffer.from(await reopenedPreview.arrayBuffer()), assetId === modelAssetId ? modelBytes : PNG);
    }
    assert.equal((await getJson(edgeBase, '/api/locations', managers['qa-admin-c'])).body.data.published
      .find((item) => item.locationId === locationId).activeRevision, 3);
    evidence.processRestarts.push({ process: 'edge between B and C edits', publishedRevision: 3, draftOwner: 'qa-operator-b', inheritedAssets: 2 });

    const cEdit = await managerJson(edgeBase, managers['qa-admin-c'], 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 3 });
    assert.equal(cEdit.response.status, 201);
    const cDetail = await getJson(edgeBase, `/api/locations/drafts/${cEdit.body.data.draftId}`, managers['qa-admin-c']);
    assert.equal(cDetail.body.data.assetCapabilities.modelAssetId.fromPublishedBase, true);
    assert.equal(cDetail.body.data.assetCapabilities.planAssetId.previewAvailable, true);
    const cPreview = await fetch(`${edgeBase}/api/locations/drafts/${cEdit.body.data.draftId}/assets/${modelAssetId}`, { headers: { cookie: managers['qa-admin-c'] } });
    assert.equal(cPreview.status, 200, 'manager C can reuse the still-pinned original asset from manager A');
    assert.deepEqual(Buffer.from(await cPreview.arrayBuffer()), modelBytes);
    const cPlanPreview = await fetch(`${edgeBase}/api/locations/drafts/${cEdit.body.data.draftId}/assets/${planUpload.body.data.assetId}`, { headers: { cookie: managers['qa-admin-c'] } });
    assert.equal(cPlanPreview.status, 200, 'manager C previews the exact inherited plan without asset ownership transfer');
    assert.deepEqual(Buffer.from(await cPlanPreview.arrayBuffer()), PNG);
    const cPose = { ...cDetail.body.data.document.sensorAssignments[0].pose, x: 420 };
    const cSave = await saveRenamedDraft(edgeBase, managers['qa-admin-c'], cEdit.body.data.draftId, cDetail.body.data, 'QA Published Location C', {
      sensorAssignments: [{ ...cDetail.body.data.document.sensorAssignments[0], pose: cPose }],
    });
    assert.equal(cSave.draftRevision, 2);
    const cLiveSensorsBeforePublish = await getJson(edgeBase, `/api/locations/drafts/${cEdit.body.data.draftId}/sensors`, managers['qa-admin-c']);
    assert.equal(cLiveSensorsBeforePublish.body.data.sensors.find((item) => item.uid === SENSOR_UID).pose.x, bPose.x,
      'manager C draft pose remains private until publication');
    const publicAfterCPrivateSave = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: studentCookie } }).then((r) => r.json());
    assert.equal(publicAfterCPrivateSave.floors.find((floor) => floor.id === locationId).name, 'QA Published Location B',
      'manager C private save does not change manager B published floor');
    assert.equal(publicAfterCPrivateSave.floors.find((floor) => floor.id === locationId).model.assetId, modelAssetId,
      'manager C private save does not change the active inherited model');
    assert.equal((await getJson(edgeBase, '/api/locations', managers['qa-admin-a'])).body.data.published
      .find((item) => item.locationId === locationId).activeRevision, 3, 'manager C private save does not advance the active revision');
    const cPublish = await managerJson(edgeBase, managers['qa-admin-c'], 'POST', `/api/locations/drafts/${cEdit.body.data.draftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 3,
    });
    assert.equal(cPublish.response.status, 200);
    const cLiveSensorsAfterPublish = await getJson(edgeBase, `/api/locations/drafts/${cEdit.body.data.draftId}/sensors`, managers['qa-admin-c']);
    assert.deepEqual(cLiveSensorsAfterPublish.body.data.sensors.find((item) => item.uid === SENSOR_UID).pose, cPose,
      'manager C sensor pose becomes live only after publication');
    const bAssetProbe = await fetch(`${edgeBase}/api/locations/drafts/${bDraftId}/assets/${privateAssetId}`, { headers: { cookie: managers['qa-operator-b'] } });
    assert.equal(bAssetProbe.status, 404);
    stage('A to B to C exact-base inheritance', { publishedRevision: 4, originalOwnerPreserved: true, planAndModelBytesPreserved: true, privateAssetDenied: true });

    const staleB = await managerJson(edgeBase, managers['qa-operator-b'], 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 4 });
    const staleC = await managerJson(edgeBase, managers['qa-admin-c'], 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 4 });
    assert.equal(staleB.response.status, 201);
    assert.equal(staleC.response.status, 201);
    const staleBDetail = await getJson(edgeBase, `/api/locations/drafts/${staleB.body.data.draftId}`, managers['qa-operator-b']);
    const staleCD = await getJson(edgeBase, `/api/locations/drafts/${staleC.body.data.draftId}`, managers['qa-admin-c']);
    await saveRenamedDraft(edgeBase, managers['qa-operator-b'], staleB.body.data.draftId, staleBDetail.body.data, 'QA Concurrent Winner');
    await saveRenamedDraft(edgeBase, managers['qa-admin-c'], staleC.body.data.draftId, staleCD.body.data, 'QA Stale Loser');
    const winnerRevision = 2;
    const concurrentPublishes = await Promise.all([
      managerJson(edgeBase, managers['qa-operator-b'], 'POST', `/api/locations/drafts/${staleB.body.data.draftId}/publications`, {
        expectedDraftRevision: winnerRevision, expectedPublishedRevision: 4,
      }),
      managerJson(edgeBase, managers['qa-admin-c'], 'POST', `/api/locations/drafts/${staleC.body.data.draftId}/publications`, {
        expectedDraftRevision: winnerRevision, expectedPublishedRevision: 4,
      }),
    ]);
    assert.deepEqual(concurrentPublishes.map((result) => result.response.status).sort(), [200, 409],
      'truly concurrent same-base publication requests yield one winner and one conflict');
    const successfulConcurrentPublish = concurrentPublishes.find((result) => result.response.status === 200);
    assert.equal(successfulConcurrentPublish.body.data.publishedRevision, 5);
    const activeAfterConflict = await getJson(edgeBase, '/api/locations', managers['qa-admin-a']);
    const activeWinner = activeAfterConflict.body.data.published.find((item) => item.locationId === locationId);
    assert.equal(activeWinner.activeRevision, 5);
    assert.ok(['QA Concurrent Winner', 'QA Stale Loser'].includes(activeWinner.name));
    assert.equal(successfulConcurrentPublish.body.data.locationId, locationId);
    stage('concurrent stale-base conflict', { winnerRevision: 5, statuses: concurrentPublishes.map((result) => result.response.status).sort(), oneCompleteWinner: true });

    const studentBeforeRestart = await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: studentCookie } });
    assert.equal(studentBeforeRestart.status, 200);
    await captureStudentBrowser({
      webBase: web1Base, cookieValue: student1, siteId: 'hku-innowing', floorId: locationId, modelAssetId, artifacts, evidence,
      privateValues: [privateAssetId, planUpload.body.data.assetId, 'QA full workflow.glb', 'QA replacement.glb', SENSOR_UID,
        draftId, privateAssetDraft.body.data.draftId, 'qa-admin-a'],
      browserSlot: (value) => { browser = value; }, contextSlot: (value) => { browserContext = value; },
    });

    await exercisePublishedFurnitureWorkflow({
      edgeBase, web1Base, web2Base, edge, fixture,
      workflow: furnitureWorkflow, furnitureAssetIds: task5FurnitureAssetIds, managerCookie: await loginManager(edgeBase, 'qa-admin-a'),
      operatorCookie: await loginManager(edgeBase, 'qa-operator-b'),
      studentCookie: `tm_session=${await loginStudent(web1Base)}`,
      student2Cookie: `tm_session=${await loginStudent(web2Base)}`,
      artifacts, evidence, stage, snapshotProxies: [web1PushProxy, web2PushProxy],
      edgeControl: {
        stop: async () => { edge.stop(); await edge.wait(); edge = null; },
        restart: async () => {
          edge = startEdge();
          await waitHttp(`${edgeBase}/login`, 200, edge, 'edge restarted for furniture snapshot replay');
          return edge;
        },
      },
      web2Control: {
        stop: async () => { web2.stop(); await web2.wait(); web2 = null; },
        restart: async () => { web2 = spawnOwned('web-target-2', 'dist/src/web/main.js', [], webEnv(ports.web2, fixture.web2Data, 'target-two'), processes, gracefulStopModule); await waitHttp(`${web2Base}/login/`, 200, web2, 'second target recovered for furniture retry'); },
      },
    });

    const reportIdentity = identity(SENSOR_UID);
    const rectangleSeats = authored.tables.find((table) => table.id === 'qa-rect').seats;
    await sendSignedReports(ports.edgeUdp, reportIdentity, [], 1);
    await waitForStudentTable(web1Base, studentCookie, locationId, (table) => table.status === 'ok' && table.occupied === 0 && table.free === 3,
      edge, 'signed empty reports produce a known-free public table state');
    await waitForStudentTable(web2Base, student2Cookie, locationId, (table) => table.status === 'ok' && table.occupied === 0 && table.free === 3,
      edge, 'signed empty reports reach the second student web target');
    const knownFree = await studentTable(web1Base, studentCookie, locationId);
    const secondTargetKnownFree = await studentTable(web2Base, student2Cookie, locationId);
    assert.equal(knownFree.status, 'ok');
    assert.equal(knownFree.occupied, 0);
    assert.equal(knownFree.free, 3);
    assert.equal(secondTargetKnownFree.free, 3);
    stage('actual signed edge report produces known-free student state', { transport: 'UDP', frames: 6, free: 3, occupied: 0, targets: 2 });

    const seatedDetections = rectangleSeats.map((seat) => personAt(sensor.pose, seat.x, seat.y));
    await sendSignedReports(ports.edgeUdp, reportIdentity, seatedDetections, 7);
    await waitForStudentTable(web1Base, studentCookie, locationId, (table) => table.status === 'ok' && table.occupied === 3 && table.free === 0,
      edge, 'signed occupied reports produce a known-full public table state');
    await waitForStudentTable(web2Base, student2Cookie, locationId, (table) => table.status === 'ok' && table.occupied === 3 && table.free === 0,
      edge, 'signed occupied reports reach the second student web target');
    const knownFull = await studentTable(web1Base, studentCookie, locationId);
    const secondTargetKnownFull = await studentTable(web2Base, student2Cookie, locationId);
    assert.equal(knownFull.status, 'ok');
    assert.equal(knownFull.occupied, 3);
    assert.equal(knownFull.free, 0);
    assert.equal(secondTargetKnownFull.occupied, 3);
    stage('actual signed edge report produces known-full student state', { transport: 'UDP', frames: 6, free: 0, occupied: 3, targets: 2 });

    edge.stop();
    await edge.wait();
    edge = null;
    web1.stop(); await web1.wait(); web1 = null;
    web2.stop(); await web2.wait(); web2 = null;
    web1 = startWeb1(); web2 = startWeb2();
    await waitHttp(`${web1Base}/login/`, 200, web1, 'web target one restarted');
    await waitHttp(`${web2Base}/login/`, 200, web2, 'web target two restarted');
    const studentAfterWebRestart = await loginStudent(web1Base);
    const student2AfterWebRestart = await loginStudent(web2Base);
    const noSnapshotView = await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: `tm_session=${studentAfterWebRestart}` } }).then((r) => r.json());
    assert.equal(noSnapshotView.floors.length, 0, 'web restart resets in-memory snapshots while model bytes remain on disk');
    assert.equal((await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${studentAfterWebRestart}` } })).status, 404,
      'durable orphan bytes are denied until a new current snapshot references them');
    const noSnapshotView2 = await fetch(`${web2Base}/api/occupancy`, { headers: { cookie: `tm_session=${student2AfterWebRestart}` } }).then((r) => r.json());
    assert.equal(noSnapshotView2.floors.length, 0, 'the second web target also restarts with an empty in-memory SnapshotStore');
    assert.equal((await fetch(`${web2Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${student2AfterWebRestart}` } })).status, 404,
      'the second target denies its durable orphan bytes until a current snapshot references them');
    for (const dataDir of [fixture.web1Data, fixture.web2Data]) {
      const persistedModelPath = join(dataDir, 'published-models', `${modelAssetId}.glb`);
      assert.ok(statSync(persistedModelPath).isFile(), 'each web target retains its own durable model bytes across restart');
      assert.deepEqual(readFileSync(persistedModelPath), modelBytes, 'each target persisted the exact acknowledged bytes');
    }
    evidence.processRestarts.push({ process: 'web targets', stateBeforeSnapshot: 'both empty view/model denied', durableBytesPerTarget: true });

    edge = startEdge();
    await waitHttp(`${edgeBase}/login`, 200, edge, 'edge restarted');
    const restartedManager = await loginManager(edgeBase, 'qa-admin-a');
    await waitFor(async () => {
      const response = await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${studentAfterWebRestart}` } });
      return response.status === 200;
    }, edge, 'edge restart republishes the persisted active snapshot');
    await waitFor(async () => {
      const response = await fetch(`${web2Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${student2AfterWebRestart}` } });
      return response.status === 200;
    }, edge, 'edge restart republishes the persisted active snapshot to the second web target');
    const persistedList = await getJson(edgeBase, '/api/locations', restartedManager);
    assert.equal(persistedList.body.data.published.find((item) => item.locationId === locationId).activeRevision, 5,
      'published history/revision survives edge process restart');
    const persistedDrafts = await getJson(edgeBase, '/api/locations', restartedManager);
    assert.ok(persistedDrafts.body.data.drafts.some((draft) => draft.draftId === privateAssetDraft.body.data.draftId),
      'creator-private draft survives edge process restart');
    const pendingRequest = await fetch(`${edgeBase}/api/provision/request`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PROVISIONING_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ uid: PENDING_SENSOR_UID, label: 'Task 4.2 unapproved sensor', firmware: 'synthetic' }),
    });
    recordStatus('POST', '/api/provision/request', pendingRequest.status);
    assert.equal(pendingRequest.status, 202, 'the actual provisioning boundary accepts a request into the pending queue');
    assert.equal((await pendingRequest.json()).status, 'pending', 'the synthetic sensor is pending and remains unapproved');
    const pendingCheck = await managerJson(edgeBase, restartedManager, 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 5 });
    assert.equal(pendingCheck.response.status, 201);
    const sensorChoicesWithPending = await getJson(edgeBase, `/api/locations/drafts/${pendingCheck.body.data.draftId}/sensors`, restartedManager);
    assert.equal(sensorChoicesWithPending.body.data.sensors.some((item) => item.uid === PENDING_SENSOR_UID), false,
      'pending, unapproved provisioning requests are not eligible draft sensors');
    stage('pending sensor excluded from eligible draft choices', { status: pendingRequest.status, eligible: false });
    stage('edge and web process restart', { activeRevision: 5, draftRetained: true, modelDeniedUntilSnapshot: true, modelAllowedAfterSnapshot: true });

    const withdrawDraft = await managerJson(edgeBase, restartedManager, 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 5 });
    assert.equal(withdrawDraft.response.status, 201);
    const withdrawDetail = await getJson(edgeBase, `/api/locations/drafts/${withdrawDraft.body.data.draftId}`, restartedManager);
    const withdrawnDocument = { ...withdrawDetail.body.data.document };
    delete withdrawnDocument.modelAssetId;
    delete withdrawnDocument.modelTransform;
    const withdrawnSave = await managerJson(edgeBase, restartedManager, 'PUT', `/api/locations/drafts/${withdrawDraft.body.data.draftId}`, {
      expectedDraftRevision: 1, document: withdrawnDocument,
    });
    assert.equal(withdrawnSave.response.status, 200);
    const withdrawnPublish = await managerJson(edgeBase, restartedManager, 'POST', `/api/locations/drafts/${withdrawDraft.body.data.draftId}/publications`, {
      expectedDraftRevision: 2, expectedPublishedRevision: 5,
    });
    assert.equal(withdrawnPublish.response.status, 200);
    await waitFor(async () => (await fetch(`${web1Base}/api/occupancy`, { headers: { cookie: `tm_session=${studentAfterWebRestart}` } }).then((r) => r.json()))
      .floors.some((floor) => floor.id === locationId && floor.model === null), edge, 'model removal is represented as explicit 2D-only snapshot state');
    await waitFor(async () => (await fetch(`${web2Base}/api/occupancy`, { headers: { cookie: `tm_session=${student2AfterWebRestart}` } }).then((r) => r.json()))
      .floors.some((floor) => floor.id === locationId && floor.model === null), edge, 'model removal reaches the second web target');
    assert.equal((await fetch(`${web1Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${studentAfterWebRestart}` } })).status, 404,
      'withdrawn model bytes are no longer authorized by the winning snapshot');
    assert.equal((await fetch(`${web2Base}/api/models/${modelAssetId}`, { headers: { cookie: `tm_session=${student2AfterWebRestart}` } })).status, 404,
      'the second target also denies the withdrawn model after its winning snapshot changes');
    stage('public model withdrawal', { publishedRevision: 6, publicModel: null, oldBytesDenied: true });

    if (PROFILE === 'postgres') {
      edge.stop(); await edge.wait(); edge = null;
      const removedFurnitureAssets = await cleanupTask5FurnitureAssetRows(dbEnv, [...task5FurnitureAssetIds]);
      task5FurnitureAssetsCleaned = true;
      evidence.migrations.push({ direction: 'test-fixture-cleanup', furnitureRowsRemoved: removedFurnitureAssets, result: 'PASS' });
      const downCount = migrationCount;
      for (let i = 0; i < downCount; i++) {
        await runTool('dist/src/tools/postgres-migrate.js', ['down'], { ...dbEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only' });
        migrationCount -= 1;
      }
      migrationDownCount = downCount;
      evidence.migrations.push({ direction: 'down', count: downCount, result: 'PASS' });
      const check = await inspectPostgresCleanup(dbEnv);
      assert.equal(check.registeredNodes, null, 'the migration rollback removes the task-owned application schema');
      assert.equal(check.migrationRows, 0, 'the synthetic migration ledger is empty after the down run');
      assert.deepEqual(check.publicTables, ['migrations'], 'migration rollback restores the exact public-table baseline');
      migrationCount = 0;
    }
    stage('clean profile shutdown', { edge: true, webTargets: 2, pgMigrationDownCount: migrationDownCount, pgCleanup: PROFILE === 'postgres' ? `${migrationDownCount} migrations down` : 'not applicable' });
    writeFileSync(join(artifacts, `workflow-${PROFILE}-evidence.json`), JSON.stringify(evidence, null, 2));
  } catch (error) {
    stage('failure', { name: error instanceof Error ? error.name : 'unknown' });
    if (browserContext && artifacts) await browserContext.tracing.stop({ path: join(artifacts, `workflow-${PROFILE}-failure.trace.zip`) }).catch(() => {});
    writeFileSync(join(artifacts, `workflow-${PROFILE}-failure.json`), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    globalThis.__task42Evidence = undefined;
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const child of [...processes]) child.stop();
    await Promise.all([...processes].map((child) => child.wait().catch(() => {})));
    await closeHttpServer(web1PushProxy?.server);
    await closeHttpServer(web2PushProxy?.server);
    if (PROFILE === 'postgres' && migrationCount > 0) {
      let remainingMigrations = 0;
      if (!task5FurnitureAssetsCleaned && task5FurnitureAssetIds.size > 0) {
        try {
          const removedFurnitureAssets = await cleanupTask5FurnitureAssetRows(postgresEnvironment(), [...task5FurnitureAssetIds]);
          task5FurnitureAssetsCleaned = true;
          evidence.migrations.push({ direction: 'test-fixture-cleanup', furnitureRowsRemoved: removedFurnitureAssets, result: 'PASS' });
        } catch {
          evidence.migrations.push({ direction: 'test-fixture-cleanup', result: 'FAIL', failure: 'exact furniture-row cleanup failed' });
        }
      }
      const beforeDown = await inspectPostgresCleanup(postgresEnvironment()).catch(() => null);
      remainingMigrations = Number(beforeDown?.migrationRows ?? 0);
      const lastKnownRemainingMigrations = migrationCount;
      if (remainingMigrations <= lastKnownRemainingMigrations) {
        migrationCount = remainingMigrations;
        for (let i = 0; i < remainingMigrations; i++) {
          try {
            await runTool('dist/src/tools/postgres-migrate.js', ['down'], {
              ...postgresEnvironment(), PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only',
            });
            remainingMigrations -= 1;
            migrationCount = remainingMigrations;
          } catch {
            break;
          }
        }
      }
      const cleanup = await inspectPostgresCleanup(postgresEnvironment()).catch(() => null);
      if (cleanup) migrationCount = cleanup.migrationRows;
      if (cleanup?.registeredNodes === null && cleanup?.migrationRows === 0
        && JSON.stringify(cleanup.publicTables) === JSON.stringify(['migrations'])) migrationCount = 0;
    }
    // Keep only this run's deterministic evidence and fixture data until the task report is archived.
  }
});

function createFixtureFiles(runDir) {
  const edgeData = join(runDir, 'edge-data');
  const web1Data = join(runDir, 'web-target-1-data');
  const web2Data = join(runDir, 'web-target-2-data');
  for (const path of [edgeData, web1Data, web2Data]) mkdirSync(path, { recursive: true });
  const site = JSON.parse(readFileSync('config/site.json', 'utf8'));
  const seedFloorIds = site.floors.map((floor) => floor.id);
  const staticAssetId = '4a0c1020-54cb-4a39-8d73-9f27fd1b7a99';
  const generatedStaticAssetId = '7b2c0300-9a21-4b03-8ad2-3213b27ab099';
  site.floors.push({
    id: 'qa-legacy-static', building: 'Legacy model test', name: 'Legacy static reference', width: 400, height: 300,
    outline: [[-10, -10], [410, -10], [400, 300], [0, 300]],
    zones: [{ id: 'qa-legacy-zone', name: 'Legacy room', polygon: [[-10, -10], [410, -10], [400, 300]] }],
    tables: [{ id: 'qa-legacy-table', name: 'Wall table', zone: 'qa-legacy-zone', x: 0, y: 100, width: 40, height: 60, capacity: 3 }],
    model: { assetId: staticAssetId, transform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } } },
  });
  site.floors.push({
    id: 'qa-generated-transition', building: 'Generated source test', name: 'Generated transition fixture', width: 400, height: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'qa-generated-zone', name: 'Generated test room', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{ id: 'qa-generated-table', name: 'Generated test table', zone: 'qa-generated-zone', x: 160, y: 110, width: 80, height: 60, capacity: 2 }],
    model: { assetId: generatedStaticAssetId, transform: structuredClone(LOCATION_TRANSFORM) },
  });
  const nodes = JSON.parse(readFileSync('config/nodes.json', 'utf8'));
  const seedNodes = structuredClone(nodes.nodes);
  nodes.nodes.push({ uid: SENSOR_UID, label: 'Task 4.2 approved unplaced sensor', owns: [], simulated: false, rgb: false, detector: 'node' });
  const sitePath = join(runDir, 'site.json');
  const nodesPath = join(runDir, 'nodes.json');
  writeFileSync(sitePath, JSON.stringify(site, null, 2));
  writeFileSync(nodesPath, JSON.stringify(nodes, null, 2));
  const publicSeedFloorIds = site.floors.filter((floor) => floor.visibility !== 'console').map((floor) => floor.id);
  return { edgeData, web1Data, web2Data, site, nodes, sitePath, nodesPath, staticAssetId, generatedStaticAssetId, seedFloorIds, publicSeedFloorIds, seedNodes };
}

function publishedModelFiles(dataDir) {
  return readdirSync(join(dataDir, 'published-models')).filter((name) => name.endsWith('.glb')).sort();
}

async function readDurablePublishedState(fixture, locationId, pgEnv) {
  if (PROFILE === 'file') {
    const registry = JSON.parse(readFileSync(fixture.nodesPath, 'utf8'));
    const persisted = registry.publishedLocations.find((item) => item.locationId === locationId);
    const seedFloor = fixture.site.floors.find((item) => item.id === locationId);
    assert.ok(seedFloor, `file fixture retains the revision-zero seed for ${locationId}`);
    return {
      activeRevision: persisted?.activeRevision ?? 0,
      // File mode derives immutable revision zero from the seed site config; NODES_CONFIG stores only authored overrides.
      history: [
        { revision: 0, document: { modelAssetId: seedFloor.model?.assetId } },
        ...(persisted?.revisions ?? []),
      ],
    };
  }
  const source = await openPostgres(loadPostgresConnectionConfig('runtime', pgEnv));
  try {
    const coordinator = new PostgresRegistryMutationCoordinator(source);
    const repository = new PostgresPublishedLocationRepository(source, new Set(), coordinator);
    const persisted = await repository.getActive(locationId);
    assert.ok(persisted, `fresh PostgreSQL repository connection contains ${locationId} publication history`);
    return persisted;
  } finally { await closePostgres(source); }
}

function postgresEnvironment() {
  return {
    PGHOST: '127.0.0.1', PGPORT: '50928', PGDATABASE: 'wizard_storage_test',
    PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only',
    PG_RUNTIME_USER: 'wizard_runtime', PG_RUNTIME_PASSWORD: 'task5-unused-runtime-validation-only',
  };
}

async function seedPostgresNodes(site, nodesConfig, pgEnv) {
  const registry = buildRegistry(site, nodesConfig);
  const records = [...registry.nodes.values()].map((node) => ({
    uid: node.uid, label: node.label, floorId: node.floorId, pose: node.pose,
    owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
  }));
  const source = await openPostgres(loadPostgresConnectionConfig('runtime', pgEnv));
  try {
    const coordinator = new PostgresRegistryMutationCoordinator(source);
    const repository = new PostgresRegistryRepository(source, coordinator);
    const result = await coordinator.withMutationLock(() => repository.importNodes(records));
    assert.equal(result.inserted, records.length, 'fresh synthetic database receives fixture nodes through the real PG repository');
  } finally { await closePostgres(source); }
}

async function inspectPostgresCleanup(pgEnv) {
  const source = await openPostgres(loadPostgresConnectionConfig('migrator', {
    ...pgEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only',
  }));
  try {
    const rows = await source.query("SELECT to_regclass('public.registered_nodes') AS registered_nodes, CASE WHEN to_regclass('public.migrations') IS NULL THEN 0 ELSE (SELECT count(*)::int FROM public.migrations) END AS migration_rows, COALESCE((SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'), '[]'::json) AS public_tables");
    return {
      registeredNodes: rows[0]?.registered_nodes ?? null,
      migrationRows: Number(rows[0]?.migration_rows ?? 0),
      publicTables: rows[0]?.public_tables ?? [],
    };
  } finally { await closePostgres(source); }
}

async function cleanupTask5FurnitureAssetRows(pgEnv, assetIds) {
  const expectedAssetIds = [...new Set(assetIds.map((assetId) => assetId.toLowerCase()))].sort();
  if (expectedAssetIds.length === 0) return 0;
  const source = await openPostgres(loadPostgresConnectionConfig('migrator', {
    ...pgEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'task5-unused-migration-validation-only',
  }));
  try {
    const table = await source.query("SELECT to_regclass('public.location_assets') AS location_assets");
    if (table[0]?.location_assets === null) return 0;
    const rows = await source.query(
      `SELECT asset_id, creator_id, purpose, furniture_type, display_name, created_at
       FROM public.location_assets WHERE asset_id = ANY($1::uuid[]) ORDER BY asset_id`,
      [expectedAssetIds],
    );
    const foundAssetIds = rows.map((row) => String(row.asset_id).toLowerCase()).sort();
    assert.ok(foundAssetIds.every((assetId) => expectedAssetIds.includes(assetId)),
      'cleanup rows are limited to suite-tracked furniture UUIDs');
    const expectedTypeByName = new Map([
      ['Task 5 private table asset.glb', 'table'],
      ['Task 5 private chair asset.glb', 'chair'],
      ['Task 5 retry table candidate', 'table'],
    ]);
    for (const row of rows) {
      assert.equal(row.creator_id, 'qa-admin-a', 'only the synthetic Task5 uploader owns a tracked cleanup row');
      assert.equal(row.purpose, 'furniture', 'tracked cleanup rows are immutable furniture metadata');
      assert.equal(row.furniture_type, expectedTypeByName.get(row.display_name),
        'tracked display-name/type metadata matches this suite upload');
      assert.ok(Number(row.created_at) > 0, 'tracked metadata retains its creation timestamp');
    }
    const remainingFurniture = await source.query(
      "SELECT count(*)::int AS count FROM public.location_assets WHERE purpose = 'furniture'",
    );
    if (rows.length === 0) {
      assert.equal(Number(remainingFurniture[0]?.count ?? -1), 0,
        'an idempotent cleanup may return early only when the fixture has no furniture rows');
    }
    const trigger = await source.query(
      'SELECT tgenabled FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal',
      ['public.location_assets', 'location_assets_immutable'],
    );
    assert.equal(trigger.length, 1, 'the expected immutable asset trigger exists before test cleanup');
    assert.equal(trigger[0].tgenabled, 'O', 'the immutable asset trigger is enabled before test cleanup');
    if (rows.length > 0) {
      await source.transaction(async (manager) => {
        await manager.query('ALTER TABLE public.location_assets DISABLE TRIGGER location_assets_immutable');
        try {
          await manager.query(
            "DELETE FROM public.location_assets WHERE purpose = 'furniture' AND creator_id = $1 AND asset_id = ANY($2::uuid[]) RETURNING asset_id",
            ['qa-admin-a', foundAssetIds],
          );
        } finally {
          await manager.query('ALTER TABLE public.location_assets ENABLE TRIGGER location_assets_immutable');
        }
      });
    }
    const triggerAfter = await source.query(
      'SELECT tgenabled FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal',
      ['public.location_assets', 'location_assets_immutable'],
    );
    assert.equal(triggerAfter.length, 1);
    assert.equal(triggerAfter[0].tgenabled, 'O', 'the immutable asset trigger is re-enabled after exact fixture cleanup');
    const remaining = await source.query(
      'SELECT count(*)::int AS count FROM public.location_assets WHERE asset_id = ANY($1::uuid[])',
      [expectedAssetIds],
    );
    assert.equal(Number(remaining[0]?.count ?? -1), 0, 'no tracked Task5 furniture metadata rows remain');
    const remainingFurnitureAfterCleanup = await source.query(
      "SELECT count(*)::int AS count FROM public.location_assets WHERE purpose = 'furniture'",
    );
    assert.equal(Number(remainingFurnitureAfterCleanup[0]?.count ?? -1), 0,
      'the clean-profile fixture has no untracked furniture metadata before migration rollback');
    return rows.length;
  } finally {
    await closePostgres(source);
  }
}

function processEnvironment(extra) {
  const clean = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[key] !== undefined) clean[key] = process.env[key];
  }
  return { ...clean, NODE_ENV: 'test', ...extra };
}

function spawnOwned(label, file, args, env, processes, gracefulStopModule) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(gracefulStopModule)).href, resolve(file), ...args], {
    cwd: process.cwd(), env: processEnvironment(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = keepTail(stdout + chunk); });
  child.stderr.on('data', (chunk) => { stderr = keepTail(stderr + chunk); });
  let exit;
  const done = new Promise((resolveDone) => child.once('exit', (code, signal) => { exit = { code, signal }; resolveDone(exit); }));
  const handle = {
    label, child,
    get exit() { return exit; },
    get diagnostic() {
      const lines = (value) => value.split(/\r?\n/).filter(Boolean);
      const stderrLines = lines(stderr);
      return `${label} exited (${exit?.code ?? 'running'}); stdout-lines=${lines(stdout).slice(-3).map(sanitizeProcessLine).join(' | ')}; stderr-lines=${[...stderrLines.slice(0, 2), ...stderrLines.slice(-3)].map(sanitizeProcessLine).join(' | ')}`;
    },
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write('TASK42_STOP\n');
      const fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 5000);
      fallback.unref();
      child.once('exit', () => clearTimeout(fallback));
    },
    wait: async () => { await done; processes.delete(handle); },
  };
  processes.add(handle);
  return handle;
}

async function runTool(relativeFile, args, env) {
  const child = spawn(process.execPath, [resolve(relativeFile), ...args], {
    cwd: process.cwd(), env: processEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = keepTail(stdout + chunk); });
  child.stderr.on('data', (chunk) => { stderr = keepTail(stderr + chunk); });
  const [code] = await new Promise((resolveDone) => child.once('exit', (status, signal) => resolveDone([status, signal])));
  assert.equal(code, 0, `${relativeFile} ${args[0]} failed; stdout=${stdout.trim()}; stderr=${stderr.trim()}`);
  return { stdout, stderr };
}

async function waitHttp(url, expectedStatus, processHandle, label, timeoutMs = 30_000) {
  await waitFor(async () => {
    if (processHandle.exit) throw new Error(processHandle.diagnostic);
    try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status === expectedStatus; }
    catch { return false; }
  }, processHandle, label, timeoutMs);
}

async function waitFor(predicate, processHandle, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle?.exit) throw new Error(processHandle.diagnostic);
    const result = await predicate();
    if (result) return result;
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${label}${processHandle ? `; ${processHandle.diagnostic}` : ''}`);
}

async function sendSignedReports(port, sender, detections, firstFrame) {
  const socket = createSocket('udp4');
  try {
    for (let index = 0; index < 6; index += 1) {
      const packet = report(sender, detections, firstFrame + index);
      await new Promise((resolveSend, rejectSend) => {
        socket.send(packet, port, '127.0.0.1', (error) => error ? rejectSend(error) : resolveSend());
      });
      await delay(25);
    }
  } finally {
    await new Promise((resolveClose) => socket.close(resolveClose));
  }
}

async function waitForStudentTable(webBase, cookie, floorId, predicate, processHandle, label) {
  await waitFor(async () => predicate(await studentTable(webBase, cookie, floorId)), processHandle, label);
}

async function studentTable(webBase, cookie, floorId) {
  const response = await fetch(`${webBase}/api/occupancy`, { headers: { cookie } });
  assert.equal(response.status, 200, 'signed student occupancy API remains available during live reports');
  const view = await response.json();
  const floor = view.floors.find((item) => item.siteId === 'hku-innowing' && item.id === floorId);
  assert.ok(floor, 'the composite location remains in the student occupancy view');
  const table = floor.tables.find((item) => item.id === 'qa-rect');
  assert.ok(table, 'the authored rectangle remains in the student occupancy view');
  return table;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function availableUdpPort() {
  const socket = createSocket('udp4');
  await new Promise((resolveBind, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolveBind); });
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  return port;
}

async function loginManager(base, username) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password: MANAGER_PASSWORD }),
  });
  assert.equal(response.status, 200, `${username} manager login is signed`);
  const cookie = cookieValue(response.headers.get('set-cookie'), 'tm_algo');
  assert.ok(cookie, `${username} received a manager session cookie`);
  return `tm_algo=${cookie}`;
}

async function loginStudent(base) {
  const response = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: STUDENT_EMAIL, password: STUDENT_PASSWORD }),
  });
  assert.equal(response.status, 200, 'synthetic student login is signed');
  return cookieValue(response.headers.get('set-cookie'), 'tm_session');
}

function cookieValue(header, name) {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(header ?? '');
  return match?.[1] ?? '';
}

async function managerJson(base, cookie, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, 'x-tm-algo': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  recordStatus(method, path, response.status);
  let json;
  try { json = await response.json(); } catch { json = null; }
  return { response, body: json };
}

async function getJson(base, path, cookie) {
  const response = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  recordStatus('GET', path, response.status);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function recordStatus(method, path, status) {
  const target = globalThis.__task42Evidence;
  if (target) target.http.push({ method, path: routeLabel(path), status });
}

async function managerUpload(base, cookie, draftId, purpose, revision, bytes, displayName, mediaType = 'image/png') {
  const headers = { cookie, origin: base, 'x-tm-algo': '1', 'content-type': mediaType, 'if-match': String(revision) };
  if (displayName) headers['x-asset-display-name'] = encodeURIComponent(displayName);
  const response = await fetch(`${base}/api/locations/drafts/${draftId}/assets/${purpose}`, { method: 'PUT', headers, body: bytes });
  recordStatus('PUT', `/api/locations/drafts/{draftId}/assets/${purpose}`, response.status);
  return { response, body: await response.json().catch(() => null) };
}

async function saveRenamedDraft(base, cookie, draftId, detail, name, updates = {}) {
  const document = { ...detail.document, ...updates, name };
  const saved = await managerJson(base, cookie, 'PUT', `/api/locations/drafts/${draftId}`, {
    expectedDraftRevision: detail.draftRevision, document,
  });
  assert.equal(saved.response.status, 200, `private save for ${name} succeeds`);
  return saved.body.data;
}

async function captureStudentBrowser({ webBase, cookieValue: studentCookie, siteId, floorId, modelAssetId, artifacts, evidence, privateValues, browserSlot, contextSlot }) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addCookies([{ name: 'tm_session', value: studentCookie, url: webBase }]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  browserSlot(browser); contextSlot(context);
  const page = await context.newPage();
  const payloadChecks = [];
  page.on('pageerror', (error) => evidence.browser.pageErrors.push(error.name));
  page.on('console', (message) => { if (message.type() === 'error') evidence.browser.consoleErrors.push({ text: message.text().slice(0, 400), location: message.location().url }); });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === webBase) evidence.browser.network.push({ event: 'request', method: request.method(), path: routeLabel(url.pathname) });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === webBase) {
      evidence.browser.network.push({ event: 'response', status: response.status(), path: routeLabel(url.pathname) });
      if (url.pathname === '/api/occupancy' || url.pathname === '/api/search') {
        payloadChecks.push(response.text().then((body) => {
          const leaks = privateValues.filter((value) => body.includes(value));
          evidence.browser.publicPayloadChecks.push({ path: routeLabel(url.pathname), leaks });
        }));
      }
    }
  });
  await page.goto(`${webBase}/dashboard/`);
  await page.getByTestId('student-location-search').waitFor();
  await page.goto(`${webBase}/dashboard/spaces/${encodeURIComponent(siteId)}/${encodeURIComponent(floorId)}`);
  assert.equal(await page.getByRole('radio', { name: '3D view', exact: true }).isChecked(), true,
    'a fresh student context starts with its default 3D room view');
  await page.getByTestId('student-model-viewer-canvas').waitFor();
  await page.waitForFunction(() => !!document.querySelector('floor-viewer')?._model);
  const modelState = await page.evaluate(() => {
    const viewer = document.querySelector('floor-viewer');
    const plate = viewer?._authoredTableRecords?.get('qa-rect')?.plate
      ?? viewer?._marks?.children.find((child) => child.userData.tableId === 'qa-rect');
    return {
      scale: [viewer?._model?.scale.x, viewer?._model?.scale.y, viewer?._model?.scale.z],
      rotationOrder: viewer?._model?.rotation.order,
      rotationDeg: [viewer?._model?.rotation.x, viewer?._model?.rotation.y, viewer?._model?.rotation.z].map((value) => value * 180 / Math.PI),
      position: [viewer?._model?.position.x, viewer?._model?.position.y, viewer?._model?.position.z],
      overlay: [plate?.position.x, plate?.position.y, plate?.position.z],
    };
  });
  assert.deepEqual(modelState.scale, [1.15, 0.95, 1.05]);
  assert.equal(modelState.rotationOrder, 'XYZ');
  assert.deepEqual(modelState.rotationDeg.map((value) => Math.round(value * 100) / 100), [3, 18, -2]);
  assert.deepEqual(modelState.position, [0.75, 0.4, -0.5]);
  assert.deepEqual(modelState.overlay, [4, 0.025, -2], 'table overlays stay in authored plan coordinates rather than following GLB alignment');
  await page.getByRole('radio', { name: '2D map', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: '2D map', exact: true }).isChecked(), true,
    'the student can switch to the separate 2D floor map');
  await page.getByTestId(`student-floor-map-${siteId}-${floorId}`).waitFor();
  for (const tableId of ['qa-rect', 'qa-circle', 'qa-polygon']) {
    await page.getByTestId(`student-map-table-${siteId}-${floorId}-${tableId}`).waitFor();
    await page.getByTestId(`student-table-list-${tableId}`).waitFor();
  }
  assert.equal((await page.locator('[data-testid="student-table-list-qa-rect"]').innerText()).includes('No live data'), true,
    'student browser preserves unknown as unknown rather than calling it free');
  await page.screenshot({ path: join(artifacts, 'student-published-location.png'), fullPage: true });
  const studentPageText = await page.locator('body').innerText();
  for (const privateValue of privateValues) assert.equal(studentPageText.includes(privateValue), false, 'student DOM does not disclose private asset names, IDs, or sensor identity');
  const modelRouteStatus = await page.evaluate(async (assetId) => {
    const response = await fetch(`/api/models/${assetId}`);
    return response.status;
  }, modelAssetId);
  assert.equal(modelRouteStatus, 200, 'the current winning model remains readable after the rendered view');
  await context.tracing.stop({ path: join(artifacts, 'student-published-location.trace.zip') });
  await Promise.all(payloadChecks);
  for (const check of evidence.browser.publicPayloadChecks) assert.deepEqual(check.leaks, [], `${check.path} excludes manager-private data`);
  await context.close();
  await browser.close();
  browserSlot(null);
  contextSlot(null);
  assert.deepEqual(evidence.browser.pageErrors, [], `student browser has no uncaught page errors: ${JSON.stringify(evidence.browser.pageErrors)}`);
  assert.deepEqual(evidence.browser.consoleErrors, [], `student browser has no console errors: ${JSON.stringify(evidence.browser.consoleErrors)}`);
}

async function captureManagerBrowser({ edgeBase, cookie, crossManagerCookie, artifacts, evidence, furnitureAssetIds }) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addCookies([{ name: 'tm_algo', value: cookieValue(cookie, 'tm_algo'), url: edgeBase }]);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.on('pageerror', (error) => evidence.browser.pageErrors.push(error.name));
  page.on('console', (message) => { if (message.type() === 'error') evidence.browser.consoleErrors.push({ text: message.text().slice(0, 400), location: message.location().url }); });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === edgeBase) evidence.browser.network.push({ event: 'manager-request', method: request.method(), path: routeLabel(url.pathname) });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === edgeBase) evidence.browser.network.push({ event: 'manager-response', status: response.status(), path: routeLabel(url.pathname) });
  });
  try {
    await page.goto(`${edgeBase}/locations`);
    await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add location', exact: true }).click();
    const form = page.getByRole('form', { name: 'Create a location draft' });
    await form.getByLabel('Location name').fill('QA Browser Integrated Location');
    await form.getByLabel('Building').fill('Browser Workflow Annex');
    await form.getByLabel('Floor width (m)').fill('5');
    await form.getByLabel('Floor width (m)').press('Tab');
    await form.getByLabel('Floor height (m)').fill('4');
    await form.getByLabel('Floor height (m)').press('Tab');
    await page.getByRole('button', { name: 'Create draft', exact: true }).click();
    await page.waitForURL(/\/locations\/[^/]+\/details$/);
    const draftId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
    await page.getByRole('heading', { name: 'QA Browser Integrated Location', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add rectangle table', exact: true }).click();
    await page.getByLabel('Table name').fill('Task 5 synthetic table');
    await page.getByLabel('Capacity').fill('4');
    await page.getByRole('button', { name: 'Generate seats', exact: true }).click();
    const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
    await page.getByTestId('location-save-draft').click();
    const save = await saveResponse;
    assert.equal(save.status(), 200, 'signed manager browser privately saves the authored table and seat anchors');
    await page.getByText(/Draft saved.*private/).waitFor();
    const listResponse = await context.request.get(`${edgeBase}/api/locations`);
    assert.equal(listResponse.status(), 200);
    const list = (await listResponse.json()).data;
    const uiDraft = list.drafts.find((item) => item.draftId === draftId);
    assert.ok(uiDraft, 'new manager draft appears only in its creator-private draft list');
    assert.equal(list.published.some((item) => item.locationId === uiDraft.locationId), false, 'browser save does not implicitly publish');
    await page.screenshot({ path: join(artifacts, 'manager-private-draft.png'), fullPage: true });

    const initial = await context.request.get(`${edgeBase}/api/locations/drafts/${encodeURIComponent(draftId)}`);
    assert.equal(initial.status(), 200);
    const tableId = (await initial.json()).data.document.tables[0].id;
    const glbBytes = makeTriangleGlb();
    await page.getByTestId('location-step-model').click();
    await page.waitForURL(new RegExp(`/locations/${draftId}/model$`));
    const tableAssetId = await uploadFurnitureFromManager({
      page, context, edgeBase, type: 'table', displayName: 'Task 5 private table asset.glb', bytes: glbBytes, furnitureAssetIds,
    });
    const tableDefault = { assetId: tableAssetId, scale: 1.25, yawDeg: 30, elevationM: 0.2 };
    await page.getByTestId('location-default-table-scale').fill(String(tableDefault.scale));
    await page.getByTestId('location-default-table-yawDeg').fill(String(tableDefault.yawDeg));
    await page.getByTestId('location-default-table-elevationM').fill(String(tableDefault.elevationM));

    const chairAssetId = await uploadFurnitureFromManager({
      page, context, edgeBase, type: 'chair', displayName: 'Task 5 private chair asset.glb', bytes: glbBytes, furnitureAssetIds,
    });
    const chairDefault = { assetId: chairAssetId, scale: 0.75, yawDeg: -10, elevationM: 0.05 };
    await page.getByTestId('location-default-chair-scale').fill(String(chairDefault.scale));
    await page.getByTestId('location-default-chair-yawDeg').fill(String(chairDefault.yawDeg));
    await page.getByTestId('location-default-chair-elevationM').fill(String(chairDefault.elevationM));

    const modelSaveResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
    await page.getByTestId('location-model-save-draft').click();
    assert.equal((await modelSaveResponse).status(), 200, 'room defaults and fit save as a private draft');
    await page.getByText(/Draft saved.*private/).waitFor();
    await page.getByTestId('location-step-details').click();
    await page.waitForURL(new RegExp(`/locations/${draftId}/details$`));
    const tableMode = page.getByTestId(`location-furniture-mode-${tableId}-table`);
    await tableMode.selectOption('override');
    assert.equal(await page.getByTestId(`table-${tableId}-table-scale`).inputValue(), '1.25',
      'a table override starts with the complete room default fit');
    await page.getByTestId(`table-${tableId}-table-scale`).fill('2');
    await page.getByRole('button', { name: 'Reset to room default', exact: true }).click();
    assert.equal(await tableMode.inputValue(), 'inherit', 'reset removes the complete table override');

    const chairMode = page.getByTestId(`location-furniture-mode-${tableId}-chair`);
    await chairMode.selectOption('override');
    assert.equal(await page.getByTestId(`table-${tableId}-chair-scale`).inputValue(), '0.75',
      'a chair override starts as a complete copy of the room default');
    const chairOverride = { assetId: chairAssetId, scale: 0.9, yawDeg: 45, elevationM: 0.1 };
    await page.getByTestId(`table-${tableId}-chair-scale`).fill(String(chairOverride.scale));
    await page.getByTestId(`table-${tableId}-chair-yawDeg`).fill(String(chairOverride.yawDeg));
    await page.getByTestId(`table-${tableId}-chair-elevationM`).fill(String(chairOverride.elevationM));
    const detailsSaveResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
    await page.getByTestId('location-save-draft').click();
    assert.equal((await detailsSaveResponse).status(), 200, 'the complete chair override saves privately');
    await page.getByText(/Draft saved.*private/).waitFor();
    await page.screenshot({ path: join(artifacts, 'manager-furniture-private-draft.png'), fullPage: true });
    await page.reload();
    await page.getByRole('heading', { name: 'QA Browser Integrated Location', exact: true }).waitFor();
    await page.getByLabel('Select table', { exact: true }).selectOption(tableId);
    assert.equal(await chairMode.inputValue(), 'override', 'the saved override is restored after reopening the draft');
    assert.equal(await page.getByTestId(`table-${tableId}-chair-scale`).inputValue(), '0.9');

    const detail = await context.request.get(`${edgeBase}/api/locations/drafts/${encodeURIComponent(draftId)}`);
    assert.equal(detail.status(), 200);
    const detailBody = (await detail.json()).data;
    assert.equal(detailBody.visibility, 'public', 'the combined student workflow location is student-visible');
    const savedDocument = detailBody.document;
    assert.equal(savedDocument.proceduralRoom, 'simple-rectangle-v1');
    assert.equal(savedDocument.furnitureDefaults.table.assetId, tableAssetId);
    assert.deepEqual(savedDocument.furnitureDefaults.table, tableDefault);
    assert.deepEqual(savedDocument.furnitureDefaults.chair, chairDefault);
    assert.deepEqual(savedDocument.tables[0].furnitureOverrides, { chair: chairOverride });
    assert.equal(savedDocument.tables[0].id, tableId);
    assert.equal(savedDocument.tables[0].capacity, 4);
    assert.equal(savedDocument.tables[0].seats.length, 4);

    const crossManagerDraftId = await verifyCrossManagerFurnitureReuse({
      edgeBase, managerCookie: cookie, operatorCookie: crossManagerCookie,
      displayName: 'Task 5 private table asset.glb', assignment: tableDefault, bytes: glbBytes,
    });
    const beforePublishView = await getJson(edgeBase, '/api/locations', cookie);
    assert.equal(beforePublishView.body.data.published.some((item) => item.locationId === uiDraft.locationId), false,
      'saving and reopening furniture leaves it private until the explicit publish action');

    await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
    await page.getByRole('heading', { name: 'Review location' }).waitFor();
    await page.screenshot({ path: join(artifacts, 'manager-furniture-review-before-publish.png'), fullPage: true });
    const publishResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}/publications`);
    await page.getByRole('button', { name: 'Publish location', exact: true }).click();
    const publish = await publishResponse;
    assert.equal(publish.status(), 200, 'explicit Publish location succeeds from the signed manager browser');
    const publication = (await publish.json()).data;
    assert.equal(publication.publishedRevision, 1);
    assert.equal(publication.locationId, uiDraft.locationId);
    await page.waitForURL(`${edgeBase}/locations`);
    const finalListResponse = await context.request.get(`${edgeBase}/api/locations`);
    const finalList = (await finalListResponse.json()).data;
    assert.equal(finalList.published.find((item) => item.locationId === uiDraft.locationId)?.activeRevision, 1,
      'manager browser publication updates the active revision');
    await waitFor(async () => (await fetch(`${edgeBase}/api/locations`, { headers: { cookie } }).then((response) => response.json()))
      .data.published.some((item) => item.locationId === uiDraft.locationId && item.activeRevision === 1), undefined, 'manager browser publication is visible through the API');
    evidence.stages.push({
      name: 'signed manager browser shared-furniture publish', libraryUploads: 2, roomDefaults: 2,
      completeOverrideResetAndReopen: true, unpublishedDraftPrivate: true, publicationRevision: 1,
      generatedMarkerPreserved: true,
    });
    const workflow = {
      locationId: uiDraft.locationId, draftId, tableId, tableAssetId, chairAssetId,
      tableDefault, chairDefault, chairOverride, tableBytes: glbBytes, chairBytes: glbBytes,
      privateDisplayNames: ['Task 5 private table asset.glb', 'Task 5 private chair asset.glb'],
      crossManagerDraftId,
      tableGeometry: {
        capacity: savedDocument.tables[0].capacity,
        rect: rectFromShape(savedDocument.tables[0].shape),
        shape: structuredClone(savedDocument.tables[0].shape),
        seats: savedDocument.tables[0].seats.map(({ id, x, y, neighbors }) => ({ id, x, y, neighbors })),
      },
    };
    await context.tracing.stop({ path: join(artifacts, 'manager-location-workflow.trace.zip') });
    assert.deepEqual(evidence.browser.pageErrors, [], `manager browser has no uncaught page errors: ${JSON.stringify(evidence.browser.pageErrors)}`);
    assert.deepEqual(evidence.browser.consoleErrors, [], `manager browser has no console errors: ${JSON.stringify(evidence.browser.consoleErrors)}`);
    return workflow;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function uploadFurnitureFromManager({ page, context, edgeBase, type, displayName, bytes, furnitureAssetIds }) {
  await page.getByRole('button', { name: 'Choose model', exact: true }).first().click();
  const dialog = page.getByTestId('location-furniture-library-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('Furniture upload type').selectOption(type);
  await dialog.getByLabel('Upload shared furniture GLB').setInputFiles({
    name: `${type}-fixture.glb`, mimeType: 'model/gltf-binary', buffer: bytes,
  });
  await dialog.getByLabel('Display name').fill(displayName);
  assert.equal(await dialog.getByLabel('Display name').inputValue(), displayName,
    'the explicit library display name is typed after file selection');
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/furniture-library');
  await dialog.getByRole('button', { name: 'Upload model', exact: true }).click();
  const uploaded = await uploadResponse;
  assert.equal(uploaded.status(), 201, 'the UI upload has a successful shared-library response');
  const uploadedBody = await uploaded.json();
  assert.equal(typeof uploadedBody.data.assetId, 'string');
  furnitureAssetIds.add(uploadedBody.data.assetId);
  await dialog.getByRole('status').filter({ hasText: /uploaded to the shared library.*not been assigned/i }).waitFor();
  await dialog.getByLabel('Filter furniture by type').selectOption(type);
  const itemResponse = await context.request.get(`${edgeBase}/api/furniture-library?type=${type}`);
  assert.equal(itemResponse.status(), 200);
  const item = (await itemResponse.json()).data.items.find((entry) => entry.displayName === displayName);
  assert.ok(item, 'the uploaded item appears in the shared type-filtered library');
  assert.equal(item.assetId, uploadedBody.data.assetId, 'the listed item matches the exact upload response ID');
  const row = dialog.getByTestId('location-furniture-results').getByRole('listitem').filter({ hasText: displayName });
  await row.getByRole('button', { name: /^Use / }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByTestId(`location-furniture-default-${type}`).filter({ hasText: displayName }).waitFor();
  return item.assetId;
}

async function verifyCrossManagerFurnitureReuse({ edgeBase, managerCookie, operatorCookie, displayName, assignment, bytes }) {
  const library = await getJson(edgeBase, `/api/furniture-library?type=table&q=${encodeURIComponent(displayName)}`, operatorCookie);
  assert.equal(library.response.status, 200, 'a second manager role can read the shared furniture library');
  assert.ok(library.body.data.items.some((item) => item.assetId === assignment.assetId),
    'the second manager sees an asset uploaded by another creator');
  const preview = await fetch(`${edgeBase}/api/furniture-library/${assignment.assetId}`, {
    headers: { cookie: operatorCookie, origin: edgeBase, 'x-tm-algo': '1' },
  });
  assert.equal(preview.status, 200, 'the second manager can privately preflight the shared GLB');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);

  const created = await managerJson(edgeBase, operatorCookie, 'POST', '/api/locations/drafts', {
    name: 'Task 5 cross-manager reuse', building: 'Synthetic workflow', widthCm: 500, heightCm: 400,
  });
  assert.equal(created.response.status, 201);
  const draftId = created.body.data.draftId;
  const detail = await getJson(edgeBase, `/api/locations/drafts/${draftId}`, operatorCookie);
  const document = structuredClone(detail.body.data.document);
  document.furnitureDefaults = { table: assignment };
  const saved = await managerJson(edgeBase, operatorCookie, 'PUT', `/api/locations/drafts/${draftId}`, {
    expectedDraftRevision: detail.body.data.draftRevision, document,
  });
  assert.equal(saved.response.status, 200, 'a second manager can assign and save the shared asset in an owned draft');
  const reloaded = await getJson(edgeBase, `/api/locations/drafts/${draftId}`, operatorCookie);
  assert.deepEqual(reloaded.body.data.document.furnitureDefaults.table, assignment);
  assert.equal((await getJson(edgeBase, '/api/locations', managerCookie)).body.data.drafts.some((item) => item.draftId === draftId), false,
    'cross-manager asset reuse does not grant access to another manager private draft');
  return draftId;
}

async function uploadSharedFurnitureAsset({ edgeBase, managerCookie, displayName, type, bytes, furnitureAssetIds }) {
  const response = await fetch(`${edgeBase}/api/furniture-library`, {
    method: 'POST',
    headers: {
      cookie: managerCookie, origin: edgeBase, 'x-tm-algo': '1',
      'content-type': 'model/gltf-binary', 'x-furniture-type': type,
      'x-asset-display-name': encodeURIComponent(displayName),
    },
    body: bytes,
  });
  recordStatus('POST', '/api/furniture-library', response.status);
  const body = await response.json().catch(() => null);
  if (typeof body?.data?.assetId === 'string') furnitureAssetIds.add(body.data.assetId);
  return { response, body };
}

async function exercisePublishedFurnitureWorkflow({
  edgeBase, web1Base, web2Base, edge, fixture, workflow, managerCookie, operatorCookie,
  furnitureAssetIds, studentCookie, student2Cookie, artifacts, evidence, stage, edgeControl, web2Control, snapshotProxies,
}) {
  const { locationId, tableId, tableAssetId, chairAssetId, tableDefault, chairDefault, chairOverride,
    tableBytes, chairBytes, privateDisplayNames } = workflow;
  const cookies = [studentCookie, student2Cookie];
  const bases = [web1Base, web2Base];
  let firstProjection;
  try {
    firstProjection = await waitForFurnitureProjection(bases, cookies, locationId, edge,
      (floor) => floor.furnitureDefaults?.table?.scale === tableDefault.scale, 'initial furniture v3 snapshot reaches both student targets');
  } catch (error) {
    const targetViews = await Promise.all(bases.map(async (base, index) => {
      const response = await fetch(`${base}/api/occupancy`, { headers: { cookie: cookies[index] } });
      const view = response.ok ? await response.json() : null;
      const floor = view?.floors.find((candidate) => candidate.id === locationId);
      return {
        status: response.status, hasFloor: Boolean(floor), proceduralRoom: floor?.proceduralRoom,
        hasFurnitureDefaults: Boolean(floor?.furnitureDefaults), tableScale: floor?.furnitureDefaults?.table?.scale,
        tableCount: floor?.tables.length,
      };
    }));
    const forwardedSnapshots = snapshotProxies.map((proxy) => ({
      recent: proxy.snapshots.filter((capture) => capture.snapshot.floors?.some((floor) => floor.id === locationId))
        .slice(-5).map((capture) => {
          const floor = capture.snapshot.floors.find((candidate) => candidate.id === locationId);
          return {
            receiverStatus: capture.receiverStatus, version: capture.snapshot.version,
            proceduralRoom: floor.proceduralRoom, hasFurnitureDefaults: Boolean(floor.furnitureDefaults),
            tableScale: floor.furnitureDefaults?.table?.scale,
          };
        }),
    }));
    evidence.stages.push({ name: 'initial furniture projection diagnostics', targetViews, forwardedSnapshots });
    throw error;
  }
  firstProjection.forEach((floor) => assertFurnitureProjection(floor, workflow, { tableScale: tableDefault.scale }));
  await waitFor(() => snapshotProxies.every((proxy) => latestAcceptedSnapshot(proxy, locationId)?.snapshot.version === 3),
    edge, 'real edge emitter sends a v3 snapshot with furniture to both receivers');
  for (const proxy of snapshotProxies) {
    assertEmittedFurnitureSnapshot(latestAcceptedSnapshot(proxy, locationId), workflow, 3);
  }
  assertReceiverFurnitureBytes(fixture, workflow);
  stage('initial furniture v3 publication and durable receiver bytes', {
    targets: 2, uniqueAssets: 2, targetAssetCopies: 4, durableDigestReceipts: true,
    versionlessCampusProjection: true, generatedRoomMarkerPreserved: true,
  });

  await captureStudentFurnitureBrowser({
    webBase: web1Base, cookie: studentCookie, locationId, workflow, artifacts, evidence,
    preferredMode: '3d', expectedScale: tableDefault.scale,
  });
  await captureFreshPreferred2DFurnitureBrowser({
    webBase: web1Base, cookie: studentCookie, locationId, evidence,
  });

  const edit = await managerJson(edgeBase, managerCookie, 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 1 });
  assert.equal(edit.response.status, 201, 'a manager can create a follow-up draft from the current furniture winner');
  const draftId = edit.body.data.draftId;
  const detail = await getJson(edgeBase, `/api/locations/drafts/${draftId}`, managerCookie);
  assert.equal(detail.response.status, 200);
  const candidateBytes = makeTriangleGlb();
  const candidateUpload = await uploadSharedFurnitureAsset({
    edgeBase, managerCookie, displayName: 'Task 5 retry table candidate', type: 'table', bytes: candidateBytes, furnitureAssetIds,
  });
  assert.equal(candidateUpload.response.status, 201, 'manager creates a new shared table candidate for the follow-up draft');
  const candidateAssetId = candidateUpload.body.data.assetId;
  assert.equal(candidateUpload.body.data.displayName, 'Task 5 retry table candidate');
  assert.notEqual(candidateAssetId, tableAssetId, 'the failed publication candidate has a distinct immutable asset ID');
  const changedDocument = structuredClone(detail.body.data.document);
  changedDocument.furnitureDefaults.table.assetId = candidateAssetId;
  changedDocument.furnitureDefaults.table.scale = 1.5;
  const saved = await managerJson(edgeBase, managerCookie, 'PUT', `/api/locations/drafts/${draftId}`, {
    expectedDraftRevision: detail.body.data.draftRevision, document: changedDocument,
  });
  assert.equal(saved.response.status, 200, 'the next assignment revision is saved as a private draft');
  assert.equal((await getJson(edgeBase, '/api/locations', operatorCookie)).body.data.published
    .find((item) => item.locationId === locationId)?.activeRevision, 1,
  'private assignment edits leave the winning public revision unchanged');
  const beforeFailure = await Promise.all(bases.map((base, index) => readPublicFloor(base, cookies[index], locationId)));
  beforeFailure.forEach((floor) => assertFurnitureProjection(floor, workflow, { tableScale: tableDefault.scale }));

  snapshotProxies[1].rejectNextAsset(candidateAssetId);
  let failedPublication;
  failedPublication = await managerJson(edgeBase, managerCookie, 'POST', `/api/locations/drafts/${draftId}/publications`, {
    expectedDraftRevision: saved.body.data.draftRevision, expectedPublishedRevision: 1,
  });
  assert.equal(failedPublication.response.status, 503,
    'a target rejects the candidate asset while both configured receiver processes remain live');
  assert.equal(snapshotProxies[1].rejections.filter((id) => id === candidateAssetId).length, 1,
    'the failure injection rejects exactly the new candidate transfer at target two');
  const activeAfterFailure = await getJson(edgeBase, '/api/locations', managerCookie);
  assert.equal(activeAfterFailure.body.data.published.find((item) => item.locationId === locationId)?.activeRevision, 1,
    'receiver failure preserves the old active publication revision');
  const oldFloorsBeforeRestart = await Promise.all(bases.map((base, index) => readPublicFloor(base, cookies[index], locationId)));
  oldFloorsBeforeRestart.forEach((floor) => assertFurnitureProjection(floor, workflow, { tableScale: tableDefault.scale }));
  for (let index = 0; index < bases.length; index += 1) {
    for (const assetId of [tableAssetId, chairAssetId]) {
      const oldAsset = await fetch(`${bases[index]}/api/models/${assetId}`, { headers: { cookie: cookies[index] } });
      assert.equal(oldAsset.status, 200, 'both running targets retain the old winning snapshot and its referenced GLBs');
    }
  }
  assertDurableReceiverAsset(fixture.web1Data, candidateAssetId, candidateBytes);
  assert.equal(publishedModelFiles(fixture.web2Data).includes(`${candidateAssetId}.glb`), false,
    'the injected target rejection prevents candidate bytes from reaching target two');
  for (let index = 0; index < bases.length; index += 1) {
    const privateCandidate = await fetch(`${bases[index]}/api/models/${candidateAssetId}`, { headers: { cookie: cookies[index] } });
    assert.equal(privateCandidate.status, 404,
      'the partially transferred candidate remains unauthorized on both targets under the old winning snapshots');
  }

  await edgeControl.stop();
  await web2Control.stop();
  await web2Control.restart();
  const restartedView = await waitFor(async () => {
    const response = await fetch(`${web2Base}/api/occupancy`, { headers: { cookie: student2Cookie } });
    if (!response.ok) return false;
    const view = await response.json();
    return view.floors.some((floor) => floor.id === locationId) ? false : view;
  }, undefined, 'restarted target is ready with its established empty in-memory snapshot store');
  for (const assetId of [tableAssetId, chairAssetId, candidateAssetId]) {
    const denied = await fetch(`${web2Base}/api/models/${assetId}`, { headers: { cookie: student2Cookie } });
    assert.equal(denied.status, 404,
      'a web-only restart has no current winning snapshot, so durable old or partial bytes stay unauthorized until the next edge snapshot');
  }
  assertDurableReceiverAsset(fixture.web2Data, tableAssetId, tableBytes);
  assertDurableReceiverAsset(fixture.web2Data, chairAssetId, chairBytes);
  assert.equal((await fetch(`${web1Base}/api/models/${tableAssetId}`, { headers: { cookie: studentCookie } })).status, 200,
    'target one keeps its old current reference while target two has restarted empty');
  assert.equal((await fetch(`${web1Base}/api/models/${candidateAssetId}`, { headers: { cookie: studentCookie } })).status, 404,
    'target one continues denying the partial candidate while target two has restarted empty');
  assert.equal(restartedView.floors.some((floor) => floor.id === locationId), false,
    'web-only restart resets the old snapshot; the normal retry below reestablishes current authorization');
  edge = await edgeControl.restart();
  managerCookie = await loginManager(edgeBase, 'qa-admin-a');
  const replayedOldFloors = await waitForFurnitureProjection(bases, cookies, locationId, edge,
    (floor) => floor.furnitureDefaults?.table?.scale === tableDefault.scale,
    'edge restart republishes the unchanged old furniture winner to both targets');
  replayedOldFloors.forEach((floor) => assertFurnitureProjection(floor, workflow, { tableScale: tableDefault.scale }));
  for (let index = 0; index < bases.length; index += 1) {
    for (const assetId of [tableAssetId, chairAssetId]) {
      const oldAsset = await fetch(`${bases[index]}/api/models/${assetId}`, { headers: { cookie: cookies[index] } });
      assert.equal(oldAsset.status, 200, 'edge replay restores the old winner authorization on both targets');
    }
    const privateCandidate = await fetch(`${bases[index]}/api/models/${candidateAssetId}`, { headers: { cookie: cookies[index] } });
    assert.equal(privateCandidate.status, 404,
      'edge replay of the old winner still denies the partial candidate on both targets');
  }
  stage('failed furniture publication retains old winner', {
    failedStatus: failedPublication?.response.status, activeRevision: 1,
    oldWinnerReadableOnBothLiveTargetsBeforeRestart: true, restartedTargetSnapshotEmptyWhileEdgeOffline: true,
    durableBytesAndReceiptsRetained: true, oldWinnerReplayedAfterEdgeRestart: true,
    partialCandidateDeniedBeforeAndAfterRestart: true,
  });

  const retried = await managerJson(edgeBase, managerCookie, 'POST', `/api/locations/drafts/${draftId}/publications`, {
    expectedDraftRevision: saved.body.data.draftRevision, expectedPublishedRevision: 1,
  });
  assert.equal(retried.response.status, 200, 'retry succeeds after both configured receivers recover');
  assert.equal(retried.body.data.publishedRevision, 2);
  const retryWorkflow = {
    ...workflow,
    tableAssetId: candidateAssetId,
    tableDefault: { ...tableDefault, assetId: candidateAssetId, scale: 1.5 },
    tableBytes: candidateBytes,
    privateDisplayNames: [...workflow.privateDisplayNames, 'Task 5 retry table candidate'],
  };
  const secondProjection = await waitForFurnitureProjection(bases, cookies, locationId, edge,
    (floor) => floor.furnitureDefaults?.table?.scale === 1.5, 'retry publishes the complete v3 snapshot to both targets');
  secondProjection.forEach((floor) => assertFurnitureProjection(floor, retryWorkflow, { tableScale: 1.5 }));
  await waitFor(() => snapshotProxies.every((proxy) => latestAcceptedSnapshot(proxy, locationId)?.snapshot.floors
    .find((floor) => floor.id === locationId)?.furnitureDefaults?.table?.assetId === candidateAssetId),
  edge, 'real edge emitter sends the retried furniture v3 winner to both receivers');
  for (const proxy of snapshotProxies) assertEmittedFurnitureSnapshot(latestAcceptedSnapshot(proxy, locationId), retryWorkflow, 3);
  assertReceiverFurnitureBytes(fixture, workflow, [[candidateAssetId, candidateBytes]]);
  for (let index = 0; index < bases.length; index += 1) {
    const candidateCurrent = await fetch(`${bases[index]}/api/models/${candidateAssetId}`, { headers: { cookie: cookies[index] } });
    assert.equal(candidateCurrent.status, 200,
      'the candidate asset becomes authorized on each target only after the winning retry snapshot commits');
    assert.deepEqual(Buffer.from(await candidateCurrent.arrayBuffer()), candidateBytes);
    const superseded = await fetch(`${bases[index]}/api/models/${tableAssetId}`, { headers: { cookie: cookies[index] } });
    assert.equal(superseded.status, 404, 'the replaced table asset loses public authorization when the retry wins');
  }
  await captureStudentFurnitureBrowser({
    webBase: web2Base, cookie: student2Cookie, locationId, workflow: retryWorkflow, artifacts, evidence,
    preferredMode: '3d', expectedScale: 1.5,
  });
  stage('furniture publication retry', {
    publishedRevision: 2, targets: 2, exactAssignmentsAndGeometry: true,
    uniqueAssetRequestsPerFresh3DViewer: 2,
  });

  const withdraw = await managerJson(edgeBase, managerCookie, 'POST', `/api/locations/${locationId}/drafts`, { expectedPublishedRevision: 2 });
  assert.equal(withdraw.response.status, 201);
  const withdrawDetail = await getJson(edgeBase, `/api/locations/drafts/${withdraw.body.data.draftId}`, managerCookie);
  assert.equal(withdrawDetail.response.status, 200);
  const withdrawnDocument = structuredClone(withdrawDetail.body.data.document);
  delete withdrawnDocument.furnitureDefaults;
  for (const table of withdrawnDocument.tables) delete table.furnitureOverrides;
  const withdrawnSave = await managerJson(edgeBase, managerCookie, 'PUT', `/api/locations/drafts/${withdraw.body.data.draftId}`, {
    expectedDraftRevision: withdrawDetail.body.data.draftRevision, document: withdrawnDocument,
  });
  assert.equal(withdrawnSave.response.status, 200);
  const withdrawal = await managerJson(edgeBase, managerCookie, 'POST', `/api/locations/drafts/${withdraw.body.data.draftId}/publications`, {
    expectedDraftRevision: withdrawnSave.body.data.draftRevision, expectedPublishedRevision: 2,
  });
  assert.equal(withdrawal.response.status, 200, 'removing all assignments uses the normal private-edit and publication path');
  assert.equal(withdrawal.body.data.publishedRevision, 3);
  const withdrawnFloors = await waitFor(async () => {
    const floors = await Promise.all(bases.map((base, index) => readPublicFloor(base, cookies[index], locationId)));
    return floors.every((floor) => !Object.hasOwn(floor, 'furnitureDefaults')
      && floor.tables.every((table) => !Object.hasOwn(table, 'furnitureOverrides'))
      && floor.proceduralRoom === 'simple-rectangle-v1') ? floors : false;
  }, edge, 'withdrawn v2 projection reaches both web targets');
  for (const floor of withdrawnFloors) {
    assert.equal(floor.version, undefined, 'the public campus projection remains versionless');
    assert.equal(floor.proceduralRoom, 'simple-rectangle-v1', 'supported v2 procedural-room marker remains intact');
    assert.equal(Object.hasOwn(floor, 'furnitureDefaults'), false);
    assert.ok(floor.tables.every((table) => !Object.hasOwn(table, 'furnitureOverrides')));
  }
  await waitFor(() => snapshotProxies.every((proxy) => latestAcceptedSnapshot(proxy, locationId)?.snapshot.version === 2
    && !Object.hasOwn(latestAcceptedSnapshot(proxy, locationId).snapshot.floors.find((floor) => floor.id === locationId) ?? {}, 'furnitureDefaults')),
  edge, 'real edge emitter downgrades furniture-free public snapshot to supported v2 on both targets');
  for (const proxy of snapshotProxies) {
    const captured = latestAcceptedSnapshot(proxy, locationId);
    assert.equal(captured.snapshot.version, 2, 'actual edge output uses supported snapshot v2 after all furniture references are withdrawn');
    assertEmittedFurnitureSnapshot(captured, workflow, 2);
  }
  const stillPrivate = await getJson(edgeBase, `/api/locations/drafts/${workflow.crossManagerDraftId}`, operatorCookie);
  assert.equal(stillPrivate.response.status, 200,
    'withdrawing public references does not delete another manager private assignment draft');
  assert.equal(stillPrivate.body.data.document.furnitureDefaults.table.assetId, tableAssetId);
  for (let index = 0; index < bases.length; index += 1) {
    for (const assetId of [tableAssetId, candidateAssetId, chairAssetId]) {
      const denied = await fetch(`${bases[index]}/api/models/${assetId}`, { headers: { cookie: cookies[index] } });
      assert.equal(denied.status, 404,
        'withdrawn furniture bytes are denied when no current public floor references the immutable asset');
    }
  }
  stage('furniture reference withdrawal projects supported v2', {
    publishedRevision: 3, targets: 2, furnitureFieldsAbsent: true,
    proceduralRoomMarkerPreserved: true, privateDraftRetained: true, unreferencedPublicBytesDenied: true,
  });
}

async function readPublicFloor(webBase, cookie, locationId) {
  const response = await fetch(`${webBase}/api/occupancy`, { headers: { cookie } });
  assert.equal(response.status, 200, 'student occupancy remains available');
  const view = await response.json();
  const floor = view.floors.find((candidate) => candidate.siteId === 'hku-innowing' && candidate.id === locationId);
  assert.ok(floor, 'the composite location appears in the current student campus projection');
  assert.equal(Object.hasOwn(view, 'version'), false, 'campus view omits an internal transport version');
  return floor;
}

async function createSnapshotRecordingProxy(targetBase, port) {
  const snapshots = [];
  const rejections = [];
  let rejectAssetId;
  const server = createHttpServer((request, response) => {
    void (async () => {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.byteLength;
        if (length > 128 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const urlPath = request.url ?? '/';
      const assetId = decodeURIComponent(urlPath.split('/').at(-1) ?? '');
      if (request.method === 'PUT' && urlPath.startsWith('/api/edge/location-assets/') && assetId === rejectAssetId) {
        rejections.push(assetId);
        rejectAssetId = undefined;
        response.writeHead(503, { 'content-length': '0' });
        response.end();
        return;
      }
      let emittedSnapshot;
      if (request.method === 'POST' && urlPath === '/api/edge/snapshot') {
        try { emittedSnapshot = JSON.parse(body.toString('utf8')); } catch { emittedSnapshot = undefined; }
      }
      const headers = {};
      for (const name of ['authorization', 'content-type', 'x-tm-edge-id', 'x-tm-sha256']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      try {
        const upstream = await fetch(new URL(urlPath, targetBase), {
          method: request.method, headers, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
          signal: AbortSignal.timeout(10_000),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'content-length': String(bytes.byteLength),
        });
        response.end(bytes);
        if (emittedSnapshot) {
          snapshots.push({ snapshot: emittedSnapshot, receiverStatus: upstream.status });
          if (snapshots.length > 30) snapshots.splice(0, snapshots.length - 30);
        }
      } catch {
        if (!response.headersSent) response.writeHead(502, { 'content-length': '0' });
        response.end();
        if (emittedSnapshot) {
          snapshots.push({ snapshot: emittedSnapshot, receiverStatus: 502 });
          if (snapshots.length > 30) snapshots.splice(0, snapshots.length - 30);
        }
      }
    })();
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return { server, snapshots, rejections, rejectNextAsset: (assetId) => { rejectAssetId = assetId; } };
}

async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

function latestAcceptedSnapshot(proxy, locationId) {
  return [...proxy.snapshots].reverse().find((capture) => capture.receiverStatus === 200
    && capture.snapshot.floors?.some((floor) => floor.id === locationId));
}

function assertEmittedFurnitureSnapshot(capture, workflow, version) {
  assert.ok(capture, 'each real target accepts an edge-emitted snapshot for this location');
  const { snapshot } = capture;
  assert.equal(capture.receiverStatus, 200, 'receiver accepts the captured snapshot');
  assert.equal(snapshot.version, version);
  const floor = snapshot.floors.find((item) => item.id === workflow.locationId);
  assert.ok(floor);
  assert.equal(floor.proceduralRoom, 'simple-rectangle-v1');
  const table = floor.tables.find((item) => item.id === workflow.tableId);
  assert.ok(table);
  assert.equal(table.capacity, workflow.tableGeometry.capacity);
  assert.deepEqual(table.rect, workflow.tableGeometry.rect);
  assert.deepEqual(table.shape, workflow.tableGeometry.shape);
  assert.deepEqual(table.seats.map(({ id, x, y, neighbors }) => ({ id, x, y, neighbors })), workflow.tableGeometry.seats,
    'actual transport snapshot retains the authored table and seat geometry');
  if (version === 3) {
    assert.deepEqual(floor.furnitureDefaults, {
      table: workflow.tableDefault, chair: workflow.chairDefault,
    });
    assert.deepEqual(table.furnitureOverrides, { chair: workflow.chairOverride });
  } else {
    assert.equal(version, 2);
    assert.equal(Object.hasOwn(floor, 'furnitureDefaults'), false);
    assert.ok(floor.tables.every((table) => !Object.hasOwn(table, 'furnitureOverrides')));
  }
}

async function waitForFurnitureProjection(bases, cookies, locationId, processHandle, predicate, label) {
  return waitFor(async () => {
    const floors = await Promise.all(bases.map(async (base, index) => {
      try { return await readPublicFloor(base, cookies[index], locationId); }
      catch { return null; }
    }));
    return floors.every((floor) => floor && predicate(floor)) ? floors : false;
  }, processHandle, label);
}

function assertFurnitureProjection(floor, workflow, { tableScale, tableAssetId = workflow.tableAssetId }) {
  const { tableId, chairAssetId, tableDefault, chairDefault, chairOverride,
    privateDisplayNames, tableGeometry } = workflow;
  assert.equal(floor.proceduralRoom, 'simple-rectangle-v1');
  assert.equal(Object.hasOwn(floor, 'version'), false);
  assert.deepEqual(floor.furnitureDefaults, {
    table: { ...tableDefault, assetId: tableAssetId, scale: tableScale }, chair: chairDefault,
  }, 'public v3 projection contains only the complete safe default asset references and transforms');
  const table = floor.tables.find((candidate) => candidate.id === tableId);
  assert.ok(table, 'published v3 projection preserves the authored table');
  assert.equal(table.capacity, tableGeometry.capacity);
  assert.deepEqual(table.rect, tableGeometry.rect);
  assert.deepEqual(table.shape, tableGeometry.shape);
  assert.deepEqual(table.seats.map(({ id, x, y, neighbors }) => ({ id, x, y, neighbors })), tableGeometry.seats,
    'furniture transforms do not change authored table or seat geometry');
  assert.deepEqual(table.furnitureOverrides, { chair: chairOverride });
  assert.equal(floor.tables.reduce((sum, candidate) => sum + candidate.capacity, 0), 4);
  const serialized = JSON.stringify(floor);
  for (const privateName of privateDisplayNames) assert.equal(serialized.includes(privateName), false,
    'public campus projection excludes manager-private display names');
  for (const forbidden of ['creatorId', 'assetProvenance', 'uploader', 'metadata']) {
    assert.equal(Object.hasOwn(floor, forbidden), false, `public campus projection excludes ${forbidden}`);
  }
  assert.equal(table.furnitureOverrides.chair.assetId, chairAssetId);
  assert.equal(floor.furnitureDefaults.table.assetId, tableAssetId);
}

function assertReceiverFurnitureBytes(fixture, workflow, extraAssets = []) {
  let copies = 0;
  for (const dataDir of [fixture.web1Data, fixture.web2Data]) {
    for (const [assetId, bytes] of [
      [workflow.tableAssetId, workflow.tableBytes], [workflow.chairAssetId, workflow.chairBytes], ...extraAssets,
    ]) {
      assertDurableReceiverAsset(dataDir, assetId, bytes);
      copies += 1;
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'published-models', '.integrity-baseline-v1'), 'utf8')),
      { schemaVersion: 1 }, 'the receiver completed its versioned integrity baseline before serving model bytes');
  }
  assert.equal(copies, (2 + extraAssets.length) * 2);
}

function assertDurableReceiverAsset(dataDir, assetId, bytes) {
  const directory = join(dataDir, 'published-models');
  const persisted = readFileSync(join(directory, `${assetId}.glb`));
  assert.deepEqual(persisted, bytes, 'receiver persists the exact immutable GLB bytes');
  const metadata = JSON.parse(readFileSync(join(directory, `${assetId}.meta`), 'utf8'));
  assert.deepEqual(metadata, { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength },
    'receiver persists the matching immutable digest and byte length receipt');
}

async function captureStudentFurnitureBrowser({ webBase, cookie, locationId, workflow, artifacts, evidence, preferredMode, expectedScale }) {
  const errors = [];
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addCookies([{ name: 'tm_session', value: cookie.replace(/^tm_session=/, ''), url: webBase }]);
  await context.addInitScript((mode) => localStorage.setItem('hkumyseat.student.room-view-mode.v1', mode), preferredMode);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const modelRequests = [];
  page.on('pageerror', (error) => errors.push(error.name));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text().slice(0, 120)}`); });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === webBase && /^\/api\/models\/[0-9a-f-]{36}$/i.test(url.pathname)) modelRequests.push(url.pathname);
    if (url.origin === webBase) evidence.browser.network.push({ event: 'furniture-student-request', method: request.method(), path: routeLabel(url.pathname) });
  });
  try {
    await page.goto(`${webBase}/dashboard/`);
    await page.getByTestId('student-location-search').waitFor();
    await page.goto(`${webBase}/dashboard/spaces/hku-innowing/${encodeURIComponent(locationId)}`);
    assert.equal(await page.getByRole('radio', { name: '3D view' }).isChecked(), true,
      'fresh selected 3D preference initializes the student furniture viewer');
    await page.getByTestId('student-model-viewer-canvas').waitFor();
    await page.waitForFunction(() => {
      const viewer = document.querySelector('floor-viewer');
      return Boolean(viewer?._three && viewer?._generatedShell && viewer?._furnitureInstances?.size === 5);
    });
    const rendered = await page.evaluate(() => {
      const viewer = document.querySelector('floor-viewer');
      return [...viewer._furnitureInstances.entries()].map(([key, object]) => ({
        key, assetId: object.userData.assetId, tableId: object.userData.tableId,
        slot: object.userData.slot, seatId: object.userData.seatId ?? null,
        position: [object.position.x, object.position.y, object.position.z],
        scale: [object.scale.x, object.scale.y, object.scale.z], yaw: object.rotation.y,
      }));
    });
    assert.equal(rendered.filter((item) => item.assetId === workflow.tableAssetId && item.slot === 'table').length, 1);
    assert.equal(rendered.filter((item) => item.assetId === workflow.chairAssetId && item.slot === 'chair').length, 4,
      'four authored seats inherit the unique chair GLB reference');
    const tableInstance = rendered.find((item) => item.assetId === workflow.tableAssetId && item.slot === 'table');
    const chairInstances = rendered.filter((item) => item.assetId === workflow.chairAssetId && item.slot === 'chair');
    assert.deepEqual(tableInstance.scale, [expectedScale, expectedScale, expectedScale], 'table display fit uses a uniform scale');
    assert.ok(chairInstances.every((item) => item.scale.every((value) => value === workflow.chairOverride.scale)),
      'the complete per-table chair override applies uniform scale to each authored seat');
    assert.ok(Math.abs(tableInstance.yaw - workflow.tableDefault.yawDeg * Math.PI / 180) < 1e-10,
      'table display yaw is applied around vertical Y');
    assert.ok(Math.abs(tableInstance.position[1] - workflow.tableDefault.elevationM) < 1e-10,
      'table display elevation is applied from the base');
    assert.ok(chairInstances.every((item) => Math.abs(item.position[1] - workflow.chairOverride.elevationM) < 1e-10),
      'chair elevation applies at each authored seat base');
    assert.equal((await page.getByTestId(`student-table-list-${workflow.tableId}`).innerText()).includes('No live data'), true,
      'furniture display preserves unknown occupancy status');
    assert.equal(modelRequests.filter((path) => path === `/api/models/${workflow.tableAssetId}`).length, 1,
      'the unique table asset is fetched once');
    assert.equal(modelRequests.filter((path) => path === `/api/models/${workflow.chairAssetId}`).length, 1,
      'the unique chair asset shared by all seat instances is fetched once');
    assert.equal(modelRequests.length, 2, 'student 3D viewer fetches only the two unique assigned furniture models');
    await page.screenshot({ path: join(artifacts, `student-furniture-${expectedScale}.png`), fullPage: true });
    const body = await page.locator('body').innerText();
    for (const name of workflow.privateDisplayNames) assert.equal(body.includes(name), false,
      'student UI does not expose manager-private shared-library display names');
    const layoutAssignments = await page.evaluate(() => JSON.parse(document.querySelector('floor-viewer').getAttribute('location-layout'))
      .tables.map((table) => table.furniture));
    assert.equal(layoutAssignments.length, 1);
    assert.deepEqual(layoutAssignments[0], {
      table: { ...workflow.tableDefault, scale: expectedScale }, chair: workflow.chairOverride,
    }, 'the student bridge receives the complete inherited/default and overridden assignments');
    await context.tracing.stop({ path: join(artifacts, `student-furniture-${expectedScale}.trace.zip`) });
    evidence.stages.push({ name: 'student v3 furniture geometry', preferredMode, expectedScale,
      visibleFurnitureInstances: rendered.length, uniqueAssetRequests: modelRequests.length,
      uniformScaleYawElevation: true, authoredGeometryRetained: true, unknownStatusRetained: true });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  assert.deepEqual(errors, [], `student furniture page has no browser errors: ${JSON.stringify(errors)}`);
}

async function captureFreshPreferred2DFurnitureBrowser({ webBase, cookie, locationId, evidence }) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addCookies([{ name: 'tm_session', value: cookie.replace(/^tm_session=/, ''), url: webBase }]);
  await context.addInitScript(() => localStorage.setItem('hkumyseat.student.room-view-mode.v1', '2d'));
  const modelRequests = [];
  const page = await context.newPage();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === webBase && /^\/api\/models\/[0-9a-f-]{36}$/i.test(url.pathname)) modelRequests.push(url.pathname);
  });
  try {
    await page.goto(`${webBase}/dashboard/`);
    await page.getByTestId('student-location-search').waitFor();
    await page.goto(`${webBase}/dashboard/spaces/hku-innowing/${encodeURIComponent(locationId)}`);
    const map = page.getByTestId(`student-floor-map-hku-innowing-${locationId}`);
    await map.waitFor();
    assert.equal(await map.isVisible(), true);
    assert.equal(await page.getByRole('radio', { name: '2D map' }).isChecked(), true);
    assert.equal(await page.getByTestId('student-model-viewer-canvas').count(), 0,
      'a fresh preferred 2D browser does not initialize the hidden 3D viewer');
    assert.equal(await page.evaluate(() => localStorage.getItem('hkumyseat.student.room-view-mode.v1')), '2d');
    assert.deepEqual(modelRequests, [], 'fresh preferred 2D startup makes no furniture model requests');
    evidence.stages.push({ name: 'fresh preferred 2d does not fetch furniture', freshBrowserContext: true, modelRequests: 0 });
  } finally {
    await context.close();
    await browser.close();
  }
}

function authorDocument(modelAssetId, planAssetId) {
  return {
    name: 'QA Published Location', building: 'Task 4.2 Integration', widthCm: 800, heightCm: 400,
    outline: [[0, 0], [800, 0], [800, 400], [0, 400]],
    zones: [{ id: 'qa-room', name: 'QA Room', polygon: [[0, 0], [800, 0], [800, 400], [0, 400]] }],
    tables: [
      { id: 'qa-rect', name: 'Rectangle', zoneId: 'qa-room', capacity: 3,
        shape: { type: 'rect', x: 100, y: 150, width: 600, height: 100 },
        seats: [
          { id: 'qa-rect-s1', x: 150, y: 200, neighbors: ['qa-rect-s2'] },
          { id: 'qa-rect-s2', x: 400, y: 200, neighbors: ['qa-rect-s1', 'qa-rect-s3'] },
          { id: 'qa-rect-s3', x: 650, y: 200, neighbors: ['qa-rect-s2'] },
        ] },
      { id: 'qa-circle', name: 'Round table', zoneId: 'qa-room', capacity: 1,
        shape: { type: 'circle', cx: 130, cy: 320, radius: 40 },
        seats: [{ id: 'qa-circle-s1', x: 130, y: 320, neighbors: [] }] },
      { id: 'qa-polygon', name: 'Polygon table', zoneId: 'qa-room', capacity: 1,
        shape: { type: 'polygon', points: [[400, 280], [600, 280], [580, 380], [420, 380]] },
        seats: [{ id: 'qa-polygon-s1', x: 500, y: 330, neighbors: [] }] },
    ],
    sensorAssignments: [],
    planAssetId,
    modelAssetId,
    modelTransform: LOCATION_TRANSFORM,
  };
}

function stableFloorConfig(floor) {
  const project = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, structuredClone(value[key])]));
  return {
    ...project(floor, ['id', 'siteId', 'name', 'building', 'width', 'height', 'outline']),
    zones: (floor.zones ?? []).map((zone) => project(zone, ['id', 'name', 'polygon'])),
    tables: (floor.tables ?? []).map((table) => project(table, ['id', 'name', 'zone', 'zoneId', 'capacity', 'rect', 'shape', 'seats'])),
  };
}

function makeTriangleGlb() {
  const binary = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'Task 4.2 integrated workflow fixture' },
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
function rectFromShape(shape) {
  if (shape.type === 'rect') return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.type === 'circle') return { x: shape.cx - shape.radius, y: shape.cy - shape.radius, width: shape.radius * 2, height: shape.radius * 2 };
  const xs = shape.points.map(([x]) => x), ys = shape.points.map(([, y]) => y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
function routeLabel(path) {
  return path.replace(/\/api\/models\/[0-9a-f-]{36}/gi, '/api/models/{assetId}')
    .replace(/\/api\/furniture-library\/[0-9a-f-]{36}/gi, '/api/furniture-library/{assetId}')
    .replace(/\/api\/locations\/drafts\/[0-9a-f-]{36}/gi, '/api/locations/drafts/{draftId}')
    .replace(/\/api\/locations\/location_[^/]+/gi, '/api/locations/{locationId}');
}
function keepTail(value) { return value.length > 64_000 ? value.slice(-64_000) : value; }
function sanitizeProcessLine(value) {
  return value.replace(/(?:password|token|secret|authorization)(?:=|:|\s)+[^\s,]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\[^\s)]+/gi, '[path]');
}

globalThis.__task42Evidence = undefined;
