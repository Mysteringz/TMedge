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

// The sign-in limiter allows ten attempts per address in five minutes, and the
// two engines of this suite already spend all ten. A later test that needs a
// role's session takes the one the first test made instead of signing in again.
const signedIn = new Map();
async function sessionFor(browser, engine, role, options = {}) {
  const saved = signedIn.get(`${engine}:${role}`);
  const context = await browser.newContext({ ...options, ...(saved ? { storageState: saved } : {}) });
  if (!saved) {
    // Only when the test that signs this role in was filtered out of the run.
    const login = await context.request.post(`${base}/auth/login`, { data: { username: `${role}test`, password: 'local browser test password' } });
    assert.equal(login.status(), 200);
  }
  return context;
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
          signedIn.set(`${engine}:${role}`, await context.storageState());
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
    // WebKit reports a request the page made just as it was being left as
    // "Fetch API cannot load <url> due to access control checks", and that
    // console line reaches us as a page error. A request to the page's own
    // origin cannot fail an access control check, so about this origin the
    // words only ever mean "the test moved on while the page was starting".
    // It failed main's build of code that had passed as a pull request an
    // hour before. The same words about any other origin still fail.
    const abandoned = message => message.endsWith(' due to access control checks.')
      && (message.startsWith(`/${new URL(base).host}/`) || message.includes(`${base}/`));
    context.on('page', page => page.on('pageerror', error => { if (!benign.test(error.message) && !abandoned(error.message)) errors.push(error.message); }));
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
      await page.getByRole('heading', { name: 'Welcome back, mobiletest.' }).waitFor();

      for (const viewport of [
        { width: 320, height: 844 }, { width: 390, height: 844 },
        { width: 768, height: 1024 }, { width: 844, height: 390 },
        { width: 1024, height: 844 }, { width: 1440, height: 1000 },
      ]) {
        await t.test(`${viewport.width}×${viewport.height}: all modules fit`, async () => {
          await page.setViewportSize(viewport);
          for (const path of ['/', '/flow', '/train', '/console', '/updates', '/analytics', '/analytics/usage', '/analytics/server', '/adoption']) {
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
            // The landing page's workspace arrives after the module list: measure it, not the gap it will fill.
            if (path === '/') { await page.locator('.ws[data-ready]').waitFor(); await page.locator('.ws-panel__body > *').first().waitFor(); }
            if (path.startsWith('/analytics')) await page.locator('.an-view .an-metrics, .an-view .an-notice').first().waitFor();
            await fits(page, viewport.width);
            if (path === '/console') {
              await page.frameLocator('.cx-frame').locator('#conn.good').waitFor();
              const frame = page.frames().find(frame => frame.url().includes('/console-app/'));
              await fits(frame, viewport.width);
              // The last floor must be reachable by scrolling the tab strip.
              await frame.locator('#floor-tabs button').last().tap();
              assert.equal(await frame.locator('#floor-tabs button').last().getAttribute('aria-selected'), 'true');
            }
            if (viewport.width === 390) await shot(page, engine, path.slice(1).replaceAll('/', '-') || 'home');
          }
        });
      }

      await t.test('the landing page: one box that searches the site first and asks the assistant otherwise, a welcome that is always readable, and the modules this person uses', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        const home = async () => { await page.goto(base); await page.locator('.ws[data-ready]').waitFor(); };
        const box = page.getByRole('combobox', { name: 'Search the site or ask a question' });
        const options = page.getByRole('option');

        // No model is set up in this fixture: the page says so and offers only what works.
        await home();
        await page.getByText('Ask AI is not set up on this server yet.').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Ask AI' }).isDisabled(), true);
        await box.fill('how does counting work?');
        await page.getByText('Nothing on the site matches').waitFor();
        assert.equal(await options.count(), 0, 'nothing is offered that cannot answer');
        await fits(page, 390);

        // The welcome types itself in other languages. Its name for a screen
        // reader never changes, and the person's name is never part of the act.
        assert.equal(await page.locator('.cx-welcome b').textContent(), 'mobiletest');
        assert.equal(await page.locator('.cx-module').count() + await page.getByText('Select module').count(), 0, 'the module selector is gone');
        await page.waitForFunction(() => document.querySelector('.cx-welcome [lang]')?.getAttribute('lang') !== 'en', null, { timeout: 15_000 });
        assert.equal(await page.getByRole('heading', { level: 1 }).getAttribute('aria-label'), 'Welcome back, mobiletest.');
        assert.equal(await page.locator('.cx-welcome b').textContent(), 'mobiletest');
        await fits(page, 390);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await home();
        await page.waitForTimeout(4500);
        assert.equal(await page.locator('.cx-welcome__typed').textContent(), 'Welcome back', 'someone who asked for less motion gets the line, still');
        await page.emulateMedia({ reducedMotion: 'no-preference' });

        // With a model: a stand-in that answers, and remembers what it was asked.
        const asked = [];
        await page.route('**/api/assistant', route => route.fulfill({ json: { data: { available: true, reason: null, model: 'test-model:1b', knowledgeUpdatedAt: Date.now() }, error: null } }));
        await page.route('**/api/assistant/ask', route => {
          asked.push(route.request().postDataJSON());
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: delta\ndata: {"text":"Each table has **one** authority sensor."}\n\nevent: done\ndata: {}\n\n' });
        });
        await home();
        // The name of something on the site is looked up on the site, and Enter opens it.
        await box.fill('debug console');
        await options.filter({ hasText: 'Live thermal frames' }).waitFor();
        assert.match(await options.first().textContent(), /Debug console/, 'the site comes first for what the site has');
        assert.match(await options.last().textContent(), /Ask AI/, 'and the assistant is still one row away');
        // A question goes to the assistant first, even when the site has matches for its words.
        await box.fill('how does the debug console work?');
        await options.filter({ hasText: 'Ask AI' }).waitFor();
        assert.match(await options.first().textContent(), /Ask AI/);
        // So does anything the site has no name for.
        await box.fill('thermal drift');
        await options.first().waitFor();
        assert.match(await options.first().textContent(), /Ask AI/);
        assert.equal(await options.count(), 1);
        await fits(page, 390);
        await box.fill('why is a table unknown?');
        await box.press('Enter');
        await page.locator('.ws-answer__a').filter({ hasText: 'Each table has one authority sensor.' }).waitFor();
        assert.equal(await page.locator('.ws-answer__a strong').textContent(), 'one', 'emphasis is shown as emphasis, built as elements');
        assert.deepEqual(asked[0], { question: 'why is a table unknown?', history: [] });
        await page.locator('.ws-ai-label').waitFor();
        await page.getByText('it can be wrong', { exact: false }).waitFor();
        await fits(page, 390);
        // A follow-up carries what was just said, so "it" means something.
        await box.fill('and when is it not?');
        await box.press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.ws-answer__turn').length === 2);
        assert.deepEqual(asked[1].history, [{ role: 'user', content: 'why is a table unknown?' }, { role: 'assistant', content: 'Each table has **one** authority sensor.' }]);
        await page.getByRole('button', { name: 'Close answers' }).tap();
        assert.equal(await page.locator('.ws-answer').count(), 0);

        // What this person opens is what the page offers first next time.
        await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('tm-algo-usage')) localStorage.removeItem(key); });
        await home();
        assert.equal(await page.locator('.ws-places__label').textContent(), 'Jump to');
        assert.equal(await page.locator('.ws-place').first().textContent(), 'Algorithm flow');
        await page.getByRole('link', { name: 'Adoption', exact: true }).tap();
        await page.getByText('No requests waiting.', { exact: false }).waitFor();
        await home();
        assert.equal(await page.locator('.ws-places__label').textContent(), 'Suggested for you');
        assert.equal(await page.locator('.ws-place').first().textContent(), 'Adoption');
        assert.equal(await page.locator('.ws-place').count(), 6, 'on a phone, where the header lists no modules, every module is still one tap away');
        await fits(page, 390);
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await page.locator('.ws-place:visible').count(), 4, 'beside a header that lists them all, only the most used are repeated');
        await page.setViewportSize({ width: 390, height: 844 });
      });

      await t.test('the landing page workspace finds things, delivers mail to the person it was sent to, and offers each role only what it may do', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        // Both engines run against one server, so what this writes is named for the engine writing it.
        const subject = `Background reset on node 2 (${engine})`, wish = `Export a floor as CSV (${engine})`;
        const home = async (target) => { await target.goto(base); await target.locator('.ws[data-ready]').waitFor(); };
        const toast = (target, text) => target.locator('.cx-toast').filter({ hasText: text }).waitFor();
        await home(page);

        // The box: every word narrows the list, and Enter opens the first answer.
        const prompt = page.getByRole('combobox', { name: 'Search the site or ask a question' });
        await prompt.fill('analytics');
        await page.getByRole('option').filter({ hasText: 'HKUMySeat usage' }).waitFor();
        const broad = await page.getByRole('option').count();
        await prompt.fill('analytics server');
        await page.getByRole('option').filter({ hasText: 'Server and back end' }).waitFor();
        assert.ok(await page.getByRole('option').count() < broad, 'a second word must only narrow the results');
        assert.match(await page.getByRole('option').first().textContent(), /Server and back end/, 'the page named by both words comes before the module that only mentions one');
        await fits(page, 390);
        await prompt.press('Enter');
        await page.waitForURL(/\/analytics\/server/);
        await home(page);
        await prompt.fill('no such thing anywhere');
        await page.getByText('Nothing on the site matches').waitFor();
        assert.equal(await page.getByRole('option').count(), 0);

        // A member's name is a way to write to them.
        await prompt.fill('viewertest');
        await page.getByRole('option').filter({ hasText: 'Write a message' }).waitFor();
        await prompt.press('Enter');
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('heading', { name: 'New message' }).waitFor();
        assert.equal(await dialog.getByRole('checkbox', { name: 'viewertest' }).isChecked(), true);
        await dialog.getByRole('button', { name: 'Send message' }).tap();
        await dialog.getByText('Enter a subject.').waitFor();
        assert.equal(await dialog.getByLabel('Subject').evaluate(field => field === document.activeElement), true, 'focus goes to the first thing to fix');
        await dialog.getByLabel('Subject').fill(subject);
        await dialog.getByLabel('Message').fill('Please check it before the pilot.\nThanks.');
        await fits(page, 390);
        await dialog.getByRole('button', { name: 'Send message' }).tap();
        await toast(page, 'Message sent to viewertest.');
        assert.equal(await dialog.count(), 0);

        // A request, and from it a task for somebody else.
        await page.getByRole('tab', { name: /Feature requests/ }).tap();
        await page.getByRole('button', { name: 'New request' }).tap();
        await dialog.getByLabel('Title').fill(wish);
        await dialog.getByRole('button', { name: 'File request' }).tap();
        await page.getByRole('heading', { name: wish }).waitFor();
        await fits(page, 390);
        await page.getByRole('button', { name: 'Create task', exact: true }).tap();
        assert.equal(await dialog.getByLabel('Title').inputValue(), wish, 'a task made from a request starts with its title');
        await dialog.getByLabel('Assigned to').selectOption('viewertest');
        await fits(page, 390);
        await dialog.getByRole('button', { name: 'Create task' }).tap();
        await toast(page, /^Task T-\d+ assigned to viewertest\.$/);
        await page.locator('.ws-task').filter({ hasText: wish }).waitFor();
        await fits(page, 390);

        // The person it was all sent to, who holds the least access there is.
        const theirs = await sessionFor(browser, engine, 'viewer', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
        try {
          const viewer = await theirs.newPage();
          viewer.setDefaultTimeout(10_000);
          await home(viewer);
          await viewer.getByRole('radiogroup', { name: 'Mailbox' }).getByText('1 unread').waitFor({ state: 'attached' });
          await viewer.getByRole('button', { name: new RegExp(`Unread: ${subject.replace(/[()]/g, '\\$&')}`) }).tap();
          await viewer.locator('.ws-prose').waitFor();
          assert.equal(await viewer.locator('.ws-prose').textContent(), 'Please check it before the pilot.\nThanks.', 'a message is shown as it was written');
          await viewer.waitForFunction(() => !document.querySelector('[aria-labelledby="ws-mail-title"] .ws-count'), null, { timeout: 10_000 });
          await fits(viewer, 390);

          await viewer.getByRole('tab', { name: /Tasks/ }).tap();
          assert.equal(await viewer.getByRole('button', { name: 'New task' }).count(), 0, 'a viewer is not offered task creation');
          await viewer.getByLabel(`Status of ${wish}`).selectOption('doing');
          await toast(viewer, /^T-\d+ moved to in progress\.$/);
          await viewer.locator('.ws-task .ws-row').filter({ hasText: wish }).tap();
          await viewer.getByRole('dialog').getByText('This task is yours').waitFor();
          assert.equal(await viewer.getByRole('dialog').locator('input, textarea, select').count(), 0, 'someone who cannot edit a task is shown it, not a form');
          await fits(viewer, 390);
          await viewer.getByRole('dialog').getByRole('button', { name: 'Close' }).last().tap();

          await viewer.getByRole('tab', { name: /Feature requests/ }).tap();
          await viewer.getByRole('button', { name: `Vote for ${wish}. 1 vote.` }).tap();
          await viewer.getByRole('button', { name: `Remove your vote from ${wish}. 2 votes.` }).waitFor();
          await viewer.locator('.ws-req .ws-row').filter({ hasText: wish }).tap();
          await viewer.getByRole('heading', { name: wish }).waitFor();
          assert.equal(await viewer.locator('#ws-request-status').count(), 0, 'a viewer cannot decide a request');
          assert.equal(await viewer.getByRole('button', { name: 'Create task', exact: true }).count(), 0);
          await fits(viewer, 390);
          if (process.env.ALGO_UI_SCREENSHOTS) await shot(viewer, engine, 'home-workspace-viewer');
        } finally { await theirs.close(); }

        // And the member who was not written to has none of it.
        const outsider = await sessionFor(browser, engine, 'operator');
        try {
          const view = await (await outsider.request.get(`${base}/api/workspace`)).json();
          assert.equal(view.data.mail.inbox.length + view.data.mail.sent.length, 0);
          assert.ok(!JSON.stringify(view.data.mail).includes('Background reset'));
        } finally { await outsider.close(); }
      });

      await t.test('analytics says what it cannot know instead of showing zero, and gives every chart as a table', async () => {
        await page.unrouteAll({ behavior: 'wait' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/analytics`);
        await page.getByRole('heading', { name: 'Analytics', exact: true }).waitFor();
        // This edge publishes to no web tier and no sensor has reported: both
        // figures are unknown, and neither may be drawn as 0.
        await page.getByText('Student usage is not set up').waitFor();
        for (const label of ['Students online', 'Seats taken now']) {
          const tile = page.locator('.an-metric').filter({ hasText: label });
          assert.equal((await tile.locator('.an-metric__value').innerText()).trim(), '–', `${label} is not known`);
        }
        await page.getByRole('tab', { name: 'Server and back end' }).tap();
        await page.waitForURL('**/analytics/server**');
        const memory = page.locator('.an-chart').filter({ has: page.getByRole('heading', { name: 'Memory', exact: true }) });
        await memory.locator('svg[role=img]').waitFor();
        await memory.getByRole('button', { name: 'View as table' }).tap();
        assert.ok(await memory.locator('tbody tr').count() >= 1, 'the same readings, without hovering');
        await memory.getByRole('button', { name: 'View as chart' }).tap();
        await memory.locator('svg[role=img]').waitFor();
        await page.locator('.an-range .seg-opt', { hasText: '7 days' }).tap();
        await page.waitForURL('**range=7d');
        // History began minutes ago; a week-long chart says so rather than implying a quiet week.
        await page.getByText('History starts part-way through this range').waitFor();
        await fits(page, 390);
        await shot(page, engine, 'analytics-server-7d');
      });

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
