/** The console's header and a person's own account page, in a browser.
 *
 * Three things a person meets before any module: the Devices menu (Updates,
 * Adoption, TMflash), the account icon (who they are, their settings, the way
 * out), and the settings page behind it. And one thing they should never
 * meet: a page an ad blocker has emptied. Before all of it, the tab itself:
 * its icon, and that a place is called by its name and not by a number.
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
import { FakeGitHub, tmsenseRelease, tmflashRelease } from '../dist/test/fake-github.js';
import { GitHubReleaseSource } from '../dist/src/infrastructure/firmware-release/github-release-source.js';
import { GitHubTMflashSource } from '../dist/src/infrastructure/tmflash-release/github-tmflash-source.js';

const PASSWORD = 'local browser test password';
let runtime, handle, base, directory;
const originalDataDir = process.env.DATA_DIR;
const github = new FakeGitHub();
github.latest = tmsenseRelease('tmsense-1.6');
const appGitHub = new FakeGitHub('Mysteringz/TMflash');
appGitHub.latest = tmflashRelease();
/** The mail service: keeps what it is handed, so a test can read the code a person would. */
const outbox = { sent: [], async send(mail) { this.sent.push(mail); } };

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
  await accounts.add('admin', PASSWORD, 'admin');
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({
    DATA_DIR: directory, ALGO_USERS_FILE: users, SESSION_SECRET: 'local-only-test-secret'.repeat(3),
  }, config.adminPassword), createConsole(runtime), { firmwareRelease: new GitHubReleaseSource(undefined, github.fetch),
    tmflashRelease: new GitHubTMflashSource(join(directory, 'tmflash'), appGitHub.fetch), mailer: outbox });
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

// What closes leaves before it goes (algo-app/src/console/motion.tsx): it is
// inert at once and off the page an exit later, so "closed" is waited for.
const gone = (locator) => locator.waitFor({ state: 'detached' });

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

test('chromium: hamburger groups expand independently and reveal the current page', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const { context, page, errors } = await open(browser, 'admin', '/', { width: 390, height: 844 });
  try {
    const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true });
    await toggle.click();
    const menu = page.getByRole('navigation', { name: 'Mobile navigation', exact: true });
    assert.deepEqual(await menu.locator(':scope > a, :scope > .cx-mobile-nav-group > button').evaluateAll(rows => rows.map(row =>
      row.querySelector('.cx-mobile-nav-label').textContent,
    )), ['Home', 'Algorithm flow', 'ML', 'Debug console', 'Devices', 'Analytics', 'Locations', 'Accounts']);
    const ml = menu.getByRole('button', { name: 'ML', exact: true });
    const devices = menu.getByRole('button', { name: 'Devices', exact: true });
    assert.equal(await ml.getAttribute('aria-expanded'), 'false');
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    assert.equal(await menu.getByRole('link', { name: 'ML job', exact: true }).count(), 0);
    await ml.click();
    await devices.click();
    assert.equal(await ml.getAttribute('aria-expanded'), 'true');
    assert.equal(await devices.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await menu.locator('.cx-mobile-nav-group a:visible').allTextContents(), ['ML job', 'ML data', 'Updates', 'Adoption', 'TMflash Web', 'TMflash Download']);
    await shot(page, 'grouped-hamburger-phone');
    await ml.click();
    assert.equal(await ml.getAttribute('aria-expanded'), 'false');
    assert.equal(await devices.getAttribute('aria-expanded'), 'true');
    await ml.click();
    await menu.getByRole('link', { name: 'ML data', exact: true }).click();
    await page.waitForURL(`${base}/ml-data`);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await ml.getAttribute('aria-expanded'), 'true');
    assert.equal(await menu.getByRole('link', { name: 'ML data', exact: true }).getAttribute('aria-current'), 'page');
    await page.keyboard.press('Escape');
    assert.equal(await toggle.evaluate(button => button === document.activeElement), true);
    await page.setViewportSize({ width: 667, height: 375 });
    await toggle.click();
    await devices.click();
    await menu.getByRole('link', { name: 'TMflash Download', exact: true }).scrollIntoViewIfNeeded();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 668 && bounds.y + bounds.height <= 375, 'expanded navigation fits landscape');
    await shot(page, 'grouped-hamburger-landscape');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
  const restrictedBrowser = await chromium.launch({ headless: true, channel: 'chrome' });
  const restricted = await open(restrictedBrowser, 'engineer', '/', { width: 390, height: 844 });
  try {
    await restricted.page.getByRole('button', { name: 'Navigation menu', exact: true }).click();
    const menu = restricted.page.getByRole('navigation', { name: 'Mobile navigation', exact: true });
    assert.equal(await menu.getByRole('link', { name: 'Locations', exact: true }).count(), 0);
    assert.equal(await menu.getByRole('link', { name: 'Accounts', exact: true }).count(), 0);
    assert.equal(await menu.getByRole('link', { name: 'Analytics', exact: true }).innerText(), 'Analytics');
  } finally { await restricted.context.close(); await restrictedBrowser.close(); }
});

