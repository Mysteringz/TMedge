import { createHash } from 'node:crypto';
import type { LocationDraft, PublishedLocationRevision } from '../../modules/location-config/domain/location-records.js';
import type { LocationAssetStore, PublishedModelDistributor } from '../../modules/location-config/repositories/location-storage.js';

const ACK_LIMIT_BYTES = 4096;

/** Transfers an immutable GLB to every configured web tier before a public revision commits. */
export class HttpPublishedModelDistributor implements PublishedModelDistributor {
  constructor(
    private readonly targets: readonly string[],
    private readonly pushToken: string,
    private readonly edgeId: string,
    private readonly assets: LocationAssetStore,
    private readonly timeoutMs = 120_000,
  ) {}

  async acknowledge(request: { draft: LocationDraft; candidate: PublishedLocationRevision }): Promise<void> {
    const { candidate } = request;
    const assetId = candidate.document.modelAssetId;
    const provenance = candidate.assetProvenance?.modelAssetId;
    if (candidate.document.visibility !== 'public' || !assetId || provenance?.kind !== 'upload') {
      throw new TypeError('Only public uploaded models can be distributed.');
    }
    if (!this.targets.length || this.pushToken.length < 16) throw new Error('No authenticated student web model target is configured.');
    const asset = await this.assets.read(provenance.ownerId, assetId);
    if (!asset || asset.metadata.purpose !== 'model' || asset.metadata.assetId !== assetId
      || asset.metadata.creatorId !== provenance.ownerId || asset.metadata.sha256 !== sha256(asset.bytes)) {
      throw new Error('The published model bytes are unavailable or inconsistent.');
    }

    const results = await Promise.allSettled(this.targets.map(async (target) => {
      const url = new URL(`/api/edge/location-assets/${encodeURIComponent(candidate.locationId)}/${encodeURIComponent(assetId)}`, target);
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.pushToken}`,
          'content-type': 'model/gltf-binary',
          'content-length': String(asset.bytes.byteLength),
          'x-tm-edge-id': this.edgeId,
          'x-tm-sha256': asset.metadata.sha256,
        },
        body: asset.bytes,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Student web target rejected model transfer (${response.status}).`);
      }
      const body = await readSmallResponse(response);
      let acknowledgement: unknown;
      try { acknowledgement = JSON.parse(body.toString('utf8')) as unknown; }
      catch { throw new Error('Student web target returned an invalid model acknowledgement.'); }
      if (!acknowledgement || typeof acknowledgement !== 'object'
        || (acknowledgement as { ok?: unknown }).ok !== true
        || (acknowledgement as { assetId?: unknown }).assetId !== assetId
        || (acknowledgement as { sha256?: unknown }).sha256 !== asset.metadata.sha256) {
        throw new Error('Student web target did not confirm the exact model bytes.');
      }
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error('Student web model transfer failed.');
  }
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function readSmallResponse(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > ACK_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error('Student web model acknowledgement is too large.');
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
        throw new Error('Student web model acknowledgement is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}
