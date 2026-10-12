/**
 * Where the web flasher's firmware comes from: the latest release of the
 * TMsense repository on GitHub, fetched and checked by the edge. GitHub here
 * is test/fake-github.ts; nothing in this file touches the network.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GitHubReleaseSource } from '../src/infrastructure/firmware-release/github-release-source.js';
import { createPublishedReleaseRouter } from '../src/modules/firmware/routes/published-release-router.js';
import { parseManifest, ReleaseUnavailable, TMSENSE_REPOSITORY } from '../src/shared/flasher/release.js';
import { espImage, FakeGitHub, manifestFor, partitionTable, tmsenseRelease, type FakeRelease } from './fake-github.js';

function setup(latest: FakeRelease | null = tmsenseRelease()) {
  const github = new FakeGitHub();
  github.latest = latest;
  const clock = { at: 1_800_000_000_000 };
  const source = new GitHubReleaseSource(undefined, github.fetch, () => clock.at);
  return { github, clock, source };
}

const refusal = async (work: Promise<unknown>): Promise<ReleaseUnavailable> => {
  try { await work; } catch (error) { assert.ok(error instanceof ReleaseUnavailable, String(error)); return error; }
  return assert.fail('a release was offered');
};

/** The same release with one of its images swapped, and a manifest that agrees with the swap. */
function rebuilt(version: string, change: Record<string, Buffer>, manifest: Record<string, unknown> = {}): FakeRelease {
  const base = tmsenseRelease(version);
  const images = { 'bootloader.bin': base.files['bootloader.bin'] ?? Buffer.alloc(0), 'partitions.bin': base.files['partitions.bin'] ?? Buffer.alloc(0), 'firmware.bin': base.files['firmware.bin'] ?? Buffer.alloc(0), ...change };
  return { tag: base.tag, files: { ...images, 'tmflash-manifest.json': manifestFor(version, images, manifest) } };
}

test('the firmware on offer is the latest release of the TMsense repository: three files that match its manifest', async () => {
  const published = tmsenseRelease('tmsense-1.6');
  const { github, source, clock } = setup(published);
  const release = await source.latest();
  assert.equal(TMSENSE_REPOSITORY, 'Mysteringz/TMsense');
  assert.deepEqual([release.repository, release.version, release.tag, release.commit, release.checkedAt],
    ['Mysteringz/TMsense', 'tmsense-1.6', 'v1.6', 'f193c8370d3a5eb27d40135290a0ce428c551a94', clock.at]);
  assert.deepEqual(release.files.map((file) => file.name), ['bootloader.bin', 'partitions.bin', 'firmware.bin']);
  for (const file of release.files) {
    const bytes = source.bytes('v1.6', file.name);
    assert.ok(bytes?.equals(published.files[file.name] ?? Buffer.alloc(0)), `${file.name} is byte for byte what was published`);
    assert.equal(createHash('sha256').update(bytes ?? '').digest('hex'), file.sha256);
  }
  // Read without a token, from GitHub and its download host, over https, and from this one repository.
  assert.ok(github.asked.length > 0);
  for (const asked of github.asked) {
    const url = new URL(asked);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'), asked);
    if (url.hostname === 'github.com') assert.ok(url.pathname.startsWith('/Mysteringz/TMsense/releases/'), asked);
  }
  assert.equal(source.bytes('v1.5', 'firmware.bin'), null, 'only the release on offer is served');
  assert.equal(source.bytes('v1.6', 'tmflash-manifest.json'), null);
  assert.equal(source.bytes('v1.6', '../../etc/passwd'), null);
});

test('GitHub is asked once however many pages are open, and a new release is picked up within a minute', async () => {
  const { github, source, clock } = setup(tmsenseRelease('tmsense-1.6'));
  const answers = await Promise.all([source.latest(), source.latest(), source.latest()]);
  assert.deepEqual(answers.map((release) => release.tag), ['v1.6', 'v1.6', 'v1.6']);
  const first = github.asked.length;
  assert.equal(github.asked.filter((url) => url.includes('/latest/')).length, 1, 'three askers, one check');

  clock.at += 59_000;
  await source.latest();
  assert.equal(github.asked.length, first, 'a page left open does not make the edge poll GitHub');

  // Still the same release a minute later: the manifest is re-read, the images are not downloaded again.
  clock.at += 2_000;
  assert.equal((await source.latest()).checkedAt, clock.at);
  assert.equal(github.asked.filter((url) => url.includes('firmware.bin')).length, 2, 'firmware.bin: one tagged URL and one download, both from the first check');

  github.latest = tmsenseRelease('tmsense-1.7');
  clock.at += 61_000;
  assert.equal((await source.latest()).version, 'tmsense-1.7');
  assert.equal(source.bytes('v1.6', 'firmware.bin'), null, 'and the release it replaced is no longer handed out');
  assert.ok(source.bytes('v1.7', 'firmware.bin'));
});

