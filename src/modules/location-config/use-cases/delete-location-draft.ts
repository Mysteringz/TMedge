import { LocationConflictError, LocationDraftNotFoundError } from '../domain/location-records.js';
import type { LocationDraftRepository, RegistryMutationCoordinator } from '../repositories/location-storage.js';

/** Serialize deletion with publication, retaining published history and immutable asset bytes. */
export class DeleteLocationDraftUseCase {
  constructor(private readonly dependencies: { drafts: LocationDraftRepository; coordinator: RegistryMutationCoordinator }) {}

  execute(input: { creatorId: string; draftId: string; expectedDraftRevision: number }) {
    if (!input || typeof input.creatorId !== 'string' || !input.creatorId.trim() || input.creatorId.length > 256
      || typeof input.draftId !== 'string' || !Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1) {
      throw new TypeError('Draft removal request is invalid.');
    }
    return this.dependencies.coordinator.withMutationLock(async () => {
      this.dependencies.coordinator.assertHealthy();
      const draft = await this.dependencies.drafts.getDraftForReadWithinMutation(input.creatorId, input.draftId);
      if (!draft) throw new LocationDraftNotFoundError();
      if (draft.draftRevision !== input.expectedDraftRevision) throw new LocationConflictError('The draft changed. Reload the list before removing it.');
      return this.dependencies.drafts.deleteDraftWithinMutation(input.creatorId, draft.draftId, input.expectedDraftRevision);
    });
  }
}
