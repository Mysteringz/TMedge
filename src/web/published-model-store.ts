import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory, syncFileHandle } from '../shared/directory-sync.js';
import { validateAsset } from '../infrastructure/location-config/file-location-asset-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_MODEL_BYTES = 128 * 1024 * 1024;

export class ImmutablePublishedModelConflictError extends Error {
  constructor() { super('The immutable model ID already contains different bytes.'); this.name = 'ImmutablePublishedModelConflictError'; }
}

/** Persistent web-tier bytes. The caller must authorize each read against the current snapshot. */
export class FilePublishedModelStore {
  private initialization: Promise<void> | null = null;

  constructor(private readonly directory: string) {}

  /** Completes the one-time legacy inventory before any web request or store operation proceeds. */
  ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  async put(assetId: string, expectedSha256: string, bytes: Uint8Array): Promise<'stored' | 'already-present'> {
    await this.ensureInitialized();
    if (!UUID_RE.test(assetId) || !SHA256_RE.test(expectedSha256) || !(bytes instanceof Uint8Array)
      || bytes.byteLength === 0 || bytes.byteLength > MAX_MODEL_BYTES) throw new TypeError('Published model metadata is invalid.');
    validateAsset('model', 'model/gltf-binary', bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256) throw new TypeError('Published model digest does not match its bytes.');

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
    const path = join(this.directory, `${assetId.toLowerCase()}.glb`);
    const digestPath = join(this.directory, `${assetId.toLowerCase()}.meta`);
    const temporary = join(this.directory, `.${assetId.toLowerCase()}.${randomUUID()}.tmp`);
    let linked = false;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      const handle = await open(temporary, 'r+');
      try { await syncFileHandle(handle); } finally { await handle.close(); }
      try {
        await link(temporary, path);
        linked = true;
        syncDirectory(this.directory);
        await writeExpectedMetadata(digestPath, digest, bytes.byteLength, this.directory);
        return 'stored';
      } catch (error) {
        if (!isExists(error)) throw error;
        const existing = await readImmutable(path);
        if (existing.byteLength !== bytes.byteLength || createHash('sha256').update(existing).digest('hex') !== digest) {
          throw new ImmutablePublishedModelConflictError();
        }
        const existingMetadata = await readExpectedMetadata(digestPath);
        if (existingMetadata !== null && (existingMetadata.sha256 !== digest || existingMetadata.byteLength !== bytes.byteLength)) {
          throw new ImmutablePublishedModelConflictError();
        }
        if (existingMetadata === null) await writeExpectedMetadata(digestPath, digest, bytes.byteLength, this.directory);
        return 'already-present';
      }
    } catch (error) {
      if (linked) {
        try { await unlink(path); syncDirectory(this.directory); } catch { /* fail closed; retain the original write error */ }
      }
      throw error;
    } finally {
      try { await unlink(temporary); } catch { /* temporary may already be absent */ }
    }
  }

  async read(assetId: string): Promise<{ bytes: Buffer; sha256: string } | null> {
    await this.ensureInitialized();
    if (!UUID_RE.test(assetId)) return null;
    try { await assertPrivateDirectory(this.directory); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
    let bytes: Buffer;
    try { bytes = await readImmutable(join(this.directory, `${assetId.toLowerCase()}.glb`)); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
    validateAsset('model', 'model/gltf-binary', bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const expectedMetadata = await readExpectedMetadata(join(this.directory, `${assetId.toLowerCase()}.meta`));
    if (expectedMetadata === null || expectedMetadata.sha256 !== digest || expectedMetadata.byteLength !== bytes.byteLength) {
      throw new Error('Published model bytes do not match their durable metadata.');
    }
    return { bytes, sha256: expectedMetadata.sha256 };
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
    const marker = join(this.directory, '.integrity-baseline-v1');
    const existingMarker = await readBaselineMarker(marker);
    if (existingMarker) return;
    const release = await acquireBaselineLock(this.directory, marker);
    if (!release) return;
    try {
      // Recheck under the cross-process claim; another instance may have finished while we waited.
      if (await readBaselineMarker(marker)) return;
      for (const name of await readdir(this.directory)) {
        if (!name.toLowerCase().endsWith('.glb')) continue;
        const assetId = name.slice(0, -4);
        if (!UUID_RE.test(assetId) || name !== `${assetId.toLowerCase()}.glb`) {
          throw new Error('Published model inventory contains an invalid asset filename.');
        }
        const bytes = await readImmutable(join(this.directory, name));
        validateAsset('model', 'model/gltf-binary', bytes);
        const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength };
        const receiptPath = join(this.directory, `${assetId}.meta`);
        const receipt = await readExpectedMetadata(receiptPath);
        if (receipt && (receipt.sha256 !== expected.sha256 || receipt.byteLength !== expected.byteLength)) {
          throw new Error('Published model bytes do not match their durable metadata.');
        }
        if (!receipt) await writeExpectedMetadata(receiptPath, expected.sha256, expected.byteLength, this.directory);
      }
      await writeBaselineMarker(marker, this.directory);
    } finally { await release(); }
  }
}

async function writeExpectedMetadata(path: string, digest: string, byteLength: number, directory: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.meta.tmp`);
  let linked = false;
  try {
    await writeFile(temporary, JSON.stringify({ sha256: digest, byteLength }), { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r+');
    try { await syncFileHandle(handle); } finally { await handle.close(); }
    try {
      await link(temporary, path);
      linked = true;
      syncDirectory(directory);
    } catch (error) {
      if (!isExists(error)) throw error;
      const existing = await readExpectedMetadata(path);
      if (existing?.sha256 !== digest || existing.byteLength !== byteLength) throw new ImmutablePublishedModelConflictError();
    }
  } catch (error) {
    if (linked) {
      try { await unlink(path); syncDirectory(directory); } catch { /* Preserve the original durability error. */ }
    }
    throw error;
  } finally {
    try { await unlink(temporary); } catch { /* temporary may already be absent */ }
  }
}

async function readExpectedMetadata(path: string): Promise<{ sha256: string; byteLength: number } | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (isNotFound(error)) return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)
    || info.size > 256) throw new Error('Published model metadata is unavailable.');
  let value: unknown;
  try { value = JSON.parse((await readFile(path)).toString('utf8')) as unknown; }
  catch { throw new Error('Published model metadata is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'byteLength,sha256'
    || !('sha256' in value) || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || !('byteLength' in value) || typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1 || value.byteLength > MAX_MODEL_BYTES) throw new Error('Published model metadata is invalid.');
  return { sha256: value.sha256, byteLength: value.byteLength };
}

async function readBaselineMarker(path: string): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (isNotFound(error)) return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)
    || info.size > 64) throw new Error('Published model integrity baseline marker is invalid.');
  let value: unknown;
  try { value = JSON.parse((await readFile(path)).toString('utf8')) as unknown; }
  catch { throw new Error('Published model integrity baseline marker is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'schemaVersion' || !('schemaVersion' in value) || value.schemaVersion !== 1) {
    throw new Error('Published model integrity baseline marker is invalid.');
  }
  return true;
}

async function writeBaselineMarker(path: string, directory: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.baseline.tmp`);
  let linked = false;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1 }), { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r+');
    try { await syncFileHandle(handle); } finally { await handle.close(); }
    try {
      await link(temporary, path);
      linked = true;
      syncDirectory(directory);
    } catch (error) {
      if (!isExists(error)) throw error;
      if (!(await readBaselineMarker(path))) throw new Error('Published model integrity baseline marker is missing.');
    }
  } catch (error) {
    if (linked) {
      try { await unlink(path); syncDirectory(directory); } catch { /* Preserve the original durability error. */ }
    }
    throw error;
  } finally {
    try { await unlink(temporary); } catch { /* temporary may already be absent */ }
  }
}

