/** The console's header and a person's own account page, in a browser.
 *
 * Three things a person meets before any module: the Devices menu (Updates,
 * Adoption, TMflash), the account icon (who they are, their settings, the way
 * out), and the settings page behind it. And one thing they should never
 * meet: a page an ad blocker has emptied.
 *
 * Run npm run build and npx playwright install chromium webkit first; it
 * runs with npm run test:algo-mobile.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { createConsole } from '../dist/src/edge/console.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { KEY, siteJson, nodesJson } from '../dist/test/fixtures.js';
import { FakeGitHub, tmsenseRelease } from '../dist/test/fake-github.js';
import { GitHubReleaseSource } from '../dist/src/infrastructure/firmware-release/github-release-source.js';

const PASSWORD = 'local browser test password';
let runtime, handle, base, directory;
const originalDataDir = process.env.DATA_DIR;
const github = new FakeGitHub();
github.latest = tmsenseRelease('tmsense-1.6');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tmedge-shell-'));
  writeFileSync(join(directory, 'nodes.json'), JSON.stringify(nodesJson()));
  process.env.DATA_DIR = directory;
  const config = {
    edgeId: 'console-shell', keys: [KEY], allowUnsigned: false,
    udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: join(directory, 'nodes.json'), dataDir: directory,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1',
    adminPassword: 'local-browser-test', flashToken: null, pushUrls: [], pushToken: '',
    publishMs: 1000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1',
    nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null,
    persistenceMode: 'file', postgres: null,
  };
  runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const users = join(directory, 'users.json');
  const accounts = new AlgoUsers(users);
  await accounts.add('engineer', PASSWORD, 'engineer', undefined, ['firmware', 'hardware']);
  await accounts.add('viewer', PASSWORD, 'viewer');
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({
    DATA_DIR: directory, ALGO_USERS_FILE: users, SESSION_SECRET: 'local-only-test-secret'.repeat(3),
  }, config.adminPassword), createConsole(runtime), { firmwareRelease: new GitHubReleaseSource(undefined, github.fetch) });
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

async function open(browser, user, path, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const login = await context.request.post(`${base}/auth/login`, { data: { username: user, password: PASSWORD } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}${path}`);
  await page.locator('.cx-header').waitFor();
  return { context, page, errors };
}

async function shot(page, name) {
  const output = process.env.ALGO_UI_SCREENSHOTS;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
}

async function fits(page, width, scope = '.cx') {
  const layout = await page.evaluate((selector) => ({
    viewport: innerWidth, page: document.documentElement.scrollWidth,
    small: innerWidth > 900 ? [] : [...document.querySelectorAll(`${selector} button, ${selector} .acct-check, .cx-account-panel a`)].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && bounds.height && bounds.height < 43 ? [element.textContent || element.getAttribute('aria-label')] : [];
    }),
    clipped: [...document.querySelectorAll(`${selector} button, ${selector} input, ${selector} a`)].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return !bounds.width || (bounds.left >= -1 && bounds.right <= innerWidth + 1) ? [] : [element.textContent || element.getAttribute('aria-label')];
    }),
  }), scope);
  assert.equal(layout.viewport, width);
  assert.ok(layout.page <= width + 1, `page width ${layout.page} exceeds ${width}`);
  assert.deepEqual(layout.clipped, [], 'controls must stay reachable');
  assert.deepEqual(layout.small, [], 'touch controls must be at least 44px high');
}

test('chromium: Updates, Adoption and TMflash are one Devices menu, and ML is still its own', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer', '/');
  try {
    const modules = page.locator('.cx-header').getByRole('navigation', { name: 'Modules', exact: true });
    assert.deepEqual(await modules.locator(':scope > *').evaluateAll((items) => items.map((item) => item.textContent.replace(/\s*▾$/, ''))),
      ['Algorithm flow', 'ML', 'Debug console', 'Devices', 'Analytics'], 'five places in the bar, in the order of the modules');
    for (const name of ['Updates', 'Adoption', 'TMflash']) assert.equal(await modules.getByRole('link', { name, exact: true }).count(), 0, `${name} is inside the menu, not beside it`);

    const devices = modules.getByRole('button', { name: 'Devices', exact: true });
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    await devices.click();
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['Updates', 'Adoption', 'TMflash']);
    await shot(page, 'devices-menu-1280');
    await page.keyboard.press('Escape');
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    assert.equal(await devices.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the menu');

    for (const [name, path, heading] of [['Updates', '/updates', 'Updates'], ['Adoption', '/adoption', 'Adoption'], ['TMflash', '/flash', 'TMflash']]) {
      await devices.click();
      await modules.getByRole('link', { name, exact: true }).click();
      await page.waitForURL(`${base}${path}`);
      await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
      assert.equal(await modules.locator('.cx-group-dropdown').count(), 0, 'choosing a page closes the menu');
      assert.equal(await devices.getAttribute('aria-current'), 'page', `Devices is the current place on ${path}`);
      await devices.click();
      assert.equal(await modules.getByRole('link', { name, exact: true }).getAttribute('aria-current'), 'page');
      await devices.click();
    }
    assert.equal(await modules.getByRole('button', { name: 'ML', exact: true }).getAttribute('aria-current'), null);

    await modules.getByRole('button', { name: 'ML', exact: true }).click();
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['ML job', 'ML data'], 'ML keeps its own two, and nothing of Devices');
    // One menu at a time: opening another closes it.
    await devices.click();
    assert.equal(await modules.locator('.cx-group-dropdown').count(), 1);
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['Updates', 'Adoption', 'TMflash']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

/** A blocker's cosmetic rules arrive as a stylesheet the page's CSP has no say over; this is the nearest a test gets. */
const block = (page, rules) => page.evaluate((css) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}, rules);

