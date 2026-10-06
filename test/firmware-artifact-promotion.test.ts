import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FirmwareStore } from '../src/edge/firmware.js';
import type { FirmwareBuildMetadataStorage } from '../src/edge/firmware-build-metadata-store.js';

function addProject(store: FirmwareStore): string {
  const upload = store.startUpload('test');
  store.addFile(upload, 'platformio.ini', Buffer.from('[env:tmflash]\n'));
  store.addFile(upload, 'include/tm_config.h', Buffer.from('#define TM_FW_VERSION "artifact-test"\n'));
  return upload;
}

function usage(activeId?: string) {
  return { isImageInUse: (id: string) => id === activeId };
}

test('promotion stores immutable bytes separately and exposes metadata only after verified promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-artifact-'));
  const store = new FirmwareStore(root);
  const upload = addProject(store);
  const bytes = Buffer.from('firmware image');
  const build = store.completeBuild(upload, 'tester', [], bytes);
  const artifactPath = join(root, 'artifacts', `${build.id}.bin`);
  const metadataPath = join(root, 'builds', `${build.id}.json`);

  assert.deepEqual(store.bytes(build.id), bytes);
  assert.equal(existsSync(artifactPath), true);
  assert.equal(existsSync(metadataPath), true);
  assert.equal(existsSync(join(root, 'builds', build.id)), false);
  assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('failed manifest promotion leaves no ready image and cleanup preserves then removes an orphan safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-artifact-failure-'));
  const future = Date.now() + 60_000;
  const metadata: FirmwareBuildMetadataStorage = {
    load: () => [],
    save: () => { throw new Error('simulated crash before manifest commit'); },
    remove: () => {},
  };
  const store = new FirmwareStore(root, { now: () => future, metadata });
  const upload = addProject(store);
  const bytes = Buffer.from('orphan firmware');
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

  assert.throws(() => store.completeBuild(upload, 'tester', [], bytes), /manifest commit/);
  assert.equal(store.get(id), null);
  assert.equal(store.bytes(id), null);
  const artifactPath = join(root, 'artifacts', `${id}.bin`);
  assert.equal(existsSync(artifactPath), true);
  assert.equal(store.cleanup(usage(id), 0).inUseArtifactsPreserved, 1);
  assert.equal(existsSync(artifactPath), true);
  const cleaned = store.cleanup(usage(), 0);
  assert.equal(cleaned.failedOutputsRemoved, 1);
  assert.equal(cleaned.bytesRemoved, bytes.length);
  assert.equal(existsSync(artifactPath), false);
});

test('restart rejects corrupted images and retention cannot remove an image used by rollout', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-artifact-hash-'));
  const buildTime = Date.now() + 60_000;
  const first = new FirmwareStore(root, { now: () => buildTime });
  const upload = addProject(first);
  const build = first.completeBuild(upload, 'tester', [], Buffer.from('valid image'));
  writeFileSync(join(root, 'artifacts', `${build.id}.bin`), 'corrupt image');
  const reopened = new FirmwareStore(root, { now: () => buildTime + 120_000 });

  assert.equal(reopened.get(build.id)?.state, 'failed');
  assert.equal(reopened.bytes(build.id), null);
  const kept = reopened.cleanup(usage(build.id), 0);
  assert.equal(kept.inUseArtifactsPreserved, 1);
  assert.equal(existsSync(join(root, 'artifacts', `${build.id}.bin`)), true);
  const removed = reopened.cleanup(usage(), 0);
  assert.equal(removed.failedOutputsRemoved, 1);
  assert.equal(reopened.get(build.id), null);
});

test('cleanup discovers abandoned source folders left by a previous process', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-abandoned-upload-'));
  const first = new FirmwareStore(root);
  const upload = addProject(first);
  const sourceDirectory = join(root, 'uploads', upload);
  assert.equal(existsSync(sourceDirectory), true);

  const restarted = new FirmwareStore(root, { now: () => Date.now() + 60_000 });
  const report = restarted.cleanup(usage(), 0);
  assert.equal(report.abandonedSourcesRemoved, 1);
  assert.equal(report.bytesRemoved > 0, true);
  assert.equal(existsSync(sourceDirectory), false);
});

test('image removal checks the authoritative use query at the storage boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmedge-artifact-delete-'));
  const store = new FirmwareStore(root);
  const build = store.completeBuild(addProject(store), 'tester', [], Buffer.from('rollout image'));

  assert.equal(store.remove(build.id, usage(build.id)), false);
  assert.ok(store.bytes(build.id));
  assert.equal(store.remove(build.id, usage()), true);
  assert.equal(store.get(build.id), null);
});