test('a file that is not the one the manifest describes is never offered', async () => {
  const honest = tmsenseRelease('tmsense-1.6');
  const swapped = espImage(180_000, 12, '=== TMsense %s ===\0tmsense-1.6\0');
  assert.equal(swapped.length, honest.files['firmware.bin']?.length, 'same size, same header, different firmware');
  const { source } = setup({ tag: honest.tag, files: { ...honest.files, 'firmware.bin': swapped } });
  const error = await refusal(source.latest());
  assert.equal(error.reason, 'invalid');
  assert.match(error.message, /firmware\.bin in release v1\.6 is not the file its manifest describes/);
  assert.equal(source.bytes('v1.6', 'firmware.bin'), null);
  assert.equal(source.bytes('v1.6', 'bootloader.bin'), null, 'nor any other part of it');

  const short = setup({ tag: honest.tag, files: { ...honest.files, 'bootloader.bin': (honest.files['bootloader.bin'] ?? Buffer.alloc(0)).subarray(0, 15000) } });
  assert.equal((await refusal(short.source.latest())).reason, 'invalid');
  const { ['partitions.bin']: _dropped, ...partial } = honest.files;
  assert.match((await refusal(setup({ tag: honest.tag, files: partial }).source.latest())).message, /has no partitions\.bin/);
});

test('hashes that agree are not enough: a release must be flashable TMsense firmware, and be the version it claims', async () => {
  // Built for another chip.
  const c3 = rebuilt('tmsense-1.6', { 'firmware.bin': espImage(180_000, 11, '=== TMsense %s ===\0tmsense-1.6\0', 5) });
  assert.match((await refusal(setup(c3).source.latest())).message, /^release v1\.6 cannot be flashed: /);
  // Not TMsense at all.
  const other = rebuilt('tmsense-1.6', { 'firmware.bin': espImage(180_000, 11, 'some other firmware') });
  assert.match((await refusal(setup(other).source.latest())).message, /cannot be flashed/);
  // A layout whose application would land on the node's saved settings.
  const overlapping = rebuilt('tmsense-1.6', { 'partitions.bin': partitionTable([['nvs', 1, 2, 0x9000, 0x8000], ['otadata', 1, 0, 0x11000, 0x2000], ['app0', 0, 0x10, 0x10000, 0x330000]]) });
  assert.equal((await refusal(setup(overlapping).source.latest())).reason, 'invalid');
  // Named 1.7, but the image inside reports 1.6: the tag would lie about what nodes run.
  const base = tmsenseRelease('tmsense-1.6');
  const images = { 'bootloader.bin': base.files['bootloader.bin'] ?? Buffer.alloc(0), 'partitions.bin': base.files['partitions.bin'] ?? Buffer.alloc(0), 'firmware.bin': base.files['firmware.bin'] ?? Buffer.alloc(0) };
  const mislabelled = { tag: 'v1.7', files: { ...images, 'tmflash-manifest.json': manifestFor('tmsense-1.7', images) } };
  assert.match((await refusal(setup(mislabelled).source.latest())).message, /says it is tmsense-1\.7, but its firmware reports tmsense-1\.6/);
});

test('a repository with no release is said plainly, and is not mistaken for a network fault', async () => {
  const { source, github, clock } = setup(null);
  const error = await refusal(source.latest());
  assert.equal(error.reason, 'none');
  assert.match(error.message, /has not published a release/);
  // The answer is kept for a moment rather than asked for again by every page...
  const asked = github.asked.length;
  await refusal(source.latest());
  assert.equal(github.asked.length, asked);
  // ...and a release published since is found soon after.
  github.latest = tmsenseRelease('tmsense-1.6');
  clock.at += 16_000;
  assert.equal((await source.latest()).tag, 'v1.6');
});

test('a redirect that leaves GitHub ends the fetch before anything else is contacted', async () => {
  for (const elsewhere of ['https://downloads.example.com/firmware.bin', 'http://release-assets.githubusercontent.com/firmware.bin', 'https://githubusercontent.com.example.com/x', 'https://user:pass@github.com/x', 'file:///etc/passwd']) {
    const { source, github } = setup(tmsenseRelease());
    github.redirectTo = () => elsewhere;
    const error = await refusal(source.latest());
    assert.equal(error.reason, 'invalid', elsewhere);
    assert.match(error.message, /somewhere that is not GitHub/);
    assert.ok(!github.asked.includes(new URL(elsewhere).href), `${elsewhere} was never requested`);
    assert.equal(source.bytes('v1.6', 'firmware.bin'), null);
  }
});

