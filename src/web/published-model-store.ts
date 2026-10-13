import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
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
  constructor(private readonly directory: string) {}

  async put(assetId: string, expectedSha256: string, bytes: Uint8Array): Promise<'stored' | 'already-present'> {
    if (!UUID_RE.test(assetId) || !SHA256_RE.test(expectedSha256) || !(bytes instanceof Uint8Array)
      || bytes.byteLength === 0 || bytes.byteLength > MAX_MODEL_BYTES) throw new TypeError('Published model metadata is invalid.');
    validateAsset('model', 'model/gltf-binary', bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256) throw new TypeError('Published model digest does not match its bytes.');

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
    const path = join(this.directory, `${assetId.toLowerCase()}.glb`);
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
        return 'stored';
      } catch (error) {
        if (!isExists(error)) throw error;
        const existing = await readImmutable(path);
        if (existing.byteLength !== bytes.byteLength || createHash('sha256').update(existing).digest('hex') !== digest) {
          throw new ImmutablePublishedModelConflictError();
        }
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
    if (!UUID_RE.test(assetId)) return null;
    try { await assertPrivateDirectory(this.directory); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
    let bytes: Buffer;
    try { bytes = await readImmutable(join(this.directory, `${assetId.toLowerCase()}.glb`)); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
    validateAsset('model', 'model/gltf-binary', bytes);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
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
