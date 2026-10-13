import { LocationConflictError, LocationDraftNotFoundError } from '../domain/location-records.js';
import { exposeAuthoredLocationCandidate } from '../domain/location-candidate.js';
import type { LocationAssetStore, LocationDraftRepository } from '../repositories/location-storage.js';
import { SaveLocationDraftUseCase } from './save-location-draft.js';

export class UploadLocationAssetUseCase {
  constructor(private readonly dependencies: {
    drafts: LocationDraftRepository;
    assets: LocationAssetStore;
    saveDraft: SaveLocationDraftUseCase;
    now?: () => number;
  }) {}

  async execute(input: {
    creatorId: string; draftId: string; expectedDraftRevision: number;
    purpose: 'floor-plan' | 'model'; mediaType: string; bytes: Uint8Array; displayName?: string;
  }) {
    const draft = await this.dependencies.drafts.getDraft(input.creatorId, input.draftId);
    if (!draft) throw new LocationDraftNotFoundError();
    if (draft.draftRevision !== input.expectedDraftRevision) throw new LocationConflictError('The draft changed; reload it before uploading.');
    const metadata = await this.dependencies.assets.put(
      input.creatorId, input.purpose, input.mediaType, input.bytes, (this.dependencies.now ?? Date.now)(), input.displayName,
    );
    const document = exposeAuthoredLocationCandidate(draft.document, draft.legacySpatial);
    if (input.purpose === 'floor-plan') document.planAssetId = metadata.assetId;
    else {
      document.modelAssetId = metadata.assetId;
      document.modelTransform ??= {
        scale: { x: 1, y: 1, z: 1 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        positionM: { x: 0, y: 0, z: 0 },
      };
    }
    const outcome = await this.dependencies.saveDraft.execute({
      creatorId: input.creatorId, draftId: input.draftId,
      expectedDraftRevision: input.expectedDraftRevision, document,
    });
    return { metadata, outcome };
  }
}