test('a file larger than the board has room for is cut off as it arrives', async () => {
  const honest = tmsenseRelease();
  // The manifest is where sizes are promised, so it is the first thing that can lie about one.
  const { source, github } = setup({ tag: honest.tag, files: { ...honest.files, 'tmflash-manifest.json': Buffer.alloc(64 * 1024, 0x20) } });
  assert.match((await refusal(source.latest())).message, /larger than anything this board could hold/);
  assert.ok(!github.asked.some((url) => url.includes('firmware.bin')), 'and nothing it named was fetched');
  const fat = setup({ tag: honest.tag, files: { ...honest.files, 'bootloader.bin': Buffer.alloc(0x8001, 0xe9) } });
  assert.equal((await refusal(fat.source.latest())).reason, 'invalid');
});

test('with GitHub away, the release already checked is still offered; a broken latest release is not papered over with the old one', async () => {
  const { source, github, clock } = setup(tmsenseRelease('tmsense-1.6'));
  const checked = (await source.latest()).checkedAt;
  github.down = true;
  clock.at += 120_000;
  const stale = await source.latest();
  assert.deepEqual([stale.tag, stale.checkedAt], ['v1.6', checked], 'the same release, and honest about when GitHub last confirmed it');
  assert.ok(source.bytes('v1.6', 'firmware.bin'));

  // GitHub is back, and what it now calls latest does not check out.
  github.down = false;
  const broken = tmsenseRelease('tmsense-1.7');
  github.latest = { tag: broken.tag, files: { ...broken.files, 'firmware.bin': espImage(180_000, 99, 'tmsense-1.7\0') } };
  clock.at += 120_000;
  assert.equal((await refusal(source.latest())).reason, 'invalid');
  assert.equal(source.bytes('v1.6', 'firmware.bin'), null, '1.6 is not the latest release any more, and is not handed out as if it were');

  // With nothing checked yet, an unreachable GitHub is an error, not an empty success.
  const cold = setup(tmsenseRelease());
  cold.github.down = true;
  const error = await refusal(cold.source.latest());
  assert.deepEqual([error.reason, error.message], ['unreachable', 'GitHub could not be reached for the TMsense release']);
});

test('the manifest is read strictly: anything not fully understood is refused', () => {
  const release = tmsenseRelease('tmsense-1.6');
  const images = { 'bootloader.bin': release.files['bootloader.bin'] ?? Buffer.alloc(0), 'partitions.bin': release.files['partitions.bin'] ?? Buffer.alloc(0), 'firmware.bin': release.files['firmware.bin'] ?? Buffer.alloc(0) };
  const good = JSON.parse(manifestFor('tmsense-1.6', images).toString()) as { files: { name: string; size: number; sha256: string }[] };
  assert.equal(parseManifest(JSON.stringify(good)).tag, 'v1.6');
  const file = (index: number, change: Record<string, unknown>) => ({ files: good.files.map((entry, at) => at === index ? { ...entry, ...change } : entry) });
  const bad: [string, Record<string, unknown>][] = [
    ['a newer format', { format: 2 }],
    ['another project', { project: 'TMWAccess' }],
    ['another board', { board: 'esp32dev' }],
    ['no version', { version: '' }],
    ['a version that is not TMsense', { version: 'v1.6' }],
    ['a pre-release version', { version: 'tmsense-1.6-rc1', tag: 'v1.6-rc1' }],
    ['a tag that is not the version', { tag: 'v1.7' }],
    ['a tag that walks out of the release path', { tag: '../../v1.6' }],
    ['a short commit', { commit: 'f193c83' }],
    ['two files', { files: good.files.slice(0, 2) }],
    ['a fourth file', { files: [...good.files, { name: 'extra.bin', size: 1, sha256: 'a'.repeat(64) }] }],
    ['a file this console does not flash', file(0, { name: 'boot_app0.bin' })],
    ['the same file twice', file(0, { name: 'firmware.bin' })],
    ['a path instead of a name', file(2, { name: '../firmware.bin' })],
    ['an empty file', file(2, { size: 0 })],
    ['an application larger than its slot', file(2, { size: 0x330001 })],
    ['a bootloader that reaches the partition table', file(0, { size: 0x8001 })],
    ['a fractional size', file(1, { size: 3072.5 })],
    ['an MD5 where a SHA-256 belongs', file(1, { sha256: 'a'.repeat(32) })],
    ['an upper-case hash', file(1, { sha256: 'A'.repeat(64) })],
  ];
  for (const [what, change] of bad) {
    assert.throws(() => parseManifest(JSON.stringify({ ...good, ...change })), (error: unknown) => error instanceof ReleaseUnavailable && error.reason === 'invalid', what);
  }
  for (const text of ['', 'null', '[]', '"v1.6"', '<html>Not Found</html>']) assert.throws(() => parseManifest(text), ReleaseUnavailable, text);
});

