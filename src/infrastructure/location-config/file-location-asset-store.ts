import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { syncDirectory, syncFileHandle } from '../../shared/directory-sync.js';
import type { LocationAssetMetadata, LocationAssetPurpose } from '../../modules/location-config/domain/location-records.js';
import { LocationStorageUnavailableError } from '../../modules/location-config/domain/location-records.js';
import type { LocationAssetMetadataRepository, LocationAssetStore } from '../../modules/location-config/repositories/location-storage.js';

export interface FileLocationAssetStoreOptions {
  maxImageBytes?: number;
  maxModelBytes?: number;
  now?: () => number;
  uuid?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_IMAGE_LIMIT = 20 * 1024 * 1024;
export const DEFAULT_MODEL_LIMIT = 128 * 1024 * 1024;

/** Immutable owner-scoped bytes and metadata beneath the persistent edge data directory. */
export class FileLocationAssetStore implements LocationAssetStore, LocationAssetMetadataRepository {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly maxImageBytes: number;
  private readonly maxModelBytes: number;

  constructor(private readonly root: string, options: FileLocationAssetStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;
    this.maxModelBytes = options.maxModelBytes ?? DEFAULT_MODEL_LIMIT;
    if (!Number.isSafeInteger(this.maxImageBytes) || this.maxImageBytes < 1 || !Number.isSafeInteger(this.maxModelBytes) || this.maxModelBytes < 1) {
      throw new RangeError('Asset limits must be positive safe integers.');
    }
  }

  async put(creatorId: string, purpose: LocationAssetPurpose, declaredMediaType: string, bytes: Uint8Array, createdAt = this.now()): Promise<LocationAssetMetadata> {
    validateCreator(creatorId);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Asset bytes must be a byte array.');
    const mediaType = validateAsset(purpose, declaredMediaType, bytes, this.maxImageBytes, this.maxModelBytes);
    const assetId = this.uuid().toLowerCase();
    if (!UUID_RE.test(assetId)) throw new Error('Asset ID generator returned an invalid UUID.');
    const metadata: LocationAssetMetadata = {
      assetId, creatorId, purpose, mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      createdAt: validTimestamp(createdAt),
    };
    const directory = ownerDirectory(this.root, creatorId);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(join(this.root, 'location-assets'));
      await assertPrivateDirectory(directory);
      const bytesPath = join(directory, `${assetId}.bin`);
      const metadataPath = join(directory, `${assetId}.json`);
      const bytesTemporary = join(directory, `.${assetId}.${randomUUID()}.bin.tmp`);
      let bytesLinked = false;
      try {
        await writeFile(bytesTemporary, bytes, { mode: 0o600, flag: 'wx' });
        const handle = await open(bytesTemporary, 'r+');
        try { await syncFileHandle(handle); } finally { await handle.close(); }
        await link(bytesTemporary, bytesPath);
        bytesLinked = true;
        await unlink(bytesTemporary);
        syncDirectory(directory);
        await writeAtomicJson(metadataPath, metadata);
      } catch (error) {
        try { await unlink(bytesTemporary); } catch { /* temp file may already be linked and removed */ }
        if (bytesLinked) {
          try {
            await unlink(bytesPath);
            syncDirectory(directory);
          } catch { /* Preserve the original storage failure. */ }
        }
        throw error;
      }
    } catch (error) {
      throw safeStorageError(error);
    }
    return metadata;
  }

