/** Module 07, the web flasher, end to end in a browser.
 *
 * The real page and the real esptool-js, against a board that is not real:
 * test/fake-esp32.ts stands behind a stand-in for `navigator.serial` and
 * remembers every loader command, every region erased and every byte written.
 * So the claims below are about what a board received, not about what the
 * code meant to send. The firmware comes the way it does in production, from
 * the TMsense repository's latest GitHub release through the edge -- with
 * test/fake-github.ts standing where GitHub is.
 *
 * What this cannot show is that a physical ESP32-S3 accepts the same bytes.
 * Run npm run build and npx playwright install chromium webkit first; it
 * runs with npm run test:algo-mobile.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { FakeBoard } from '../dist/test/fake-esp32.js';
import { espImage, FakeGitHub, manifestFor, tmsenseRelease } from '../dist/test/fake-github.js';
import { GitHubReleaseSource } from '../dist/src/infrastructure/firmware-release/github-release-source.js';

const PASSWORD = 'local browser test password';
const WIFI_PASSWORD = 'correct horse battery';
const SIGNING_KEY = 'tmkey-' + 'k'.repeat(34);
let runtime, handle, base, directory;
// What the TMsense repository has published, and the edge's clock: a test
// that changes the release moves the clock past the edge's one-minute memory.
const github = new FakeGitHub();
const RELEASE = tmsenseRelease('tmsense-1.6');
const BUILD = RELEASE.files;
const clock = { at: Date.now() };
github.latest = RELEASE;
const originalDataDir = process.env.DATA_DIR;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tmedge-webflash-'));
  writeFileSync(join(directory, 'nodes.json'), JSON.stringify(nodesJson()));
  process.env.DATA_DIR = directory;
  const config = {
    edgeId: 'web-flasher', keys: [KEY], allowUnsigned: false,
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
  await accounts.add('engineer', PASSWORD, 'engineer');
  await accounts.add('operator', PASSWORD, 'operator');
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({
    DATA_DIR: directory, ALGO_USERS_FILE: users, SESSION_SECRET: 'local-only-test-secret'.repeat(3),
  }, config.adminPassword), createConsole(runtime), { firmwareRelease: new GitHubReleaseSource(undefined, github.fetch, () => clock.at) });
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

const NVS = [0x9000, 0xe000];

// --- a board on a USB port that is neither ---------------------------------

/** Replaces `navigator.serial` with one port, whose far end is a FakeBoard in this process. */
function serialShim() {
  class Port extends EventTarget {
    opened = false; stream = null; controller = null; sink = null; waiting = [];
    getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
    async open(options) {
      if (this.opened) throw new DOMException('The port is already open.', 'InvalidStateError');
      window.__opens = [...(window.__opens ?? []), options.baudRate];
      this.opened = true;
    }
    get readable() {
      if (!this.opened) return null;
      // A cancelled stream is replaced by a fresh one while the port stays open, as the real API does.
      this.stream ??= new ReadableStream({
        start: (controller) => { this.controller = controller; for (const chunk of this.waiting.splice(0)) controller.enqueue(chunk); },
        cancel: () => { this.stream = null; this.controller = null; },
      });
      return this.stream;
    }
    get writable() {
      if (!this.opened) return null;
      this.sink ??= new WritableStream({ write: (chunk) => window.__board('write', Array.from(chunk)) });
      return this.sink;
    }
    setSignals(signals) { return window.__board('signals', signals); }
    async close() {
      this.opened = false;
      try { this.controller?.close(); } catch { /* already cancelled */ }
      this.stream = null; this.controller = null; this.sink = null; this.waiting = [];
    }
    async forget() { window.__forgotten = true; }
    deliver(bytes) {
      const chunk = new Uint8Array(bytes);
      if (this.controller) this.controller.enqueue(chunk);
      else if (this.opened) this.waiting.push(chunk);   // nobody is listening on a closed port
    }
  }
  const port = new Port();
  const serial = new EventTarget();
  serial.requestPort = async (options) => { window.__chooser = options; return port; };
  serial.getPorts = async () => [];
  window.__port = port;
  Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => serial });
}

