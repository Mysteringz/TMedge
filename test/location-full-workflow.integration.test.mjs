import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  let browser;
  let browserContext;
  let edge;
  let web1;
  let web2;
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
    };
    const edgeBase = `http://127.0.0.1:${ports.edgeAlgo}`;
    const web1Base = `http://127.0.0.1:${ports.web1}`;
    const web2Base = `http://127.0.0.1:${ports.web2}`;
    const dbEnv = PROFILE === 'postgres' ? postgresEnvironment() : {};

    if (PROFILE === 'postgres') {
      const preflight = await inspectPostgresCleanup(dbEnv);
      assert.deepEqual(preflight, { registeredNodes: null, migrationRows: 0 }, 'the isolated synthetic database must be fresh before this profile');
      evidence.migrations.push({ direction: 'preflight', ...preflight, result: 'PASS' });
      const migrationFiles = readdirSync(resolve('dist/src/infrastructure/postgres/migrations'))
        .filter((name) => name.endsWith('.js')).sort();
      const up = await runTool('dist/src/tools/postgres-migrate.js', ['up'], { ...dbEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'migration-only-test-placeholder' });
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
      WEB_PUSH_URLS: `${web1Base},${web2Base}`,
      WEB_PUSH_TOKEN: WEB_TOKEN,
      PUBLISH_MS: '200',
      GATEWAY_PORT: '0', NODE_PORT: '0',
      ...dbEnv,
    }, processes, gracefulStopModule);

    web1 = startWeb1();
    web2 = startWeb2();
    await waitHttp(`${web1Base}/login/`, 200, web1, 'first web target ready');
    await waitHttp(`${web2Base}/login/`, 200, web2, 'second web target ready');
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
    await captureManagerBrowser({ edgeBase, cookie: managers['qa-admin-a'], artifacts, evidence });
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
      const downCount = migrationCount;
      for (let i = 0; i < downCount; i++) {
        await runTool('dist/src/tools/postgres-migrate.js', ['down'], { ...dbEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'migration-only-test-placeholder' });
      }
      migrationDownCount = downCount;
      evidence.migrations.push({ direction: 'down', count: downCount, result: 'PASS' });
      const check = await inspectPostgresCleanup(dbEnv);
      assert.equal(check.registeredNodes, null, 'the migration rollback removes the task-owned application schema');
      assert.equal(check.migrationRows, 0, 'the synthetic migration ledger is empty after the down run');
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
    if (PROFILE === 'postgres' && migrationCount > 0) {
      for (let i = 0; i < migrationCount; i++) {
        await runTool('dist/src/tools/postgres-migrate.js', ['down'], {
          ...postgresEnvironment(), PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'migration-only-test-placeholder',
        }).catch(() => {});
      }
      const cleanup = await inspectPostgresCleanup(postgresEnvironment()).catch(() => null);
      if (cleanup?.registeredNodes === null && cleanup?.migrationRows === 0) migrationCount = 0;
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
    PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'migration-only-test-placeholder',
    PG_RUNTIME_USER: 'wizard_runtime', PG_RUNTIME_PASSWORD: 'runtime-only-test-placeholder',
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
    ...pgEnv, PG_MIGRATION_USER: 'wizard_test', PG_MIGRATION_PASSWORD: 'migration-only-test-placeholder',
  }));
  try {
    const rows = await source.query("SELECT to_regclass('public.registered_nodes') AS registered_nodes, CASE WHEN to_regclass('public.migrations') IS NULL THEN 0 ELSE (SELECT count(*)::int FROM public.migrations) END AS migration_rows");
    return { registeredNodes: rows[0]?.registered_nodes ?? null, migrationRows: Number(rows[0]?.migration_rows ?? 0) };
  } finally { await closePostgres(source); }
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
    if (await predicate()) return;
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
  await page.getByTestId(`student-floor-map-${siteId}-${floorId}`).waitFor();
  for (const tableId of ['qa-rect', 'qa-circle', 'qa-polygon']) {
    await page.getByTestId(`student-map-table-${siteId}-${floorId}-${tableId}`).waitFor();
    await page.getByTestId(`student-table-list-${tableId}`).waitFor();
  }
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

async function captureManagerBrowser({ edgeBase, cookie, artifacts, evidence }) {
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
    const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/locations/drafts/${encodeURIComponent(draftId)}`);
    await page.getByTestId('location-save-draft').click();
    const save = await saveResponse;
    assert.equal(save.status(), 200, 'signed manager browser privately saves the created draft');
    const listResponse = await context.request.get(`${edgeBase}/api/locations`);
    assert.equal(listResponse.status(), 200);
    const list = (await listResponse.json()).data;
    const uiDraft = list.drafts.find((item) => item.draftId === draftId);
    assert.ok(uiDraft, 'new manager draft appears only in its creator-private draft list');
    assert.equal(list.published.some((item) => item.locationId === uiDraft.locationId), false, 'browser save does not implicitly publish');
    await page.screenshot({ path: join(artifacts, 'manager-private-draft.png'), fullPage: true });
    await page.getByRole('navigation', { name: 'Location wizard steps' }).getByRole('button', { name: /Review/ }).click();
    await page.getByRole('heading', { name: 'Review location' }).waitFor();
    await page.screenshot({ path: join(artifacts, 'manager-review-before-publish.png'), fullPage: true });
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
    evidence.stages.push({ name: 'signed manager browser create-save-review-publish', draftPrivateBeforePublish: true, publicationRevision: 1, screenshot: 'manager-private-draft.png' });
    await context.tracing.stop({ path: join(artifacts, 'manager-location-workflow.trace.zip') });
    assert.deepEqual(evidence.browser.pageErrors, [], `manager browser has no uncaught page errors: ${JSON.stringify(evidence.browser.pageErrors)}`);
    assert.deepEqual(evidence.browser.consoleErrors, [], `manager browser has no console errors: ${JSON.stringify(evidence.browser.consoleErrors)}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
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
function routeLabel(path) {
  return path.replace(/\/api\/models\/[0-9a-f-]{36}/gi, '/api/models/{assetId}')
    .replace(/\/api\/locations\/drafts\/[0-9a-f-]{36}/gi, '/api/locations/drafts/{draftId}')
    .replace(/\/api\/locations\/location_[^/]+/gi, '/api/locations/{locationId}');
}
function keepTail(value) { return value.length > 64_000 ? value.slice(-64_000) : value; }
function sanitizeProcessLine(value) {
  return value.replace(/(?:password|token|secret|authorization)(?:=|:|\s)+[^\s,]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\[^\s)]+/gi, '[path]');
}

globalThis.__task42Evidence = undefined;
