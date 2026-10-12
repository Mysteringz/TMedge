/** The real download page and authenticated server, with GitHub replaced by
 * published fixture releases. No native app is installed and no USB is used. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { KEY, siteJson, nodesJson } from '../dist/test/fixtures.js';
import { FakeGitHub, tmflashRelease } from '../dist/test/fake-github.js';
import { GitHubTMflashSource } from '../dist/src/infrastructure/tmflash-release/github-tmflash-source.js';

let runtime, handle, base, directory;
const github = new FakeGitHub('Mysteringz/TMflash');
const clock = { at: Date.now() };
const savedDataDir = process.env.DATA_DIR;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tmflash-page-'));
  process.env.DATA_DIR = directory;
  writeFileSync(join(directory, 'nodes.json'), JSON.stringify(nodesJson()));
  const config = {
    edgeId: 'tmflash-download-preview', keys: [KEY], allowUnsigned: false,
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
  await accounts.add('reader', 'local download test password', 'viewer');
  handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({
    DATA_DIR: directory, ALGO_USERS_FILE: users, SESSION_SECRET: 'local-only-test-secret'.repeat(3),
  }, config.adminPassword), undefined, { tmflashRelease: new GitHubTMflashSource(join(directory, 'tmflash'), github.fetch, () => clock.at) });
  await new Promise(resolve => handle.server.once('listening', resolve));
  base = `http://127.0.0.1:${handle.server.address().port}`;
});
after(async () => {
  await handle?.dispose();
  if (handle) await new Promise(resolve => handle.server.close(resolve));
  await runtime?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
});

for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engine}: portable app download, installation, automatic updates and failure states work on desktop and phones`, { timeout: 90_000 }, async () => {
    github.down = false; github.latest = tmflashRelease(); clock.at += 60_001;
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const before = github.asked.length;
      assert.equal((await context.request.get(`${base}/api/tmflash-download/release`)).status(), 401);
      assert.equal(github.asked.length, before, 'anonymous requests do not initiate downloads');
      assert.equal((await context.request.post(`${base}/auth/login`, { data: { username: 'reader', password: 'local download test password' } })).status(), 200);
      await page.clock.install();
      await page.goto(`${base}/tmflash-download`);
      await page.getByRole('heading', { name: 'TMflash download', exact: true }).waitFor();
      await page.getByText('Version 1.5.0', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Connect a board' }).count(), 0);
      assert.equal(await page.locator('.td-logo').evaluate(image => image.complete && image.naturalWidth > 0), true);
      assert.equal(await page.locator('.td-install-steps li').count(), 3);
      assert.equal(await page.getByText('If macOS asks about the developer', { exact: true }).count(), 1);
      assert.equal(await page.getByText('No Python, PlatformIO or source folder to install.', { exact: false }).count(), 1);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of [320, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
          const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
            targets: [...document.querySelectorAll('.cx-tmflash-download a,.cx-tmflash-download button,.cx-tmflash-download summary')]
              .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height).map(rect => ({ x: rect.x, right: rect.right, height: rect.height })) }));
          assert.ok(layout.content <= width + 1, `download page fits ${width}px`);
          for (const target of layout.targets) { assert.ok(target.x >= -1 && target.right <= width + 1); assert.ok(target.height >= 43); }
          if (process.env.ALGO_UI_SCREENSHOTS) {
            mkdirSync(process.env.ALGO_UI_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: join(process.env.ALGO_UI_SCREENSHOTS, `tmflash-download-${engine}-${scheme}-${width}.png`), fullPage: true });
          }
        }
      }
      const downloadReady = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download for macOS' }).click();
      const download = await downloadReady;
      assert.equal(download.suggestedFilename(), 'TMflash-1.5.0-universal.dmg');
      assert.equal(new URL(download.url()).origin, base, 'the portal hosts the verified file itself');
      const downloaded = await download.path(); assert.ok(downloaded);
      assert.deepEqual(readFileSync(downloaded), github.latest.files[download.suggestedFilename()]);
      assert.equal((await context.request.post(`${base}/api/tmflash-download/release`, { data: {} })).status(), 404);

      github.latest = tmflashRelease('1.6.0', 'b'.repeat(40)); clock.at += 60_001;
      await page.clock.fastForward(60_001);
      await page.getByText('Version 1.6.0', { exact: true }).waitFor();
      assert.match(await page.getByRole('link', { name: 'Download for macOS' }).getAttribute('href'), /TMflash-1.6.0-universal.dmg$/);
      github.down = true; clock.at += 60_001;
      await page.clock.fastForward(60_001);
      await page.getByRole('status').filter({ hasText: 'last verified build' }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Download for macOS' }).count(), 1);
      github.down = false; github.latest = null; clock.at += 60_001;
      await page.clock.fastForward(60_001);
      await page.getByRole('alert').filter({ hasText: 'has not been published' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Download unavailable' }).isDisabled(), true);
      assert.equal(await page.getByRole('link', { name: 'Download for macOS' }).count(), 0);

      await page.getByRole('link', { name: 'Open TMflash web' }).click();
      await page.waitForURL(`${base}/flash`);
      await page.getByRole('heading', { name: 'TMflash web', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); await browser.close(); }
  });
}