async function open(browser, user, options = {}) {
  clock.at += 61_000;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const login = await context.request.post(`${base}/auth/login`, { data: { username: user, password: PASSWORD } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const sent = [];
  page.on('request', (request) => sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let board = null;
  if (options.uid) {
    let queue = Promise.resolve();
    board = new FakeBoard(options.uid, (bytes) => {
      const data = Array.from(bytes);
      queue = queue.then(() => page.evaluate((chunk) => window.__port?.deliver(chunk), data)).catch(() => undefined);
    }, { blank: options.blank ?? false });
    await context.exposeBinding('__board', (_source, kind, payload) => {
      if (kind === 'write') board.write(Uint8Array.from(payload));
      else board.setSignals(payload);
    });
    await page.addInitScript(serialShim);
  }
  await page.goto(`${base}/flash`);
  await page.getByRole('heading', { name: 'TMflash', exact: true }).waitFor();
  return { context, page, board, sent, errors };
}

async function shot(page, name) {
  const output = process.env.ALGO_UI_SCREENSHOTS;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
}

async function fits(page, width) {
  const layout = await page.evaluate(() => ({
    viewport: innerWidth, page: document.documentElement.scrollWidth,
    small: innerWidth > 900 ? [] : [...document.querySelectorAll('.cx-flash button, .cx-flash .fl-choice label, .cx-flash summary')].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && bounds.height && bounds.height < 43 ? [element.textContent] : [];
    }),
    clipped: [...document.querySelectorAll('.cx-flash button, .cx-flash input, .cx-flash label')].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return !bounds.width || (bounds.left >= -1 && bounds.right <= innerWidth + 1) ? [] : [element.textContent || element.getAttribute('placeholder')];
    }),
  }));
  assert.equal(layout.viewport, width);
  assert.ok(layout.page <= width + 1, `page width ${layout.page} exceeds ${width}`);
  assert.deepEqual(layout.clipped, [], 'controls must stay reachable');
  assert.deepEqual(layout.small, [], 'touch controls must be at least 44px high');
}

const overlaps = (start, end, [from, to]) => start < to && end > from;

