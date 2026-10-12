import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { GitHubTMflashSource } from '../src/infrastructure/tmflash-release/github-tmflash-source.js';
import { createTMflashDownloadRouter } from '../src/modules/tmflash/routes/tmflash-download-router.js';
import { parseTMflashRelease, TMFLASH_MAX_BYTES, TMflashUnavailable, tmflashDownloadPath } from '../src/shared/tmflash-release.js';
import { FakeGitHub, tmflashRelease, type FakeRelease } from './fake-github.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tmflash-release-'));
  const github = new FakeGitHub('Mysteringz/TMflash');
  github.latest = tmflashRelease();
  const clock = { at: 1_000_000 };
  const source = new GitHubTMflashSource(directory, github.fetch, () => clock.at);
  return { directory, github, clock, source, dispose: () => rm(directory, { recursive: true, force: true }) };
}
function alter(release: FakeRelease, changes: Record<string, unknown>) {
  const text = release.files['tmflash-app.json'];
  assert.ok(text);
  release.files['tmflash-app.json'] = Buffer.from(JSON.stringify({ ...JSON.parse(text.toString()), ...changes }));
}

test('one checked GitHub DMG is hosted locally, concurrent readers share it, and unchanged builds are not downloaded again', async () => {
  const f = await fixture();
  try {
    const releases = await Promise.all([f.source.latest(), f.source.latest(), f.source.latest()]);
    assert.equal(f.github.asked.filter(url => url.endsWith('/latest/download/tmflash-app.json')).length, 1);
    assert.equal(releases[0]?.repository, 'Mysteringz/TMflash');
    const release = releases[0]; assert.ok(release);
    const path = f.source.file(release.tag, release.filename); assert.ok(path);
    assert.deepEqual(await readFile(path), f.github.latest?.files[release.filename]);
    assert.ok(f.github.asked.every(url => new URL(url).hostname === 'github.com' || new URL(url).hostname === 'release-assets.githubusercontent.com'));
    const before = f.github.asked.filter(url => new URL(url).pathname.endsWith('.dmg')).length;
    f.clock.at += 60_001;
    assert.equal((await f.source.latest()).checkedAt, f.clock.at);
    assert.equal(f.github.asked.filter(url => new URL(url).pathname.endsWith('.dmg')).length, before);
  } finally { await f.dispose(); }
});

test('a newly published app replaces the download automatically and the preceding page can still finish its download', async () => {
  const f = await fixture();
  try {
    const old = await f.source.latest();
    f.github.latest = tmflashRelease('1.6.0', 'b'.repeat(40));
    f.clock.at += 60_001;
    const latest = await f.source.latest();
    assert.equal(latest.version, '1.6.0');
    assert.notEqual(latest.sha256, old.sha256);
    assert.ok(f.source.file(old.tag, old.filename));
    const path = f.source.file(latest.tag, latest.filename); assert.ok(path);
    assert.deepEqual(await readFile(path), f.github.latest.files[latest.filename]);
    f.github.latest = tmflashRelease('1.7.0', 'c'.repeat(40));
    f.clock.at += 60_001;
    await f.source.latest();
    assert.equal(f.source.file(old.tag, old.filename), null);
    assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.dmg')).length, 2);
    // Following an owner's GitHub rollback must retain that displayed build
    // as the preceding download when a corrected release follows it.
    f.github.latest = tmflashRelease('1.6.0', 'b'.repeat(40)); f.clock.at += 60_001;
    await f.source.latest();
    f.github.latest = tmflashRelease('1.8.0', 'd'.repeat(40)); f.clock.at += 60_001;
    await f.source.latest();
    assert.ok(f.source.file(latest.tag, latest.filename));
  } finally { await f.dispose(); }
});

test('a checked cache survives server restart and is explicitly stale while GitHub is unavailable', async () => {
  const f = await fixture();
  try {
    const old = await f.source.latest();
    f.clock.at += 60_001;
    f.github.down = true;
    const restarted = new GitHubTMflashSource(f.directory, f.github.fetch, () => f.clock.at);
    const release = await restarted.latest();
    assert.equal(release.sha256, old.sha256);
    assert.equal(release.checkedAt, old.checkedAt);
    assert.equal(release.stale, true);
    assert.ok(restarted.file(old.tag, old.filename));
  } finally { await f.dispose(); }
});

test('a broken newest release is never disguised as an older download, including after restart', async () => {
  const f = await fixture();
  try {
    const old = await f.source.latest();
    f.github.latest = tmflashRelease('1.6.0', 'b'.repeat(40));
    const damaged = f.github.latest.files['TMflash-1.6.0-universal.dmg']; assert.ok(damaged);
    damaged[0] = 0;
    f.clock.at += 60_001;
    await assert.rejects(f.source.latest(), (error: unknown) => error instanceof TMflashUnavailable && error.reason === 'invalid');
    assert.equal(f.source.file(old.tag, old.filename), null);
    assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp') || name === 'current.json'));
    f.github.down = true;
    const restarted = new GitHubTMflashSource(f.directory, f.github.fetch, () => f.clock.at);
    await assert.rejects(restarted.latest());
  } finally { await f.dispose(); }
});

