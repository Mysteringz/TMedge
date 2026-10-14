import { createHash } from 'node:crypto';
import type { LocationDocument } from '../../modules/location-config/domain/location-document.js';
import { furnitureAssetReferences } from '../../modules/location-config/domain/furniture-assets.js';
import type { LocationDraft, PublishedLocationRevision } from '../../modules/location-config/domain/location-records.js';
import type { FurnitureLibraryStore, LocationAssetStore, PublishedModelDistributionRequest, PublishedModelDistributor } from '../../modules/location-config/repositories/location-storage.js';
import { DEFAULT_MODEL_LIMIT, validateAsset } from './file-location-asset-store.js';

const ACK_LIMIT_BYTES = 4096;
const SHA256_RE = /^[0-9a-f]{64}$/;

interface AssetRequest {
  assetId: string;
  purpose: 'model' | 'furniture';
  furnitureType?: 'table' | 'chair';
  ownerId?: string;
}

interface AssetReceipt {
  assetId: string;
  sha256: string;
  byteLength: number;
}

interface ResolvedAsset extends AssetReceipt {
  bytes: Buffer;
}

/** Transfers every referenced immutable GLB to all web tiers before a public revision commits. */
export class HttpPublishedModelDistributor implements PublishedModelDistributor {
  constructor(
    private readonly targets: readonly string[],
    private readonly pushToken: string,
    private readonly edgeId: string,
    private readonly assets: LocationAssetStore & Pick<FurnitureLibraryStore, 'readFurnitureItem'>,
    private readonly timeoutMs = 120_000,
  ) {}

  async acknowledge(request: PublishedModelDistributionRequest): Promise<void> {
    const { candidate } = request;
    if (candidate.document.visibility !== 'public') throw new TypeError('Only public GLB assets can be distributed.');
    if (!this.targets.length || this.pushToken.length < 16) throw new Error('No authenticated student web asset target is configured.');

    const expectedAssets = collectAssets(candidate);
    if (!expectedAssets.length) throw new TypeError('The public candidate contains no uploaded GLB assets to distribute.');

    // First pass validates every referenced byte set before any receiver is contacted. Keep
    // only small receipts so a location with many large GLBs does not retain them all.
    const receipts: AssetReceipt[] = [];
    for (const request of expectedAssets) {
      const { assetId, sha256, byteLength } = await this.resolveAsset(request);
      receipts.push({ assetId, sha256, byteLength });
    }

    // Re-read one immutable asset at a time for delivery. This bounds live GLB memory to
    // one asset, rechecks the preflight receipt, and bounds transfer concurrency to one.
    for (let index = 0; index < expectedAssets.length; index++) {
      const asset = await this.resolveAsset(expectedAssets[index]!);
      const receipt = receipts[index]!;
      if (asset.assetId !== receipt.assetId || asset.sha256 !== receipt.sha256 || asset.byteLength !== receipt.byteLength) {
        throw new Error('A referenced public GLB asset changed after complete-set validation.');
      }
      for (const target of this.targets) await this.transfer(target, candidate.locationId, asset);
    }
  }

  private async resolveAsset(request: AssetRequest): Promise<ResolvedAsset> {
    const stored = request.purpose === 'model'
      ? await this.assets.read(request.ownerId!, request.assetId)
      : await this.assets.readFurnitureItem(request.assetId);
    if (!stored) throw new Error('A referenced public GLB asset is unavailable.');
    const { metadata, bytes } = stored;
    if (metadata.assetId !== request.assetId || metadata.purpose !== request.purpose
      || metadata.mediaType !== 'model/gltf-binary' || !Number.isSafeInteger(metadata.byteLength)
      || metadata.byteLength < 1 || metadata.byteLength > DEFAULT_MODEL_LIMIT || bytes.byteLength !== metadata.byteLength
      || !SHA256_RE.test(metadata.sha256) || sha256(bytes) !== metadata.sha256) {
      throw new Error('A referenced public GLB asset is inconsistent with its immutable metadata.');
    }
    if (request.purpose === 'model' && metadata.creatorId !== request.ownerId) {
      throw new Error('A referenced uploaded room model does not match its existing owner provenance.');
    }
    if (request.purpose === 'furniture' && (!('furnitureType' in metadata) || metadata.furnitureType !== request.furnitureType)) {
      throw new Error('A referenced furniture asset does not match its immutable slot type.');
    }
    validateAsset(request.purpose, metadata.mediaType, bytes, undefined, DEFAULT_MODEL_LIMIT);
    return { assetId: request.assetId, sha256: metadata.sha256, byteLength: bytes.byteLength, bytes };
  }

  private async transfer(target: string, locationId: string, asset: ResolvedAsset): Promise<void> {
    const url = new URL(`/api/edge/location-assets/${encodeURIComponent(locationId)}/${encodeURIComponent(asset.assetId)}`, target);
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.pushToken}`,
        'content-type': 'model/gltf-binary',
        'content-length': String(asset.bytes.byteLength),
        'x-tm-edge-id': this.edgeId,
        'x-tm-sha256': asset.sha256,
      },
      body: asset.bytes,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Student web target rejected GLB asset transfer (${response.status}).`);
    }
    const body = await readSmallResponse(response);
    let acknowledgement: unknown;
    try { acknowledgement = JSON.parse(body.toString('utf8')) as unknown; }
    catch { throw new Error('Student web target returned an invalid GLB asset acknowledgement.'); }
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)
      || Object.keys(acknowledgement).sort().join(',') !== 'assetId,ok,sha256'
      || (acknowledgement as { ok?: unknown }).ok !== true
      || (acknowledgement as { assetId?: unknown }).assetId !== asset.assetId
      || (acknowledgement as { sha256?: unknown }).sha256 !== asset.sha256) {
      throw new Error('Student web target did not confirm the exact GLB asset bytes.');
    }
  }
}

function collectAssets(candidate: PublishedLocationRevision): AssetRequest[] {
  const byId = new Map<string, AssetRequest>();
  const add = (asset: AssetRequest) => {
    const existing = byId.get(asset.assetId);
    if (existing && (existing.purpose !== asset.purpose || existing.furnitureType !== asset.furnitureType
      || existing.ownerId !== asset.ownerId)) {
      throw new TypeError('One asset ID cannot refer to different purposes, furniture types, or model owners.');
    }
    if (!existing) byId.set(asset.assetId, asset);
  };

  const modelAssetId = candidate.document.modelAssetId;
  if (modelAssetId) {
    const provenance = candidate.assetProvenance?.modelAssetId;
    if (provenance?.kind === 'upload') add({ assetId: modelAssetId, purpose: 'model', ownerId: provenance.ownerId });
    else if (provenance?.kind !== 'legacy-static') throw new TypeError('The uploaded room model has no trusted owner provenance.');
  }
  for (const reference of furnitureAssetReferences(candidate.document as LocationDocument)) {
    add({ assetId: reference.assetId, purpose: 'furniture', furnitureType: reference.furnitureType });
  }
  return [...byId.values()];
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function readSmallResponse(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > ACK_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error('Student web GLB asset acknowledgement is too large.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ACK_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error('Student web GLB asset acknowledgement is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}