test('chromium: a new board is flashed, set up, admitted by a deliberate click and seen on Wi-Fi — and its saved settings are never erased', { timeout: 120_000 }, async () => {
  const uid = '30:ed:a0:11:22:0b';
  const browser = await chromium.launch({ headless: true });
  const { context, page, board, sent, errors } = await open(browser, 'engineer', { uid, blank: true });
  try {
    // What a node keeps across a re-flash, as it would be on a board that had been in service.
    const kept = Buffer.alloc(NVS[1] - NVS[0]);
    for (let i = 0; i < kept.length; i++) kept[i] = (i * 13 + 5) & 0xff;
    kept.copy(board.flash, NVS[0]);

    await page.getByRole('button', { name: 'Connect a board' }).click();
    await page.getByText('No TMsense firmware answered.').waitFor({ timeout: 20_000 });
    assert.deepEqual(await page.evaluate(() => window.__chooser.filters.map((filter) => filter.usbVendorId)), [0x10c4, 0x1a86, 0x0403, 0x303a],
      'the browser is asked for USB serial bridges, not for every port on the machine');
    assert.equal(board.downloads, 0, 'looking at a board does not put it in its bootloader');

    // Nobody chose the firmware: it is the repository's latest release, and the page says which.
    assert.equal(await page.locator('input[type=file]').count(), 0, 'there is no way to hand the page an image');
    const plan = page.locator('.fl-build');
    await plan.getByText('tmsense-1.6').waitFor();
    assert.equal(await plan.getByRole('link', { name: 'v1.6' }).getAttribute('href'), 'https://github.com/Mysteringz/TMsense/releases/tag/v1.6');
    await plan.getByText('commit f193c83', { exact: false }).waitFor();
    assert.deepEqual(await plan.locator('tbody tr td:first-child').allTextContents(), ['0x00000', '0x08000', '0x0e000', '0x10000']);
    await plan.getByText('Left untouched: nvs (0x9000–0xe000)', { exact: false }).waitFor();

    await page.getByLabel('Node ID').fill('11');
    await page.getByText('2 fps', { exact: true }).click();
    await page.getByLabel('Wi-Fi network (2.4 GHz)').fill('Maker Space');
    await page.getByLabel('Wi-Fi password').fill(WIFI_PASSWORD);
    await page.getByLabel('TMWAccess IP').fill('192.0.2.10');
    await page.getByLabel('Signing key').fill(SIGNING_KEY);
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await fits(page, width);
      await shot(page, `flash-ready-${width}`);
    }
    await page.getByRole('button', { name: 'Flash and set up' }).click();

    // The page stops at a person. Until they answer, the edge has admitted nothing.
    const dialog = page.getByRole('alertdialog', { name: 'Admit this board to TMedge?' });
    await dialog.waitFor({ timeout: 60_000 });
    await dialog.getByText(uid).waitFor();
    assert.equal(runtime.reg.nodes.has(uid), false, 'queuing the question admits nothing');
    assert.equal(board.node.saved.node_id, '11', 'the settings were saved before the edge was asked');
    assert.ok(!board.node.received.includes('reboot'), 'and the node was not told to connect before the answer');
    await shot(page, 'flash-admit-1280');
    await dialog.getByRole('button', { name: 'Admit this board' }).click();

    const outcome = page.locator('.fl-outcome');
    await outcome.getByRole('heading', { name: 'Done' }).waitFor({ timeout: 60_000 });
    await outcome.getByText('Joined Maker Space as 192.168.0.11').waitFor();
    await outcome.getByText('Admitted, unplaced').waitFor();
    await outcome.getByText('tmsense-1.6 (just written)').waitFor();
    await shot(page, 'flash-done-1280');

    // --- what the board received ---------------------------------------------
    const writes = board.ops.filter((entry) => entry.name === 'flash_defl_begin');
    assert.deepEqual(writes.map((entry) => [entry.address, entry.size]), [
      [0x0, 15104], [0x8000, 0xc00], [0xe000, 0x2000], [0x10000, 180_000],
    ], 'four writes, at the offsets PlatformIO uses');
    assert.deepEqual(board.ops.filter((entry) => ['erase_flash', 'erase_region', 'flash_begin'].includes(entry.name) || entry.name.startsWith('unknown')), [],
      'no erase command, and nothing the loader had to refuse');
    for (const [start, end] of board.erased) assert.ok(!overlaps(start, end, NVS), `0x${start.toString(16)}–0x${end.toString(16)} stays clear of NVS`);
    assert.ok(board.flash.subarray(NVS[0], NVS[1]).equals(kept), 'the node’s saved settings and boot counter are byte for byte what they were');
    // Exactly what was built, the bootloader's header included: nothing rewrote it on the way.
    assert.ok(board.flash.subarray(0, 15104).equals(BUILD['bootloader.bin']));
    assert.ok(board.flash.subarray(0x8000, 0x8c00).equals(BUILD['partitions.bin']));
    assert.ok(board.flash.subarray(0x10000, 0x10000 + 180_000).equals(BUILD['firmware.bin']));
    assert.deepEqual([...board.flash.subarray(0xe000, 0xe004), ...board.flash.subarray(0xe01c, 0xe020)], [1, 0, 0, 0, 0x9a, 0x98, 0x43, 0x47], 'the boot selector points at the image just written');
    assert.ok(board.ops.some((entry) => entry.name === 'spi_flash_md5'), 'and each region was read back before the job was called done');
    assert.equal(board.downloads, 1);

    // --- what the node and the edge ended up with -----------------------------
    assert.deepEqual([board.node.saved.node_id, board.node.saved.ssid, board.node.saved.password, board.node.saved.edges.trim(), board.node.saved.key, board.node.saved.fps],
      ['11', 'Maker Space', '(set)', '192.0.2.10', '(set)', '2']);
    const admitted = runtime.reg.nodes.get(uid);
    assert.deepEqual([admitted?.label, admitted?.floorId, admitted?.pose], ['Node 11', null, null], 'an identity, not a placement');

    // --- where the secrets went: to the board, and nowhere else ---------------
    await page.locator('.fl-log summary').click();
    const shown = await page.locator('body').innerText();
    assert.ok(shown.includes('set pass ••••••') && shown.includes('set key ••••••'));
    // A log that opens with motion is readable from the instant it opens, not
    // a frame later. Closed, left to settle, then opened and read in one task:
    // the line above reads after a round trip, which a slow runner can lose.
    await page.locator('.fl-log summary').click();
    await page.locator('.fl-log:not([open])').waitFor();
    await page.waitForTimeout(300);
    const atOnce = await page.locator('.fl-log').evaluate((log) => { log.querySelector('summary').click(); return log.innerText; });
    assert.ok(atOnce.includes('set pass ••••••'), 'an opened log can be read the moment it opens');
    assert.ok(board.node.received.includes(`set pass ${WIFI_PASSWORD}`) && board.node.received.includes(`set key ${SIGNING_KEY}`));
    for (const secret of [WIFI_PASSWORD, SIGNING_KEY]) {
      assert.ok(!shown.includes(secret), 'not on the page');
      assert.ok(!sent.some((request) => request.includes(secret) || request.includes(encodeURIComponent(secret))), 'not in any request to the server');
      assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).includes(secret), 'not in browser storage');
    }
    assert.ok(sent.every((request) => request.length < 4096), 'and no firmware was uploaded: nothing this page sent is the size of an image');
    // The firmware came through the edge, which asked GitHub; the browser asked nobody else.
    assert.deepEqual(sent.filter((request) => request.includes('/api/flash/')).map((request) => request.split(' ').slice(0, 2).join(' ').replace(base, '')), [
      'GET /api/flash/firmware', 'GET /api/flash/firmware/v1.6/bootloader.bin', 'GET /api/flash/firmware/v1.6/partitions.bin', 'GET /api/flash/firmware/v1.6/firmware.bin',
    ]);
    assert.ok(sent.every((request) => !new URL(request.split(' ')[1]).hostname.includes('github')), 'the page itself never contacts GitHub');
    assert.ok(github.asked.length > 0 && github.asked.every((url) => /^https:\/\/(github\.com\/Mysteringz\/TMsense\/releases|release-assets\.githubusercontent\.com)\//.test(url)), 'and the edge contacted GitHub, for this repository, and nothing else');
    const asked = sent.filter((request) => request.startsWith('POST ') && request.includes('/api/adoption/')).map((request) => new URL(request.split(' ')[1]).pathname.replace(/[0-9a-f-]{36}/, ':id'));
    assert.deepEqual(asked, ['/api/adoption/requests', '/api/adoption/requests/:id/approve'], 'what it told the edge is the question and its answer');

    await page.getByRole('button', { name: 'Set up another board' }).click();
    assert.equal(await page.getByLabel('Node ID').inputValue(), '12', 'boards in a row get numbers in a row');
    await page.getByRole('button', { name: 'Connect a board' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test('chromium: a node already in service gets new settings without its firmware or its bootloader being touched', { timeout: 60_000 }, async () => {
  const uid = '30:ed:a0:cb:f5:f8';   // in the registry already: "Above M3"
  const browser = await chromium.launch({ headless: true });
  const { context, page, board, errors } = await open(browser, 'engineer', { uid });
  try {
    // A node that reaches the edge directly, as the installed one does.
    for (const line of ['set id 3', 'set ssid Maker Space', 'set pass old password', 'set edges 192.0.2.10', 'set key oldkey', 'set cloud_url wss://sense.example.com/tmnode', 'set transport wss', 'save']) board.node.handle(line, Date.now() + 1000);
    board.node.received.length = 0;

    await page.getByRole('button', { name: 'Connect a board' }).click();
    const identity = page.locator('.fl-board');
    await identity.getByText('TMsense #3').waitFor({ timeout: 20_000 });
    await identity.getByText('Wi-Fi, direct to cloud').waitFor();
    assert.equal(await page.getByLabel('Node ID').inputValue(), '3');
    assert.equal(await page.locator('.fl-choice label.is-on').filter({ hasText: 'Wi-Fi' }).textContent(), 'Wi-Fi · direct to cloud',
      'the uplink starts from how the node is set up, so pressing the button does not move it off the cloud');

    await page.getByText('Write firmware', { exact: false }).first().click();
    await page.getByText('4 fps', { exact: true }).click();
    await page.getByRole('button', { name: 'Write settings' }).click();
    const outcome = page.locator('.fl-outcome');
    await outcome.waitFor({ timeout: 45_000 });
    assert.equal((await outcome.innerText()).split('\n')[0].replace(/^\S\s+/, ''), 'Done', await outcome.innerText());
    await outcome.getByText('Accepted a report').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'a node the edge already knows needs no question');

    assert.deepEqual(board.ops, [], 'the bootloader was never entered');
    assert.deepEqual(board.erased, []);
    assert.deepEqual(board.node.received.filter((line) => line !== 'show'), ['set id 3', 'set mode wifi', 'set transport wss', 'set fps 4', 'save', 'reboot']);
    assert.deepEqual([board.node.saved.ssid, board.node.saved.cloud_url, board.node.saved.transport, board.node.saved.fps], ['Maker Space', 'wss://sense.example.com/tmnode', 'wss', '4'],
      'blank fields kept what the node had');

    await page.getByRole('button', { name: 'Set up another board' }).click();
    await page.getByRole('button', { name: 'Connect a board' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test('chromium: a release that is not TMsense firmware is never offered, and a board that is not an ESP32-S3 is refused before anything is written', { timeout: 60_000 }, async () => {
  // The repository's latest release carries something else under the right names, with hashes that agree.
  const images = { ...BUILD, 'firmware.bin': espImage(4096, 2, 'some other firmware') };
  github.latest = { tag: RELEASE.tag, files: { ...images, 'tmflash-manifest.json': manifestFor('tmsense-1.6', images) } };
  const browser = await chromium.launch({ headless: true });
  const { context, page, board } = await open(browser, 'engineer', { uid: '30:ed:a0:11:22:0c', blank: true });
  try {
    board.chipId = 5;   // an ESP32-C3
    await page.getByRole('button', { name: 'Connect a board' }).click();
    await page.getByText('No TMsense firmware answered.').waitFor({ timeout: 20_000 });
    // Refused by the edge before the page or the board is involved at all.
    await page.getByRole('alert').filter({ hasText: 'Release v1.6 cannot be flashed' }).waitFor();
    assert.equal(await page.locator('.fl-build').count(), 0, 'no plan is shown for a release that did not check out');
    assert.equal(await page.getByRole('button', { name: 'Flash and set up' }).isDisabled(), true);
    await shot(page, 'flash-no-release-1280');
    // A good release is published; the page picks it up when asked.
    github.latest = RELEASE;
    clock.at += 61_000;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.fl-build').getByText('tmsense-1.6').waitFor();
    await page.getByLabel('Node ID').fill('12');
    await page.locator('label.fl-check').filter({ hasText: 'Ask TMedge to admit' }).click();
    await page.getByRole('button', { name: 'Flash and set up' }).click();
    const outcome = page.locator('.fl-outcome');
    await outcome.getByRole('heading', { name: 'Failed' }).waitFor({ timeout: 45_000 });
    await outcome.getByText('This board is an ESP32-C3, not the ESP32-S3 a TMsense node uses').waitFor();
    assert.deepEqual(board.ops.filter((entry) => entry.name.startsWith('flash') || entry.name.startsWith('erase')), []);
    assert.deepEqual(board.erased, []);
    await shot(page, 'flash-failed-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await fits(page, 390);
  } finally { github.latest = RELEASE; await context.close(); await browser.close(); }
});

test('chromium: with no release published the page says so and offers nothing to write, but can still change a node’s settings', { timeout: 60_000 }, async () => {
  github.latest = null;
  const uid = '30:ed:a0:cb:f5:f8';
  const browser = await chromium.launch({ headless: true });
  const { context, page, board, errors } = await open(browser, 'engineer', { uid });
  try {
    for (const line of ['set id 3', 'set ssid Maker Space', 'set pass old password', 'set edges 192.0.2.10', 'set key oldkey', 'save']) board.node.handle(line, Date.now() + 1000);
    await page.getByRole('alert').filter({ hasText: 'The TMsense repository has not published a release with flashable images yet' }).waitFor();
    await page.getByRole('button', { name: 'Connect a board' }).click();
    await page.locator('.fl-board').getByText('TMsense #', { exact: false }).waitFor({ timeout: 20_000 });
    await page.getByText('No firmware release to write: see step 2').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Flash and set up' }).isDisabled(), true);
    for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 900 }); await fits(page, width); }
    // Settings only: the firmware the node has stays, and so no release is needed.
    await page.getByText('Write firmware', { exact: false }).first().click();
    assert.equal(await page.getByRole('button', { name: 'Write settings' }).isDisabled(), false);
    assert.deepEqual(board.ops, [], 'and nothing was written to find that out');
    assert.deepEqual(errors, []);
  } finally { github.latest = RELEASE; await context.close(); await browser.close(); }
});

test('chromium: an operator can read the page and cannot flash from it', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await open(browser, 'operator', { uid: '30:ed:a0:11:22:0d' });
  try {
    await page.getByText('Engineer or Admin access is required to flash and commission devices.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect a board' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__chooser), undefined, 'the browser was never asked for a device');
    const refused = await context.request.post(`${base}/api/adoption/requests`, { headers: { 'x-tm-algo': '1' }, data: { uid: '30:ed:a0:11:22:0d' } });
    assert.equal(refused.status(), 403);
  } finally { await context.close(); await browser.close(); }
});

test('webkit: a browser with no Web Serial is told so, and is not shown a form it cannot use', { timeout: 30_000 }, async () => {
  const browser = await webkit.launch({ headless: true });
  const { context, page, errors } = await open(browser, 'engineer');
  try {
    await page.getByRole('heading', { name: 'This browser cannot reach USB devices' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect a board' }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await fits(page, 390);
    await shot(page, 'flash-unsupported-390');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
