/** Browser regressions against the built, authenticated algorithm console.
 * Run npm run build, npx playwright install --with-deps chromium webkit,
 * then npm run test:algo-mobile. All data and writes stay in a local fixture.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { createConsole } from '../dist/src/edge/console.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { KEY, siteJson, nodesJson } from '../dist/test/fixtures.js';

let runtime, handle, base, directory;
const originalDataDir = process.env.DATA_DIR;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tmedge-mobile-'));
  writeFileSync(join(directory, 'nodes.json'), JSON.stringify(nodesJson()));
  process.env.DATA_DIR = directory;
  const config = {
    edgeId: 'mobile-preview', keys: [KEY], allowUnsigned: false,
    udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: join(directory, 'nodes.json'), dataDir: directory,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1',
    adminPassword: 'local-browser-test', flashToken: null, pushUrls: [], pushToken: '',
    publishMs: 1000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1',
    nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
    persistenceMode: 'file', postgres: null,
  };
  runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const users = join(directory, 'users.json');
  // This fixture exercises commissioning/OTA, which require Engineer access.
  const accounts = new AlgoUsers(users);
  await accounts.add('mobiletest', 'local browser test password', 'engineer');
  for (const role of ['viewer', 'operator']) await accounts.add(`${role}test`, 'local browser test password', role);
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({
    DATA_DIR: directory, ALGO_USERS_FILE: users,
    SESSION_SECRET: 'local-only-test-secret'.repeat(3),
  }, config.adminPassword), createConsole(runtime));
  await new Promise(resolve => handle.server.once('listening', resolve));
  base = `http://127.0.0.1:${handle.server.address().port}`;
});
after(async () => {
  await handle?.dispose();
  if (handle) await new Promise(resolve => handle.server.close(resolve));
  await runtime?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function fits(target, width) {
  const layout = await target.evaluate(() => ({
    viewport: innerWidth, page: document.documentElement.scrollWidth,
    smallTargets: innerWidth > 900 ? [] : [...document.querySelectorAll('button,select,.seg-opt,.toggles label')].flatMap(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && bounds.height && bounds.height < 43
        ? [element.getAttribute('aria-label') || element.textContent || element.id] : [];
    }),
    clipped: [...document.querySelectorAll('button,input,select')].flatMap(element => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || (bounds.left >= -1 && bounds.right <= innerWidth + 1)) return [];
      // A wide table or floor tab strip is intentionally scrollable within
      // its panel. Clipping ordinary form controls is still a failure.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) return [];
      }
      return [element.getAttribute('aria-label') || element.textContent || element.id];
    }),
  }));
  assert.equal(layout.viewport, width, 'overflow must not make a mobile browser zoom out');
  assert.ok(layout.page <= width + 1, `page width ${layout.page} exceeds ${width}`);
  assert.deepEqual(layout.clipped, [], 'form controls must stay reachable');
  assert.deepEqual(layout.smallTargets, [], 'touch controls must be at least 44px high');
}

async function shot(page, engine, name) {
  const output = process.env.ALGO_UI_SCREENSHOTS;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, `${engine}-${name}.png`), fullPage: true });
}

// Populate tables with long names and provide an available, disconnected
// cluster. The sign-in dialog can be exercised without contacting HKU.
async function trainingFixtures(page) {
  await page.route('**/api/train/jobs', route => route.request().method() !== 'GET' ? route.continue() : route.fulfill({ json: { jobs: [{
    id: 'mobile-draft', name: 'occupancy_training_with_a_long_project_name',
    status: 'SUBMIT_FAILED', partition: 'gpu', gpus: 1, code: { kind: 'py', filename: 'train.py' },
    slurmJobId: null, createdAt: Date.now(), updatedAt: Date.now(),
  }] } }));
  await page.route('**/api/train/hpc', route => route.fulfill({ json: {
    available: true, reason: null, profile: null, domains: ['hku.hk', 'connect.hku.hk'],
    idleTtlSeconds: 600, ssh: { user: 'ing', host: '10.21.36.12', auth: 'shared-password' },
    session: { state: 'none', uid: null, expiresInSeconds: null }, lockedForSeconds: 0,
    running: null, firstUse: { hostKey: true, password: true },
  } }));
  await page.route('**/api/train/hpc/connect', route => route.fulfill({ status: 428, json: { needs: 'credentials' } }));
}