test('the console hands the page the release and its files, and has no way to be handed one', async () => {
  const published = tmsenseRelease('tmsense-1.6');
  const { source, github } = setup(published);
  const app = express();
  app.use('/api/flash', createPublishedReleaseRouter(source));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/flash`;
  try {
    const described = await fetch(`${base}/firmware`);
    assert.equal(described.status, 200);
    const release = await described.json() as { tag: string; version: string; repository: string; files: { name: string; size: number }[] };
    assert.deepEqual([release.repository, release.tag, release.version], ['Mysteringz/TMsense', 'v1.6', 'tmsense-1.6']);
    for (const file of release.files) {
      const sent = await fetch(`${base}/firmware/${release.tag}/${file.name}`);
      assert.deepEqual([sent.status, sent.headers.get('content-type'), sent.headers.get('content-length')], [200, 'application/octet-stream', String(file.size)]);
      assert.ok(Buffer.from(await sent.arrayBuffer()).equals(published.files[file.name] ?? Buffer.alloc(0)));
    }
    assert.equal((await fetch(`${base}/firmware/v1.5/firmware.bin`)).status, 404, 'a release that is not the one on offer');
    assert.equal((await fetch(`${base}/firmware/v1.6/tmflash-manifest.json`)).status, 404);
    assert.equal((await fetch(`${base}/firmware/v1.6/..%2F..%2Fpackage.json`)).status, 404);
    // Read-only: there is nothing to POST or PUT an image to.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await fetch(`${base}/firmware`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 404, method);
      assert.equal((await fetch(`${base}/firmware/v1.6/firmware.bin`, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 404, method);
    }

    // No release: a 404 that says so. GitHub away with nothing checked: a 502.
    const none = setup(null);
    const empty = express().use('/api/flash', createPublishedReleaseRouter(none.source)).listen(0, '127.0.0.1');
    await new Promise((done) => empty.once('listening', done));
    try {
      const at = `http://127.0.0.1:${(empty.address() as AddressInfo).port}/api/flash/firmware`;
      const missing = await fetch(at);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'the TMsense repository has not published a release with flashable images yet', reason: 'none' });
      none.github.down = true;
      none.clock.at += 20_000;
      const away = await fetch(at);
      assert.deepEqual([away.status, (await away.json() as { reason: string }).reason], [502, 'unreachable']);
    } finally { await new Promise((done) => empty.close(done)); }
    assert.ok(github.asked.every((url) => /^https:\/\/(github\.com|release-assets\.githubusercontent\.com)\//.test(url)));
  } finally { await new Promise((done) => server.close(done)); }
});

// The manifest has a writer (TMsense's tools/release_manifest.py) and this
// reader. With a TMsense checkout that has both the tool and a PlatformIO
// build, the writer's real output goes through the reader. CI has neither.
const tmsense = resolve(process.env.TMSENSE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'TMsense'));
const tool = join(tmsense, 'tools', 'release_manifest.py'), realBuild = join(tmsense, '.pio', 'build', 'tmflash');
test('a release packaged by TMsense’s own tool from a real build is one this console accepts', { skip: (!existsSync(tool) || !existsSync(join(realBuild, 'firmware.bin'))) && 'no TMsense checkout with tools/release_manifest.py and a tmflash build (set TMSENSE_DIR)' }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'tmedge-release-'));
  try {
    execFileSync('python3', [tool, '--build', realBuild, '--out', out, '--commit', 'f193c8370d3a5eb27d40135290a0ce428c551a94'], { stdio: 'pipe' });
    const manifest = parseManifest(readFileSync(join(out, 'tmflash-manifest.json'), 'utf8'));
    const files: Record<string, Buffer> = { 'tmflash-manifest.json': readFileSync(join(out, 'tmflash-manifest.json')) };
    for (const file of manifest.files) files[file.name] = readFileSync(join(out, file.name));
    const { source } = setup({ tag: manifest.tag, files });
    const release = await source.latest();
    assert.deepEqual([release.version, release.tag], [manifest.version, manifest.tag]);
    assert.match(release.version, /^tmsense-\d+\.\d+/);
    assert.ok(source.bytes(release.tag, 'firmware.bin')?.equals(readFileSync(join(realBuild, 'firmware.bin'))));
  } finally { rmSync(out, { recursive: true, force: true }); }
});