test('chromium: with an ad blocker’s hiding rules on, Adoption and TMflash still show every panel and their buttons', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await open(browser, 'engineer', '/flash');
  try {
    // What EasyList applies to every site, for the names these pages once used, and the same idea more broadly.
    const blocker = '.ad-panel, .ad-hint, .ad-notice, .ad-primary, [class^="ad-"], [class*=" ad-"], [class^="ads-"], [class*=" ads-"] { display: none !important; }';
    await block(page, blocker);
    // The rules are really in force: an element named the old way vanishes.
    assert.equal(await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'ad-panel';
      document.body.append(probe);
      const hidden = getComputedStyle(probe).display === 'none';
      probe.remove();
      return hidden;
    }), true);
    for (const title of ['1 · Board', '2 · Firmware', '3 · Settings', '4 · Flash']) assert.equal(await page.getByRole('heading', { name: title, exact: true }).isVisible(), true, `${title} is on the page`);
    assert.equal(await page.getByRole('button', { name: 'Connect a board' }).isVisible(), true);
    assert.equal(await page.locator('.cx-flash section').count(), 4);
    await page.locator('.fl-build table').waitFor();

    await page.goto(`${base}/adoption`);
    await block(page, blocker);
    await page.getByText('No requests waiting.', { exact: false }).waitFor();
    for (const title of ['TMflash sign-in', 'Device verification']) assert.equal(await page.getByRole('heading', { name: title, exact: true }).isVisible(), true, title);
    assert.equal(await page.getByRole('heading', { name: /^Pending devices/ }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[class^="ad-"], [class*=" ad-"]').length), 0, 'nothing on the page is named like an advertisement');
  } finally { await context.close(); await browser.close(); }
});