async function updatesFixtures(page) {
  await page.route('**/console-app/api/firmware', route => route.fulfill({ json: {
    pio: true, diskBytes: 1280048, building: null, rollout: null, history: [], builds: [{
      id: '0123456789abcdef', sha256: '0123456789abcdef'.repeat(4), size: 1280048,
      version: '1.7.2', state: 'ready', builtAt: Date.now(), files: 3,
    }],
  } }));
  await page.route('**/console-app/api/state', route => route.fulfill({ json: { nodes: [{
    uid: '02:00:00:00:00:01', label: 'Main Library / North / Sensor with a long name',
    registered: true, floorId: 'makerspace-a', online: true, address: 'gateway-route', transport: 'gateway',
  }] } }));
}

for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engine}: Viewer and Operator cannot initiate automatic TMflash authorization`, { timeout: 60_000 }, async () => {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const role of ['viewer', 'operator']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
          const login = await context.request.post(`${base}/auth/login`, { data: { username: `${role}test`, password: 'local browser test password' } });
          assert.equal(login.status(), 200);
          const page = await context.newPage();
          let authorizations = 0;
          page.on('request', request => { if (request.url().endsWith('/api/tmflash/authorize')) authorizations++; });
          const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          await page.goto(`${base}/tmflash/connect?challenge=${challenge}&state=${state}`);
          await page.getByRole('status').filter({ hasText: 'Engineer or Admin access is required' }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Retry connection' }).isDisabled(), true);
          assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
          assert.equal(authorizations, 0, 'automatic continuation must respect the account capability before requesting a code');
          for (const scheme of ['dark', 'light']) {
            await page.emulateMedia({ colorScheme: scheme });
            await fits(page, 390);
            await shot(page, engine, `tmflash-${role}-${scheme}-390`);
          }
          const refused = await context.request.post(`${base}/api/tmflash/authorize`, { headers: { 'x-tm-algo': '1' }, data: { challenge, state } });
          assert.equal(refused.status(), 403, 'the server independently enforces commissioning permission');
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  });
  test(`${engine}: algo sign-in automatically connects TMflash, matches the physical request and revokes access`, { timeout: 60_000 }, async () => {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const page = await context.newPage();
    try {
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      // Capture the real server's code before signing in. No second click
      // should be needed after account verification to initiate the return.
      let callback, authorizations = 0;
      await page.route('**/api/tmflash/authorize', async route => {
        authorizations++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        callback = new URL((await response.json()).redirect);
        await route.fulfill({ status: 503, json: { error: 'Temporary handoff failure' } });
      });
      await page.goto(`${base}/tmflash/connect?challenge=${challenge}&state=${state}`);
      await page.getByLabel('Username').fill('mobiletest');
      await page.getByLabel('Password', { exact: true }).fill('local browser test password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: 'Connect TMflash' }).waitFor();
      await page.getByRole('alert').filter({ hasText: 'Temporary handoff failure' }).waitFor();
      assert.equal(authorizations, 1, 'account sign-in must automatically request exactly one callback');
      assert.equal(await page.getByRole('button', { name: 'Authorize TMflash' }).count(), 0);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        await fits(page, 390);
        await shot(page, engine, `tmflash-connect-${scheme}-390`);
      }
      // Retry a temporary failure, then let the page attempt its actual
      // custom-scheme return. Headless browsers cannot open a native app,
      // so the return button must remain available for blocked handoffs.
      await page.unroute('**/api/tmflash/authorize');
      await page.route('**/api/tmflash/authorize', async route => {
        authorizations++;
        const response = await route.fetch();
        callback = new URL((await response.json()).redirect);
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Retry connection' }).click();
      await page.getByRole('button', { name: 'Return to TMflash' }).waitFor();
      assert.equal(authorizations, 2);
      await page.getByRole('button', { name: 'Return to TMflash' }).click();
      assert.equal(authorizations, 2, 'a fallback return must reuse the same one-use code');
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        await fits(page, 390);
        await shot(page, engine, `tmflash-return-${scheme}-390`);
      }
      assert.equal(callback.protocol, 'hk.hkumyseat.tmflash:');
      assert.equal(callback.searchParams.get('state'), state);
      const exchanged = await context.request.post(`${base}/api/tmflash/exchange`, { data: { code: callback.searchParams.get('code'), verifier } });
      assert.equal(exchanged.status(), 201);
      const issued = await exchanged.json();
      assert.equal(issued.user, 'mobiletest');
      await page.goto(`${base}/adoption`);
      await page.getByRole('heading', { name: 'TMflash sign-in' }).waitFor();
      const uid = engine === 'chromium' ? '30:ed:a0:11:22:01' : '30:ed:a0:11:22:02';
      const queued = await context.request.post(`${base}/api/provision/request`, {
        headers: { authorization: `Bearer ${issued.token}` }, data: { uid, label: 'New physical sensor', firmware: '1.6' },
      });
      assert.equal(queued.status(), 202);
      const request = await queued.json();
      const card = page.locator('.ad-request').filter({ hasText: uid });
      await card.waitFor();
      assert.equal(await card.getByRole('button', { name: 'Approve device' }).isDisabled(), true);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await fits(page, width);
          await shot(page, engine, `adoption-${scheme}-${width}`);
        }
      }
      await card.getByLabel(`UID from TMflash for ${uid}`).fill(uid);
      await card.getByLabel(`Code from TMflash for ${uid}`).fill(request.pairingCode);
      await card.getByRole('button', { name: 'Approve device' }).click();
      await page.getByRole('status').filter({ hasText: `${uid} approved` }).waitFor();
      const device = page.locator('.ad-device').filter({ hasText: uid });
      await device.getByText('Waiting for reports', { exact: true }).waitFor();
      await device.getByText('Unplaced', { exact: true }).waitFor();
      const tokenRow = page.locator('.ad-token-list li').filter({ hasText: 'TMflash on Mac' }).last();
      await tokenRow.getByRole('button', { name: 'Revoke' }).click();
      await page.getByRole('status').filter({ hasText: 'TMflash session revoked.' }).waitFor();
      const refused = await context.request.get(`${base}/api/provision/preflight`, { headers: { authorization: `Bearer ${issued.token}` } });
      assert.equal(refused.status(), 401);
    } finally { await context.close(); await browser.close(); }
  });
  test(`${engine}: TMflash rejects invalid requests and unsafe handoffs and retries an expired return`, { timeout: 60_000 }, async () => {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      const login = await context.request.post(`${base}/auth/login`, { data: { username: 'mobiletest', password: 'local browser test password' } });
      assert.equal(login.status(), 200);
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let authorizations = 0;
      await page.route('**/api/tmflash/authorize', async route => { authorizations++; await route.fulfill({ json: { redirect: 'https://example.com/' } }); });
      await page.goto(`${base}/tmflash/connect?challenge=${challenge}&state=${state}&state=${state}`);
      await page.getByRole('alert').filter({ hasText: 'This sign-in request is invalid' }).waitFor();
      assert.equal(authorizations, 0, 'ambiguous requests cannot initiate sign-in');
      await page.goto(`${base}/tmflash/connect?challenge=${challenge}&state=${state}`);
      await page.getByRole('alert').filter({ hasText: 'Invalid TMflash return address' }).waitFor();
      assert.equal(new URL(page.url()).origin, base, 'an unsafe return URL cannot navigate away');
      await page.unroute('**/api/tmflash/authorize');
      await page.route('**/api/tmflash/authorize', async route => { authorizations++; await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Sign in</h1>' }); });
      await page.getByRole('button', { name: 'Retry connection' }).click();
      await page.getByRole('alert').filter({ hasText: 'The console returned a sign-in page' }).waitFor();
      await page.unroute('**/api/tmflash/authorize');
      await page.route('**/api/tmflash/authorize', async route => { authorizations++; await route.fulfill({ response: await route.fetch() }); });
      await page.clock.install();
      await page.getByRole('button', { name: 'Retry connection' }).click();
      await page.getByRole('button', { name: 'Return to TMflash' }).waitFor();
      assert.equal(authorizations, 3);
      await page.clock.fastForward(60_000);
      await page.getByRole('button', { name: 'Return to TMflash' }).click();
      await page.getByRole('button', { name: 'Return to TMflash' }).waitFor();
      assert.equal(authorizations, 4, 'an expired return must obtain a fresh one-use code');
    } finally { await context.close(); await browser.close(); }
  });
  test(`${engine}: the algorithm console works on phones, tablets and desktop`, { timeout: 180_000 }, async t => {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const errors = [];
    // The spec's "ResizeObserver loop" notice means a resize was deferred to
    // the next frame, not that anything failed. WebKit reports it as an error
    // when React Flow re-measures during a viewport change, at random, and it
    // blocked a deploy of unchanged code. Every other error still fails.
    const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/;
    context.on('page', page => page.on('pageerror', error => { if (!benign.test(error.message)) errors.push(error.message); }));
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    try {
      await page.goto(`${base}/login`);
      await page.getByLabel('Username').waitFor();
      await fits(page, 320);
      // Exercise the minimum width of Turnstile without relying on a third
      // party network challenge or changing production authentication.
      await page.locator('.cx-form').evaluate(form => {
        const widget = document.createElement('div');
        widget.style.width = '300px'; widget.style.height = '65px';
        form.appendChild(widget);
      });
      assert.ok(await page.locator('.cx-form').evaluate(form => form.scrollWidth <= form.clientWidth));
      await page.getByLabel('Username').fill('mobiletest');
      await page.getByLabel('Password', { exact: true }).fill('local browser test password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).tap();
      await page.getByText('Welcome back, mobiletest.').waitFor();

      for (const viewport of [
        { width: 320, height: 844 }, { width: 390, height: 844 },
        { width: 768, height: 1024 }, { width: 844, height: 390 },
        { width: 1024, height: 844 }, { width: 1440, height: 1000 },
      ]) {
        await t.test(`${viewport.width}×${viewport.height}: all modules fit`, async () => {
          await page.setViewportSize(viewport);
          for (const path of ['/', '/flow', '/train', '/console', '/updates', '/adoption']) {
            await page.unrouteAll({ behavior: 'wait' });
            if (path === '/train') await trainingFixtures(page);
            if (path === '/updates') await updatesFixtures(page);
            await page.goto(`${base}${path}`);
            await page.locator('.cx-header').waitFor();
            if (path === '/flow') {
              await page.locator('.react-flow__node').first().waitFor();
              const graph = await page.locator('.canvas').boundingBox();
              assert.ok(graph.width >= viewport.width * 0.35 && graph.height >= 120, 'graph must have usable space');
              if (viewport.width <= 900) await page.waitForFunction(() =>
                document.querySelector('.react-flow__node[data-id="bg-1"]')?.getBoundingClientRect().width >= 155);
            }
            if (path === '/train') await page.locator('.cx-jobs').getByText('SUBMIT_FAILED').waitFor();
            if (path === '/updates') await page.getByText('Connected to edge', { exact: false }).waitFor();
            if (path === '/adoption') await page.getByText('No requests waiting.', { exact: false }).waitFor();
            await fits(page, viewport.width);
            if (path === '/console') {
              await page.frameLocator('.cx-frame').locator('#conn.good').waitFor();
              const frame = page.frames().find(frame => frame.url().includes('/console-app/'));
              await fits(frame, viewport.width);
              // The last floor must be reachable by scrolling the tab strip.
              await frame.locator('#floor-tabs button').last().tap();
              assert.equal(await frame.locator('#floor-tabs button').last().getAttribute('aria-selected'), 'true');
            }
            if (viewport.width === 390) await shot(page, engine, path.slice(1) || 'home');
          }
        });
      }

      await t.test('a new draft has a self-contained CPU example ready to save on a phone', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        await trainingFixtures(page);
        await page.goto(`${base}/train`);
        await page.getByRole('button', { name: 'New draft', exact: true }).tap();
        assert.equal(await page.getByLabel('Job name', { exact: true }).inputValue(), 'synthetic_demo');
        assert.equal(await page.getByLabel('CPUs', { exact: true }).inputValue(), '1');
        assert.equal(await page.getByLabel('Mem GB', { exact: true }).inputValue(), '1');
        assert.equal(await page.getByLabel('GPUs', { exact: true }).inputValue(), '0');
        assert.equal(await page.getByLabel('Time', { exact: true }).inputValue(), '0:02:00');
        assert.equal(await page.getByLabel('Arguments', { exact: true }).inputValue(), '--epochs 20 --samples 1000 --seed 42');
        assert.equal(await page.getByLabel('Conda env', { exact: true }).inputValue(), '');
        assert.equal(await page.getByLabel('Environment', { exact: true }).inputValue(), '');
        assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
        await page.getByText('# TMedge synthetic training demo for the HKU SLURM cluster.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Save draft', exact: true }).tap();
        await page.getByText('Draft synthetic_demo saved', { exact: true }).waitFor();
        const jobId = new URL(page.url()).searchParams.get('job');
        assert.ok(jobId, 'the example is saved as a new job');
        const savedScript = await context.request.get(`${base}/api/train/jobs/${jobId}/file?path=train.py`);
        assert.equal(savedScript.status(), 200);
        assert.equal(await savedScript.text(), readFileSync('algo-app/src/console/train/example.py', 'utf8'), 'saving keeps the same runnable example');
        for (const colorScheme of ['dark', 'light']) {
          await page.emulateMedia({ colorScheme });
          await fits(page, 390);
          await shot(page, engine, `example-draft-${colorScheme}`);
        }
        await page.emulateMedia({ colorScheme: 'dark' });
      });

      await t.test('waiting jobs show the scheduler reason and when it was last checked on a phone', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        await trainingFixtures(page);
        const job = {
          id: 'pending-job', status: 'PENDING', slurmJobId: 324,
          spec: { name: 'pending_training', partition: 'debug', cpusPerTask: 4, memGb: 16, gpus: 1,
            timeLimit: '2:00:00', modules: [], condaEnv: null, entrypoint: 'train.py', args: [], env: {}, notifyEmail: false },
          code: { kind: 'py', filename: 'train.py', bytes: 9, unpackedBytes: 9, fileCount: 1, py: ['train.py'] },
          sbatch: '', createdAt: Date.now(), updatedAt: Date.now(), lastPolledAt: Date.now() - 2 * 60_000,
          submittedAt: Date.now(), startedAt: null, endedAt: null, exitCode: null, remoteDir: '~/hpc-dash/jobs/pending-job',
          slurmState: 'PENDING', slurmReason: 'ReqNodeNotAvail, UnavailableNodes:iw-g2', elapsedSeconds: 0, node: null, message: null,
        };
        await page.route('**/api/train/jobs', route => route.fulfill({ json: { jobs: [{
          ...job, name: job.spec.name, partition: 'debug', gpus: 1,
        }] } }));
        await page.route('**/api/train/jobs/pending-job', route => route.fulfill({ json: { job } }));
        await page.route('**/api/train/jobs/pending-job/file**', route => route.fulfill({ body: 'print(1)\n', contentType: 'text/plain' }));
        await page.goto(`${base}/train`);
        await page.locator('.cx-jobs').getByText(job.spec.name).tap();
        await page.getByText(`SLURM reason: ${job.slurmReason}`, { exact: true }).waitFor();
        await page.getByText('Last checked 2m ago · Sign in and refresh for the current state', { exact: true }).waitFor();
        for (const colorScheme of ['dark', 'light']) {
          await page.emulateMedia({ colorScheme });
          await fits(page, 390);
          await shot(page, engine, `pending-job-${colorScheme}`);
        }
        await page.emulateMedia({ colorScheme: 'dark' });
      });

      await t.test('flow tabs preserve edits and desktop sizes across rotation', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        // These are legal desktop sizes that used to swallow the whole
        // graph when the viewport became narrower than the stored columns.
        await page.evaluate(() => {
          localStorage.setItem('algo.pane.lib', '420');
          localStorage.setItem('algo.pane.insp', '620');
          localStorage.setItem('algo.pane.out', '1200');
        });
        const pipeline = (await (await context.request.get(`${base}/api/pipeline`)).json()).pipeline;
        const catalogue = (await (await context.request.get(`${base}/api/catalogue`)).json()).nodes;
        const plane = { pixels: Buffer.alloc(32 * 24, 100).toString('base64'), min: 20, max: 30 };
        await page.routeWebSocket(url => url.pathname === '/ws', socket => socket.send(JSON.stringify({
          type: 'frame', frameId: 7, timestamp: Date.now(), uid: pipeline.uid, previewUnavailable: null,
          envelopes: pipeline.nodes.map(node => {
            const spec = catalogue.find(spec => spec.type === node.type);
            return {
              frameId: 7, timestamp: Date.now(), nodeId: node.id, type: node.type, domain: spec.domain,
              executionTimeMs: 1, outputs: { background: plane, diff: plane, foreground: plane },
              debug: {}, metrics: { frame: 7 }, parameters: Object.fromEntries(spec.params.map(param => [param.id, param.min])),
            };
          }),
        })));
        await page.goto(`${base}/flow`);
        await page.locator('.react-flow__node').first().waitFor();
        await page.getByRole('tab', { name: 'Inspector', exact: true }).tap();
        const value = page.locator('.inspector input[type=number]').first();
        await value.fill('5');
        const stage = await page.getByLabel('Stage', { exact: true }).inputValue();
        await page.getByRole('tab', { name: 'Output', exact: true }).tap();
        await page.locator('.grid-canvas').first().waitFor();
        const image = await page.locator('.grid-canvas').first().boundingBox();
        assert.ok(image.width >= 300 && image.width <= 390, 'thermal output should fill a phone panel');
        await fits(page, 390);
        await shot(page, engine, 'output');
        await page.getByRole('tab', { name: 'Graph', exact: true }).tap();
        await page.getByRole('tab', { name: 'Graph', exact: true }).press('ArrowRight');
        assert.equal(await page.getByRole('tab', { name: 'Stages', exact: true }).getAttribute('aria-selected'), 'true');
        await page.getByRole('tab', { name: 'Inspector', exact: true }).tap();
        assert.equal(await value.inputValue(), '5');
        assert.equal(await page.getByLabel('Stage', { exact: true }).inputValue(), stage);
        await shot(page, engine, 'inspector');
        await page.setViewportSize({ width: 1024, height: 844 });
        await page.locator('.mobile-panes').waitFor({ state: 'detached' });
        await fits(page, 1024);
        assert.ok((await page.locator('.canvas').boundingBox()).width >= 350);
        assert.equal(await value.inputValue(), '5');
        assert.equal(await page.evaluate(() => localStorage.getItem('algo.pane.lib')), '420');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('tab', { name: 'Graph', exact: true }).tap();
        await page.locator(`.react-flow__node[data-id="${stage}"]`).tap();
        assert.equal(await page.getByRole('tab', { name: 'Inspector', exact: true }).getAttribute('aria-selected'), 'true');
      });

      await t.test('sign-in and OTA confirmation remain usable in short viewports', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 320, height: 568 });
        await trainingFixtures(page);
        await page.goto(`${base}/train`);
        await page.locator('.cx-console .seg-opt').filter({ hasText: /ssh ing/ }).tap();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await fits(page, 320);
        assert.ok((await dialog.boundingBox()).height <= 536);
        await dialog.getByRole('button', { name: 'Sign in', exact: true }).scrollIntoViewIfNeeded();
        await shot(page, engine, 'hku-sign-in');
        await dialog.getByRole('button', { name: 'Close', exact: true }).tap();
        await dialog.waitFor({ state: 'detached' });
        await page.unrouteAll({ behavior: 'wait' });
        await updatesFixtures(page);
        await page.goto(`${base}/updates`);
        await page.getByRole('button', { name: /Start update/ }).tap();
        const confirmation = page.getByRole('dialog');
        await confirmation.waitFor();
        await fits(page, 320);
        assert.ok((await confirmation.boundingBox()).height <= 536);
        await confirmation.getByRole('button', { name: 'Back', exact: true }).tap();
        assert.equal(await confirmation.isVisible(), false);
      });
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } finally { await browser.close(); }
  });
}
