import type { LocationAssetMetadata } from '../domain/location-records.js';
import type { LocationDocument, TrustedLegacyLocationBaseline } from '../domain/location-document.js';
import {
  InvalidLocationAssetReferenceError, locationAssetReferences, parseLocationAssetProvenance, sameLocationAssetProvenance,
  type LocationAssetProvenance,
} from '../domain/location-assets.js';
import type { LocationAssetMetadataRepository } from '../repositories/location-storage.js';

export interface LocationAssetBaseRevision {
  revision: number;
  document: LocationDocument | TrustedLegacyLocationBaseline;
  assetProvenance?: LocationAssetProvenance;
}

/** Derives exact slot provenance from the pinned base or the current creator's own upload metadata. */
export async function resolveLocationAssetProvenance(
  creatorId: string,
  document: LocationDocument,
  base: LocationAssetBaseRevision | null,
  metadata: LocationAssetMetadataRepository | undefined,
): Promise<LocationAssetProvenance> {
  const inherited = base ? parseLocationAssetProvenance(base.assetProvenance, base.document) : {};
  if (inherited.modelAssetId?.kind === 'legacy-static' && document.modelAssetId === undefined
    && document.proceduralRoom === undefined) {
    throw new InvalidLocationAssetReferenceError('A legacy static model must be retained unchanged or replaced with an uploaded GLB.');
  }
  const result: LocationAssetProvenance = {};
  for (const reference of locationAssetReferences(document)) {
    if (base?.document[reference.slot] === reference.assetId) {
      const provenance = inherited[reference.slot];
      if (!provenance) throw new InvalidLocationAssetReferenceError();
      if (provenance.kind === 'legacy-static') {
        if (reference.slot !== 'modelAssetId' || provenance.basePublishedRevision !== 0
          || provenance.locationId !== document.locationId || provenance.assetId !== reference.assetId
          || !sameJson(document.modelTransform, base.document.modelTransform)) {
          throw new InvalidLocationAssetReferenceError();
        }
        result[reference.slot] = { ...provenance };
        continue;
      }
      const ownerMetadata = await metadata?.getAssetMetadata(provenance.ownerId, reference.assetId);
      if (!samePurpose(ownerMetadata, reference, provenance.ownerId)) throw new InvalidLocationAssetReferenceError();
      result[reference.slot] = { kind: 'upload', ownerId: provenance.ownerId };
      continue;
    }
    const ownMetadata = await metadata?.getAssetMetadata(creatorId, reference.assetId);
    if (!samePurpose(ownMetadata, reference, creatorId)) throw new InvalidLocationAssetReferenceError();
    result[reference.slot] = { kind: 'upload', ownerId: creatorId };
  }
  return result;
}

function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function sameResolvedLocationAssetProvenance(a: unknown, b: unknown): boolean {
  return sameLocationAssetProvenance(a, b);
}

function samePurpose(
  metadata: LocationAssetMetadata | null | undefined,
  reference: ReturnType<typeof locationAssetReferences>[number],
  ownerId: string,
): boolean {
  return !!metadata && metadata.assetId === reference.assetId && metadata.creatorId === ownerId && metadata.purpose === reference.purpose;
}