  async read(creatorId: string, assetId: string): Promise<{ metadata: LocationAssetMetadata; bytes: Buffer } | null> {
    validateCreator(creatorId);
    if (!UUID_RE.test(assetId)) return null;
    const directory = ownerDirectory(this.root, creatorId);
    try {
      if (!(await assertPrivateDirectoryIfPresent(join(this.root, 'location-assets')))
        || !(await assertPrivateDirectoryIfPresent(directory))) return null;
      const metadata = await readMetadata(join(directory, `${assetId.toLowerCase()}.json`), this.maxImageBytes, this.maxModelBytes);
      if (!metadata || metadata.creatorId !== creatorId || metadata.assetId !== assetId.toLowerCase()) return null;
      const bytesPath = join(directory, `${metadata.assetId}.bin`);
      try {
        const fileInfo = await lstat(bytesPath);
        validatePrivateFile(fileInfo);
        if (fileInfo.size !== metadata.byteLength) throw new Error('Stored asset length does not match its metadata.');
        const bytes = await readFile(bytesPath);
        if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('Stored asset digest does not match its metadata.');
        validateAsset(metadata.purpose, metadata.mediaType, bytes, this.maxImageBytes, this.maxModelBytes);
        return { metadata, bytes };
      } catch (error) {
        if (isNotFound(error)) throw new Error('Stored asset bytes are missing.');
        throw error;
      }
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  async saveAssetMetadata(metadata: LocationAssetMetadata): Promise<void> {
    validateMetadata(metadata, this.maxImageBytes, this.maxModelBytes);
    const directory = ownerDirectory(this.root, metadata.creatorId);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(join(this.root, 'location-assets'));
      await assertPrivateDirectory(directory);
      const path = join(directory, `${metadata.assetId}.json`);
      await writeAtomicJson(path, metadata);
    } catch (error) { throw safeStorageError(error); }
  }

  async getAssetMetadata(creatorId: string, assetId: string): Promise<LocationAssetMetadata | null> {
    validateCreator(creatorId);
    if (!UUID_RE.test(assetId)) return null;
    try {
      const directory = ownerDirectory(this.root, creatorId);
      if (!(await assertPrivateDirectoryIfPresent(join(this.root, 'location-assets')))
        || !(await assertPrivateDirectoryIfPresent(directory))) return null;
      const metadata = await readMetadata(join(directory, `${assetId.toLowerCase()}.json`), this.maxImageBytes, this.maxModelBytes);
      return metadata?.creatorId === creatorId && metadata.assetId === assetId.toLowerCase() ? metadata : null;
    } catch (error) { throw safeStorageError(error); }
  }
}

export function validateAsset(
  purpose: LocationAssetPurpose,
  declaredMediaType: string,
  bytes: Uint8Array,
  maxImageBytes = DEFAULT_IMAGE_LIMIT,
  maxModelBytes = DEFAULT_MODEL_LIMIT,
): 'image/png' | 'image/jpeg' | 'model/gltf-binary' {
  if (purpose !== 'floor-plan' && purpose !== 'model') throw new TypeError('Invalid asset purpose.');
  if (bytes.byteLength === 0) throw new TypeError('Asset must not be empty.');
  if (purpose === 'floor-plan') {
    if (bytes.byteLength > maxImageBytes) throw new RangeError('Floor plan exceeds the configured image limit.');
    const png = declaredMediaType === 'image/png' && bytes.byteLength >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    const jpeg = declaredMediaType === 'image/jpeg' && bytes.byteLength >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new TypeError('Floor plan media type does not match its PNG or JPEG signature.');
    return declaredMediaType as 'image/png' | 'image/jpeg';
  }
  if (declaredMediaType !== 'model/gltf-binary') throw new TypeError('GLB assets must declare model/gltf-binary.');
  if (bytes.byteLength > maxModelBytes) throw new RangeError('GLB exceeds the configured model limit.');
  validateGlb(bytes);
  return 'model/gltf-binary';
}

function validateGlb(bytes: Uint8Array): void {
  if (bytes.byteLength < 20) throw new TypeError('GLB is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new TypeError('GLB header is invalid.');
  }
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let seenBinary = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new TypeError('GLB chunk header is truncated.');
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || length < 4 || offset + length > bytes.byteLength) throw new TypeError('GLB chunk length is invalid.');
    if (kind === 0x4e4f534a) {
      if (json !== null || offset !== 20) throw new TypeError('GLB must contain one JSON chunk first.');
      let parsed: unknown;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)).replace(/[\u0000 ]+$/g, '');
        parsed = JSON.parse(text);
      } catch {
        throw new TypeError('GLB JSON chunk is invalid.');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('GLB JSON root must be an object.');
      json = parsed as Record<string, unknown>;
    } else if (kind === 0x004e4942) {
      if (json === null || seenBinary) throw new TypeError('GLB binary chunk is misplaced or duplicated.');
      seenBinary = true;
    }
    offset += length;
  }
  if (offset !== bytes.byteLength || json === null) throw new TypeError('GLB must contain a complete JSON chunk.');
  const asset = json.asset;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || (asset as { version?: unknown }).version !== '2.0') {
    throw new TypeError('GLB must be a glTF 2.0 asset.');
  }
  rejectExternalUris(json);
}