test('chromium: Updates, Adoption and TMflash are one Devices menu, and ML is still its own', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer', '/');
  try {
    const modules = page.locator('.cx-header').getByRole('navigation', { name: 'Modules', exact: true });
    assert.deepEqual(await modules.locator(':scope > *').evaluateAll((items) => items.map((item) => item.textContent.replace(/\s*▾$/, ''))),
      ['Algorithm flow', 'ML', 'Debug console', 'Devices', 'Analytics'], 'five places in the bar, in the order of the modules');
    for (const name of ['Updates', 'Adoption', 'TMflash web', 'TMflash download']) assert.equal(await modules.getByRole('link', { name, exact: true }).count(), 0, `${name} is inside the menu, not beside it`);

    const devices = modules.getByRole('button', { name: 'Devices', exact: true });
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    await devices.click();
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['Updates', 'Adoption', 'TMflash web', 'TMflash download']);
    await shot(page, 'devices-menu-1280');
    await page.keyboard.press('Escape');
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    assert.equal(await devices.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the menu');

    for (const [name, path, heading] of [['Updates', '/updates', 'Updates'], ['Adoption', '/adoption', 'Adoption'], ['TMflash web', '/flash', 'TMflash web'], ['TMflash download', '/tmflash-download', 'TMflash download']]) {
      await devices.click();
      await modules.getByRole('link', { name, exact: true }).click();
      await page.waitForURL(`${base}${path}`);
      await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
      await gone(modules.locator('.cx-group-dropdown'));
      assert.equal(await devices.getAttribute('aria-current'), 'page', `Devices is the current place on ${path}`);
      await devices.click();
      assert.equal(await modules.getByRole('link', { name, exact: true }).getAttribute('aria-current'), 'page');
      await devices.click();
      await gone(modules.locator('.cx-group-dropdown'));
    }
    assert.equal(await modules.getByRole('button', { name: 'ML', exact: true }).getAttribute('aria-current'), null);

    await modules.getByRole('button', { name: 'ML', exact: true }).click();
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['ML job', 'ML data'], 'ML keeps its own two, and nothing of Devices');
    // One menu at a time: opening another closes it.
    await devices.click();
    await gone(modules.locator('.cx-group-dropdown[data-state="leaving"]'));
    assert.equal(await modules.locator('.cx-group-dropdown').count(), 1);
    assert.deepEqual(await modules.locator('.cx-group-dropdown a').allTextContents(), ['Updates', 'Adoption', 'TMflash web', 'TMflash download']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test('chromium: every place is called by its name; no page, and not the phone menu, shows a module number', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer', '/');
  try {
    // The numbers are the documents' and the comments' way of referring to a module (docs/ALGO_DASHBOARD.md).
    const places = [
      ['/flow', 'Algorithm flow', () => page.locator('.react-flow').first()],
      ['/train', 'ML job', () => page.getByRole('heading', { name: 'ML job', exact: true })],
      ['/ml-data', 'ML data', () => page.getByRole('heading', { name: 'ML database', exact: true })],
      ['/console', 'Debug console', () => page.locator('iframe[title="Debug console"]')],
      ['/updates', 'Updates', () => page.getByRole('heading', { name: 'Updates', exact: true, level: 1 })],
      ['/analytics', 'Analytics', () => page.getByRole('heading', { name: 'Analytics', exact: true, level: 1 })],
      ['/adoption', 'Adoption', () => page.getByRole('heading', { name: 'Adoption', exact: true, level: 1 })],
      ['/flash', 'TMflash web', () => page.getByRole('heading', { name: 'TMflash web', exact: true, level: 1 })],
      ['/tmflash-download', 'TMflash download', () => page.getByRole('heading', { name: 'TMflash download', exact: true, level: 1 })],
    ];
    for (const [path, , drawn] of places) {
      await page.goto(`${base}${path}`);
      await drawn().waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /\bmodule\s+\d/i, `${path} names no module number`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Navigation menu', exact: true }).click();
    const menu = page.getByRole('navigation', { name: 'Mobile navigation', exact: true });
    for (const group of ['ML', 'Devices']) {
      const toggle = menu.getByRole('button', { name: group, exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    }
    // Grouping keeps every page reachable, with names and no numeric prefixes.
    assert.deepEqual(await menu.getByRole('link').allTextContents(),
      ['Home', 'Algorithm flow', 'ML job', 'ML data', 'Debug console', 'Updates', 'Adoption', 'TMflash Web', 'TMflash Download', 'Analytics']);
    assert.equal(await menu.locator('.cx-mobile-nav-number').count(), 0);
    await shot(page, 'phone-menu-390');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test('chromium: the tab shows the console’s own mark, on the sign-in page too', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    // Nobody is signed in: the icon is asked for before the form is filled.
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    const icons = await page.locator('link[rel="icon"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    assert.deepEqual(icons, ['/favicon.ico', '/favicon.svg'], 'pixels for a browser that draws no SVG icon, then the SVG');
    for (const href of icons) {
      const response = await context.request.get(`${base}${href}`);
      assert.equal(response.status(), 200, `${href} is served without a session`);
      assert.match(response.headers()['content-type'], /^image\//);
      // Fetched and decoded by the page itself, so its own content policy has let it through.
      const size = await page.evaluate(async (source) => { const image = new Image(); image.src = source; await image.decode(); return image.naturalWidth; }, href);
      assert.ok(size > 0, `${href} is a picture a browser can draw`);
    }
    // What a browser asks for by itself where a document names no icon: it is the same file.
    assert.deepEqual([...(await (await context.request.get(`${base}/favicon.ico`)).body()).subarray(0, 4)], [0, 0, 1, 0], 'an .ico');
  } finally { await context.close(); await browser.close(); }
});

/** A blocker's cosmetic rules arrive as a stylesheet the page's CSP has no say over; this is the nearest a test gets. */
const block = (page, rules) => page.evaluate((css) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}, rules);

test('chromium: a switch moves its fill to what was chosen, a menu leaves before it goes, and neither moves for someone who asked for less motion', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer', '/');
  try {
    // --- Inbox / Sent: one fill for the row, and it goes where the choice went ---
    const mailbox = page.getByRole('radiogroup', { name: 'Mailbox', exact: true });
    await mailbox.and(page.locator('[data-glide="live"]')).waitFor();
    // The option hands its own fill over to the row's (an ease, so it is waited for): there is one fill, not one each.
    await mailbox.locator('.seg-opt:has(input:checked)').evaluate((chosen) => new Promise((resolve) => {
      const check = () => (getComputedStyle(chosen).backgroundColor === 'rgba(0, 0, 0, 0)' ? resolve() : requestAnimationFrame(check));
      check();
    }));
    // The font can resize the chosen option after the mark first appears.
    // Measure the destination after its width transition has actually settled.
    const settled = () => mailbox.evaluate(async (row) => {
      await document.fonts.ready;
      await new Promise((resolve) => {
        const check = () => {
          const chosen = row.querySelector('.seg-opt:has(input:checked)');
          if (getComputedStyle(row, '::after').width === `${chosen.offsetWidth}px`
            && row.style.getPropertyValue('--glide-x') === `${chosen.offsetLeft}px`) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
    });
    await settled();
    const fill = () => mailbox.evaluate((row) => {
      const chosen = row.querySelector('.seg-opt:has(input:checked)');
      const mark = getComputedStyle(row, '::after');
      return {
        chosen: chosen.textContent.trim(), at: row.style.getPropertyValue('--glide-x'), option: `${chosen.offsetLeft}px`,
        wide: mark.width === `${chosen.offsetWidth}px`, moves: mark.transitionDuration,
      };
    });
    const inbox = await fill();
    assert.equal(inbox.chosen, 'Inbox');
    assert.equal(inbox.at, inbox.option, 'the fill sits on the chosen option');
    assert.equal(inbox.wide, true, 'and is as wide as it');
    assert.match(inbox.moves, /0\.24s/, 'and it travels rather than jumps');
    await mailbox.getByText('Sent', { exact: true }).click();
    await settled();
    const sent = await fill();
    assert.equal(sent.chosen, 'Sent');
    assert.equal(sent.at, sent.option, 'choosing Sent sends the fill to Sent');
    assert.equal(sent.wide, true, 'the settled fill fits the newly chosen option');
    assert.notEqual(sent.at, inbox.at);

    // --- a menu that closes is inert at once, and gone an exit later -------------
    const modules = page.locator('.cx-header').getByRole('navigation', { name: 'Modules', exact: true });
    const devices = modules.getByRole('button', { name: 'Devices', exact: true });
    const menu = modules.locator('.cx-group-dropdown');
    await devices.click();
    assert.equal(await menu.getAttribute('data-state'), 'open');
    // Watched from inside the page: how long the exit lasts is not this test's to race.
    await page.evaluate(() => {
      const element = document.querySelector('.cx-group-dropdown');
      window.leaving = [];
      new MutationObserver(() => window.leaving.push({ state: element.dataset.state, inert: element.inert, onPage: element.isConnected }))
        .observe(document.querySelector('.cx-header'), { attributes: true, childList: true, subtree: true });
    });
    await page.keyboard.press('Escape');
    assert.equal(await devices.getAttribute('aria-expanded'), 'false');
    await gone(menu);
    const seen = await page.evaluate(() => window.leaving);
    assert.ok(seen.some((moment) => moment.state === 'leaving' && moment.inert && moment.onPage), `it leaves, inert, before it is removed: ${JSON.stringify(seen)}`);

    // --- less motion: everything still happens, at once --------------------------
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await devices.click();
    assert.equal(await menu.evaluate((element) => getComputedStyle(element).animationName), 'none', 'the menu does not slide in');
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0, 'and closed is gone, with no exit to wait for');
    await mailbox.getByText('Inbox', { exact: true }).click();
    const quiet = await fill();
    assert.equal(quiet.at, quiet.option, 'the fill is still on what was chosen');
    assert.equal(quiet.moves, '0s', 'having jumped there');
    assert.equal(await page.getByRole('button', { name: 'Compose' }).evaluate((button) => getComputedStyle(button).transitionDuration), '0s', 'and no control eases');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

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
    assert.equal(await account.evaluate((button) => button === document.activeElement), true, 'Escape returns focus to the icon');
    await gone(panel);
    await account.click();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    assert.equal(await account.getAttribute('aria-expanded'), 'false', 'opening the notifications closes the account menu');
    await gone(panel);
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
    // A server that cannot send email says so, rather than letting the page promise mail.
    await page.route('**/api/account', async (route) => {
      const response = await route.fetch(), body = await response.json();
      body.data.emailDelivery = false;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.getByRole('note').filter({ hasText: 'This server is not set up to send email yet' }).waitFor();
    await page.unroute('**/api/account');
    await page.reload();
    await page.getByText('once you have confirmed it is yours').waitFor();
    assert.equal(await page.getByRole('note').filter({ hasText: 'not set up to send email' }).count(), 0);
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

    // --- the address is confirmed with a code before anything is sent to it -----
    const confirming = page.getByRole('group', { name: 'Confirm this address', exact: true });
    await confirming.getByText('eng@example.com is not confirmed yet, so nothing is sent to it.').waitFor();
    assert.equal(outbox.sent.length, 0, 'saving an address sends nothing');
    await email.fill('eng2@example.com');
    assert.equal(await confirming.getByRole('button', { name: 'Send confirmation code', exact: true }).isDisabled(), true, 'a code is for the address that was saved, not one half typed');
    await email.fill('eng@example.com');
    await confirming.getByRole('button', { name: 'Send confirmation code', exact: true }).click();
    const code = confirming.getByLabel('Confirmation code', { exact: true });
    await code.waitFor();
    assert.deepEqual([outbox.sent.length, outbox.sent[0].to], [1, 'eng@example.com']);
    const sentCode = /code is (\d{6})/.exec(outbox.sent[0].text)[1];
    const confirm = confirming.getByRole('button', { name: 'Confirm address', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await code.fill('12ab');
    assert.equal(await code.inputValue(), '12', 'digits only');
    await code.fill(sentCode === '000000' ? '000001' : '000000');
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await fits(page, width);
      await shot(page, `account-confirm-${width}`);
    }
    await confirm.click();
    await confirming.getByRole('alert').filter({ hasText: 'That code is not right.' }).waitFor();
    await code.fill(sentCode);
    await confirm.click();
    await page.getByRole('status').filter({ hasText: 'eng@example.com is confirmed.' }).waitFor();
    assert.equal(await confirming.count(), 0);

    await page.reload();
    await page.getByRole('status').filter({ hasText: 'eng@example.com is confirmed.' }).waitFor();
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
        assert.equal(await page.getByRole('button', { name: 'Account', exact: true }).getAttribute('aria-expanded'), 'false', 'a tap outside closes it');
        await gone(page.locator('.cx-account-panel'));
      }
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.locator('.cx-account-panel').getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.waitForURL('**/login**');
      assert.equal((await context.request.get(`${base}/api/me`)).status(), 401);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); }
  });
}
