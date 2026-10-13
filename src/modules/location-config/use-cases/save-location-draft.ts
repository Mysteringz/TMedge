import { parseLocationCandidate } from '../domain/location-candidate.js';
import { LocationConflictError, LocationDraftNotFoundError } from '../domain/location-records.js';
import { resolveLocationAssetProvenance } from './resolve-location-asset-provenance.js';
import type { LocationAssetMetadataRepository, LocationDraftRepository, PublishedLocationRepository } from '../repositories/location-storage.js';

export interface SaveLocationDraftInput {
  creatorId: string;
  draftId: string;
  expectedDraftRevision: number;
  document: unknown;
}

export class SaveLocationDraftUseCase {
  constructor(private readonly dependencies: {
    drafts: LocationDraftRepository;
    published: PublishedLocationRepository;
    assetMetadata?: LocationAssetMetadataRepository;
    now?: () => number;
  }) {}

  async execute(input: SaveLocationDraftInput) {
    if (!input || typeof input.creatorId !== 'string' || input.creatorId.trim() === '' || input.creatorId.length > 256
      || typeof input.draftId !== 'string' || !Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1) {
      throw new TypeError('Location draft save request is invalid.');
    }
    const draft = await this.dependencies.drafts.getDraft(input.creatorId, input.draftId);
    if (!draft) throw new LocationDraftNotFoundError();
    if (draft.draftRevision !== input.expectedDraftRevision) throw new LocationConflictError('The draft changed; reload it before saving.');
    const state = await this.dependencies.published.getActive(draft.locationId);
    const base = draft.basePublishedRevision === null ? null : state?.history.find((revision) => revision.revision === draft.basePublishedRevision) ?? null;
    if (draft.basePublishedRevision !== null && !base) throw new LocationConflictError('The pinned base location revision is unavailable.');
    if (draft.basePublishedRevision === null && state) throw new LocationConflictError('A location was published after this draft was created.');
    const candidate = parseLocationCandidate(
      input.document,
      base ? { revision: base.revision, document: base.document, legacySpatial: base.legacySpatial } : null,
      draft.basePublishedRevision,
    );
    const assetProvenance = await resolveLocationAssetProvenance(input.creatorId, candidate.document, base ? {
      revision: base.revision, document: base.document, assetProvenance: base.assetProvenance,
    } : null, this.dependencies.assetMetadata);
    return this.dependencies.drafts.saveDraft(
      input.creatorId, input.draftId, input.expectedDraftRevision, { ...candidate, assetProvenance },
      (this.dependencies.now ?? Date.now)(),
    );
  }
}