async function acquireBaselineLock(directory: string, marker: string): Promise<(() => Promise<void>) | null> {
  const lockPath = join(directory, '.integrity-baseline-v1.lock');
  const content = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const deadline = Date.now() + 120_000;
  while (true) {
    const temporary = join(directory, `.${randomUUID()}.lock.tmp`);
    let createdLock = false;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      const handle = await open(temporary, 'r+');
      try {
        await syncFileHandle(handle);
      } finally { await handle.close(); }
      try { await link(temporary, lockPath); createdLock = true; }
      catch (error) { if (!isExists(error)) throw error; }
      if (createdLock) {
        syncDirectory(directory);
        return async () => {
          try {
            const current = await readFile(lockPath, 'utf8');
            if (current === content) {
              await unlink(lockPath);
              syncDirectory(directory);
            }
          } catch (error) { if (!isNotFound(error)) throw error; }
        };
      }
    } catch (error) {
      if (createdLock) {
        try { if (await readFile(lockPath, 'utf8') === content) { await unlink(lockPath); syncDirectory(directory); } }
        catch (cleanupError) { if (!isNotFound(cleanupError)) { /* keep the original startup failure */ } }
      }
      if (!isExists(error)) throw error;
    } finally {
      try { await unlink(temporary); } catch { /* temporary may already be absent */ }
    }
    if (await readBaselineMarker(marker)) return null;
    let lock: { pid: number; content: string };
    try { lock = await readBaselineLock(lockPath); }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    if (!isProcessRunning(lock.pid)) {
      // A different initializer may have replaced the stale path after our first read.
      // Re-read the exact owner token immediately before reclaiming it; PID liveness is
      // conservative (including PID reuse) and an unknown/live owner is never removed.
      try {
        const current = await readBaselineLock(lockPath);
        if (current.content !== lock.content || isProcessRunning(current.pid)) continue;
        if (await readFile(lockPath, 'utf8') !== lock.content || isProcessRunning(current.pid)) continue;
        await unlink(lockPath);
        syncDirectory(directory);
      } catch (removeError) { if (!isNotFound(removeError)) throw removeError; }
      continue;
    }
    if (Date.now() >= deadline) throw new Error('Another web instance has not completed the published model integrity baseline.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readBaselineLock(path: string): Promise<{ pid: number; content: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)
    || info.size > 256) throw new Error('Published model integrity baseline lock is invalid.');
  let value: unknown;
  let content: string;
  try { content = (await readFile(path)).toString('utf8'); value = JSON.parse(content) as unknown; }
  catch { throw new Error('Published model integrity baseline lock is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'nonce,pid' || !('pid' in value) || !('nonce' in value)
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.nonce !== 'string' || !UUID_RE.test(value.nonce)) {
    throw new Error('Published model integrity baseline lock is invalid.');
  }
  return { pid: value.pid, content };
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code !== 'ESRCH'; }
}

async function readImmutable(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)
    || info.size < 1 || info.size > MAX_MODEL_BYTES) throw new Error('Published model is unavailable.');
  return readFile(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)) {
    throw new Error('Published model directory is unavailable.');
  }
}

function isExists(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'; }
function isNotFound(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'; }