test('chromium: the account icon holds who is signed in, their settings and the way out; the settings page keeps an address and changes a password', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer', '/');
  try {
    const account = page.getByRole('button', { name: 'Account', exact: true });
    const panel = page.locator('.cx-account-panel');
    assert.equal(await page.getByText('engineer@team', { exact: true }).count(), 0, 'the bar carries an icon, not the name');
    assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0, 'and sign-out is not a stray button beside it');
    assert.deepEqual(await page.locator('.cx-identity-actions > *').evaluateAll((items) => items.map((item) => item.className.split(' ').find((name) => /cx-(notification-toggle|account)$/.test(name)))), ['cx-notification-toggle', 'cx-account']);

    await account.click();
    await panel.getByText('engineer@team', { exact: true }).waitFor();
    await panel.getByText('Engineer', { exact: true }).waitFor();
    assert.deepEqual(await panel.locator('a, button').allTextContents(), ['Account settings', 'Sign out']);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1281, 'the menu opens inside the window');
    await shot(page, 'account-menu-1280');
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0);
    assert.equal(await account.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the icon');
    await account.click();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    assert.equal(await panel.count(), 0, 'opening the notifications closes the account menu');
    await page.keyboard.press('Escape');

    await account.click();
    await panel.getByRole('link', { name: 'Account settings', exact: true }).click();
    await page.waitForURL(`${base}/account`);
    await page.getByRole('heading', { name: 'Account settings', exact: true }).waitFor();
    const profile = page.locator('section', { has: page.getByRole('heading', { name: 'Profile', exact: true }) });
    await profile.getByText('engineer', { exact: true }).waitFor();
    assert.deepEqual(await profile.locator('dd').allTextContents().then((values) => values.slice(0, 3)), ['engineer', 'Engineer', 'Firmware, Hardware']);

    // --- an address, and what it should hear about -----------------------------
    const email = page.getByLabel('Email address', { exact: true });
    const save = page.getByRole('button', { name: 'Save email settings', exact: true });
    assert.equal(await page.getByRole('checkbox', { name: /^Sensors/ }).isDisabled(), true, 'nothing to choose until there is an address');
    assert.equal(await save.isDisabled(), true);
    await page.getByRole('note').filter({ hasText: 'This server is not set up to send email yet' }).waitFor();
    await email.fill('not an address');
    await save.click();
    assert.equal(await email.evaluate((input) => input.validity.valid), false, 'the browser stops a malformed address');
    await email.fill('eng@example');
    await save.click();
    await page.getByRole('alert').filter({ hasText: 'Enter one email address' }).waitFor();
    await email.fill('eng@example.com');
    await page.getByRole('checkbox', { name: /^Sensors/ }).check();
    await page.getByRole('checkbox', { name: /^Tasks/ }).check();
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await fits(page, width);
      await shot(page, `account-settings-${width}`);
    }
    await save.click();
    await page.getByRole('status').filter({ hasText: 'Email settings saved.' }).waitFor();
    await page.reload();
    assert.equal(await page.getByLabel('Email address', { exact: true }).inputValue(), 'eng@example.com', 'kept on the server, not in the tab');
    assert.deepEqual([await page.getByRole('checkbox', { name: /^Sensors/ }).isChecked(), await page.getByRole('checkbox', { name: /^Tasks/ }).isChecked(), await page.getByRole('checkbox', { name: /^Firmware/ }).isChecked()], [true, true, false]);
    assert.ok(readFileSync(join(directory, 'account-settings.json'), 'utf8').includes('eng@example.com'));
    await page.getByRole('button', { name: 'Remove address', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Email address removed.' }).waitFor();
    assert.ok(!readFileSync(join(directory, 'account-settings.json'), 'utf8').includes('eng@example.com'), 'removed means gone from the server');

    // --- the password -----------------------------------------------------------
    const change = page.getByRole('button', { name: 'Change password', exact: true });
    await page.getByLabel('Current password', { exact: true }).fill('not the password at all');
    await page.getByLabel('New password', { exact: true }).fill('a brand new passphrase');
    await page.getByLabel('New password again', { exact: true }).fill('a brand new passphrasX');
    await page.getByRole('alert').filter({ hasText: 'The two new passwords do not match.' }).waitFor();
    assert.equal(await change.isDisabled(), true);
    await page.getByLabel('New password again', { exact: true }).fill('a brand new passphrase');
    await change.click();
    await page.getByRole('alert').filter({ hasText: 'The current password is not right.' }).waitFor();
    await page.getByRole('heading', { name: 'Account settings', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/account', 'a wrong password is an error on the form, not a lost session');

    const elsewhere = await browser.newContext();
    assert.equal((await elsewhere.request.post(`${base}/auth/login`, { data: { username: 'engineer', password: PASSWORD } })).status(), 200);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await change.click();
    await page.getByRole('status').filter({ hasText: 'Password changed. You are still signed in here' }).waitFor();
    assert.equal((await context.request.get(`${base}/api/me`)).status(), 200, 'this browser carries on');
    assert.equal((await elsewhere.request.get(`${base}/api/me`)).status(), 401, 'the other one has to sign in again');
    await elsewhere.close();

    // --- every session, then the way out ----------------------------------------
    await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await context.request.get(`${base}/api/me`)).status(), 200, 'asking is not doing');
    await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, sign out everywhere', exact: true }).click();
    await page.waitForURL('**/login**');
    assert.equal((await context.request.get(`${base}/api/me`)).status(), 401);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engine}: on a phone the account menu and its settings page fit, a viewer has both, and Sign out signs out`, { timeout: 60_000 }, async () => {
    const browser = await launcher.launch({ headless: true });
    const { context, page, errors } = await open(browser, 'viewer', '/account', { width: 320, height: 568 });
    try {
      await page.getByRole('heading', { name: 'Account settings', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await fits(page, width);
        // The bar is one row: the logo, the menu, where you are, the bell and the account.
        assert.ok((await page.locator('.cx-header').boundingBox()).height <= 49, `the header is a single row at ${width}px`);
        await page.getByRole('button', { name: 'Account', exact: true }).click();
        const panel = await page.locator('.cx-account-panel').boundingBox();
        assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1, 'the menu stays on screen');
        await fits(page, width);
        if (width === 390) await shot(page, `account-menu-${engine}-390`);
        await page.locator('.cx-account-panel').getByText('Viewer', { exact: true }).waitFor();
        // Somewhere the menu does not cover.
        await page.getByRole('heading', { name: 'Sessions', exact: true }).click();
        assert.equal(await page.locator('.cx-account-panel').count(), 0, 'a tap outside closes it');
      }
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.locator('.cx-account-panel').getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.waitForURL('**/login**');
      assert.equal((await context.request.get(`${base}/api/me`)).status(), 401);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); }
  });
}
