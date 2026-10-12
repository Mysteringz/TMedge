import { randomUUID } from 'node:crypto';
import { exposePublishedLocationCandidate, parseLocationCandidate } from '../domain/location-candidate.js';
import { LocationConflictError } from '../domain/location-records.js';
import type { LocationDraftRepository, LocationRegistrySnapshotRepository, RegistryMutationCoordinator } from '../repositories/location-storage.js';

export interface StartLocationEditDraftInput {
  creatorId: string;
  locationId: string;
  expectedPublishedRevision: number;
}

export class StartLocationEditDraftUseCase {
  constructor(private readonly dependencies: {
    drafts: LocationDraftRepository;
    snapshots: LocationRegistrySnapshotRepository;
    mutationCoordinator: RegistryMutationCoordinator;
    now?: () => number;
    createDraftId?: () => string;
  }) {}

  async execute(input: StartLocationEditDraftInput) {
    if (!input || typeof input.creatorId !== 'string' || input.creatorId.trim() === '' || input.creatorId.length > 256
      || typeof input.locationId !== 'string' || !Number.isSafeInteger(input.expectedPublishedRevision) || input.expectedPublishedRevision < 0) {
      throw new TypeError('Location edit draft request is invalid.');
    }
    const state = await this.dependencies.mutationCoordinator.withMutationLock(async () => {
      this.dependencies.mutationCoordinator.assertHealthy();
      const snapshot = await this.dependencies.snapshots.readSnapshot();
      return snapshot.locations.find((location) => location.locationId === input.locationId) ?? null;
    });
    if (!state || state.activeRevision !== input.expectedPublishedRevision) throw new LocationConflictError('The published location changed; reload it before editing.');
    const base = state.history.find((revision) => revision.revision === state.activeRevision);
    if (!base) throw new LocationConflictError('The active location revision is unavailable.');
    const candidate = parseLocationCandidate(
      exposePublishedLocationCandidate({ revision: base.revision, document: base.document, legacySpatial: base.legacySpatial }),
      { revision: base.revision, document: base.document, legacySpatial: base.legacySpatial },
      base.revision,
    );
    const createdAt = (this.dependencies.now ?? Date.now)();
    const draft = {
      draftId: (this.dependencies.createDraftId ?? randomUUID)(),
      creatorId: input.creatorId,
      locationId: input.locationId,
      draftRevision: 1,
      basePublishedRevision: base.revision,
      createdAt,
      updatedAt: createdAt,
      document: candidate.document,
      legacySpatial: candidate.legacySpatial,
    };
    return this.dependencies.drafts.createDraft(draft);
  }
}
