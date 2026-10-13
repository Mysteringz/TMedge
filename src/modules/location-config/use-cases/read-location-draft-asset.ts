import { InvalidLocationAssetReferenceError, locationAssetReferences } from '../domain/location-assets.js';
import { LocationDraftNotFoundError } from '../domain/location-records.js';
import type { LocationAssetMetadataRepository, LocationAssetStore, LocationDraftRepository, PublishedLocationRepository } from '../repositories/location-storage.js';
import { resolveLocationAssetProvenance, sameResolvedLocationAssetProvenance } from './resolve-location-asset-provenance.js';

export class ReadLocationDraftAssetUseCase {
  constructor(private readonly dependencies: {
    drafts: LocationDraftRepository;
    published: PublishedLocationRepository;
    metadata: LocationAssetMetadataRepository;
    assets: LocationAssetStore;
  }) {}

  async execute(input: { creatorId: string; draftId: string; assetId: string }) {
    const draft = await this.dependencies.drafts.getDraft(input.creatorId, input.draftId);
    if (!draft) throw new LocationDraftNotFoundError();
    const reference = locationAssetReferences(draft.document).find((item) => item.assetId === input.assetId);
    if (!reference) throw new InvalidLocationAssetReferenceError();
    const state = await this.dependencies.published.getActive(draft.locationId);
    const base = draft.basePublishedRevision === null ? null
      : state?.history.find((item) => item.revision === draft.basePublishedRevision) ?? null;
    if (draft.basePublishedRevision !== null && !base) throw new InvalidLocationAssetReferenceError();
    const provenance = await resolveLocationAssetProvenance(input.creatorId, draft.document, base ? {
      revision: base.revision, document: base.document, assetProvenance: base.assetProvenance,
    } : null, this.dependencies.metadata);
    if (!sameResolvedLocationAssetProvenance(provenance, draft.assetProvenance)) throw new InvalidLocationAssetReferenceError();
    const entry = provenance[reference.slot];
    if (!entry || entry.kind !== 'upload') throw new InvalidLocationAssetReferenceError();
    const stored = await this.dependencies.assets.read(entry.ownerId, reference.assetId);
    if (!stored || stored.metadata.purpose !== reference.purpose || stored.metadata.creatorId !== entry.ownerId) {
      throw new InvalidLocationAssetReferenceError();
    }
    return { metadata: stored.metadata, bytes: stored.bytes };
  }
}