function rejectExternalUris(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectExternalUris(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'uri' && typeof item === 'string' && !item.startsWith('data:')) throw new TypeError('GLB external resource URIs are not allowed.');
    rejectExternalUris(item);
  }
}

function ownerDirectory(root: string, creatorId: string): string {
  const ownerHash = createHash('sha256').update(creatorId).digest('hex');
  return join(root, 'location-assets', ownerHash);
}
function validateCreator(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new TypeError('Creator ID is invalid.');
}
function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Timestamp is invalid.');
  return value;
}
function validateMetadata(value: LocationAssetMetadata, maxImageBytes = DEFAULT_IMAGE_LIMIT, maxModelBytes = DEFAULT_MODEL_LIMIT): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['assetId', 'creatorId', 'purpose', 'mediaType', 'sha256', 'byteLength', 'createdAt'].includes(key))) {
    throw new TypeError('Asset metadata is invalid.');
  }
  if (!value || typeof value !== 'object' || !UUID_RE.test(value.assetId) || typeof value.creatorId !== 'string'
    || value.creatorId.trim() === '' || value.creatorId.length > 256
    || (value.purpose !== 'floor-plan' && value.purpose !== 'model') || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1
    || (value.purpose === 'floor-plan' && value.byteLength > maxImageBytes)
    || (value.purpose === 'model' && value.byteLength > maxModelBytes)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new TypeError('Asset metadata is invalid.');
  }
  if ((value.purpose === 'model' && value.mediaType !== 'model/gltf-binary')
    || (value.purpose === 'floor-plan' && value.mediaType !== 'image/png' && value.mediaType !== 'image/jpeg')) {
    throw new TypeError('Asset media type does not match its purpose.');
  }
}
async function readMetadata(path: string, maxImageBytes: number, maxModelBytes: number): Promise<LocationAssetMetadata | null> {
  try {
    const fileInfo = await lstat(path);
    validatePrivateFile(fileInfo);
    if (fileInfo.size > 4096) throw new Error('Stored asset metadata is invalid.');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored asset metadata is invalid.');
    validateMetadata(parsed as LocationAssetMetadata, maxImageBytes, maxModelBytes);
    return parsed as LocationAssetMetadata;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let linked = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    const handle = await open(temporary, 'r+');
    try { await syncFileHandle(handle); } finally { await handle.close(); }
    await link(temporary, path);
    linked = true;
    syncDirectory(directory);
  } catch (error) {
    if (linked) {
      try {
        await unlink(path);
        syncDirectory(directory);
      } catch { /* Preserve the original storage failure. */ }
    }
    throw error;
  } finally {
    try { await unlink(temporary); } catch { /* preserve the write or link error */ }
  }
}
async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Asset storage directory is not private.');
  }
}
async function assertPrivateDirectoryIfPresent(path: string): Promise<boolean> {
  try { await assertPrivateDirectory(path); return true; }
  catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
function validatePrivateFile(info: Awaited<ReturnType<typeof lstat>>): void {
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0)) {
    throw new Error('Stored asset file is not private.');
  }
}
function safeStorageError(error: unknown): Error {
  return error instanceof TypeError || error instanceof RangeError || error instanceof LocationStorageUnavailableError
    ? error : new LocationStorageUnavailableError();
}
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'; }