test('manifest validation rejects foreign projects, dirty builds, unsafe filenames and unsupported sizes', () => {
  const release = tmflashRelease();
  const bytes = release.files['tmflash-app.json']; assert.ok(bytes);
  const manifest = JSON.parse(bytes.toString()) as Record<string, unknown>;
  assert.equal(parseTMflashRelease(bytes.toString()).version, '1.5.0');
  for (const changes of [
    { project: 'other' }, { format: 2 }, { sourceModified: true }, { tag: 'unrelated' },
    { filename: '../secret.dmg' }, { size: TMFLASH_MAX_BYTES + 1 }, { size: 511 },
    { sha256: 'no-hash' }, { architectures: ['arm64'] }, { builtAt: 'yesterday' }, { minimumMacOS: 'unrestricted' },
    { commit: 'a'.repeat(40) + '\n', tag: 'build-' + 'a'.repeat(40) + '\n' },
    { version: '1.5.0\n', filename: 'TMflash-1.5.0\n-universal.dmg' },
  ]) assert.throws(() => parseTMflashRelease(JSON.stringify({ ...manifest, ...changes })));
});

test('matching a checksum is insufficient for a non-DMG, and oversized transfers leave no published or temporary file', async () => {
  for (const mode of ['not-dmg', 'oversized']) {
    const f = await fixture();
    try {
      const release = f.github.latest; assert.ok(release);
      const file = release.files['TMflash-1.5.0-universal.dmg']; assert.ok(file);
      if (mode === 'not-dmg') {
        file.fill(0);
        alter(release, { sha256: createHash('sha256').update(file).digest('hex') });
      } else alter(release, { size: 512 });
      await assert.rejects(f.source.latest(), (error: unknown) => error instanceof TMflashUnavailable && error.reason === 'invalid');
      assert.deepEqual((await readdir(f.directory)).filter(name => name.endsWith('.dmg') || name.endsWith('.tmp')), []);
    } finally { await f.dispose(); }
  }
});

test('redirects cannot turn the app cache into a downloader for another host, plaintext URL or credential-bearing address', async () => {
  for (const destination of ['https://example.com/app.dmg', 'http://release-assets.githubusercontent.com/app.dmg',
    'https://github.com:8443/app.dmg', 'https://user:password@github.com/app.dmg', 'https://githubusercontent.com.example.com/app.dmg']) {
    const f = await fixture();
    try {
      f.github.redirectTo = () => destination;
      await assert.rejects(f.source.latest(), (error: unknown) => error instanceof TMflashUnavailable && error.reason === 'invalid');
      assert.ok(!f.github.asked.includes(destination));
    } finally { await f.dispose(); }
  }
});

test('an unpublished app is a clear absence, not a working download', async () => {
  const f = await fixture();
  try {
    f.github.latest = null;
    await assert.rejects(f.source.latest(), (error: unknown) => error instanceof TMflashUnavailable && error.reason === 'none');
  } finally { await f.dispose(); }
});

test('a damaged persisted cache is not served during an outage and expired interrupted downloads are removed', async () => {
  const f = await fixture();
  try {
    const release = await f.source.latest();
    const path = f.source.file(release.tag, release.filename); assert.ok(path);
    await writeFile(path, Buffer.alloc(release.size));
    const orphan = join(f.directory, 'download-00000000-0000-0000-0000-000000000000.tmp');
    await writeFile(orphan, 'interrupted');
    await utimes(orphan, new Date(0), new Date(0));
    f.github.down = true; f.clock.at += 60_001;
    const restarted = new GitHubTMflashSource(f.directory, f.github.fetch, () => f.clock.at);
    await assert.rejects(restarted.latest());
    assert.equal(restarted.file(release.tag, release.filename), null);
    assert.ok(!(await readdir(f.directory)).includes(orphan.split('/').at(-1) ?? ''));
  } finally { await f.dispose(); }
});

test('download routes serve the checked local bytes as an attachment, support ranges, and accept no uploads or arbitrary paths', async () => {
  const f = await fixture();
  const app = express().use('/api/tmflash-download', createTMflashDownloadRouter(f.source));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const release = await f.source.latest();
    const response = await fetch(base + tmflashDownloadPath(release));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="TMflash-1.5.0-universal.dmg"/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.github.latest?.files[release.filename]);
    const range = await fetch(base + tmflashDownloadPath(release), { headers: { range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 8);
    assert.equal((await fetch(base + '/api/tmflash-download/files/other/other.dmg')).status, 404);
    assert.equal((await fetch(base + '/api/tmflash-download/release', { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.dispose();
  }
});
