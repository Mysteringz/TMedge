import { isLocationId } from '../domain/location-document.js';
import { LocationConflictError, LocationStorageUnavailableError } from '../domain/location-records.js';
import type { LocationRegistrySnapshotRepository, PublishedLocationRepository, RegistryMutationCoordinator, PreparedLocationRemovalRuntime } from '../repositories/location-storage.js';

/** Prepare, persist and activate removal under the same writer lock as publication. */
export class RemoveLocationUseCase<Prepared> {
  constructor(private readonly dependencies: {
    published: PublishedLocationRepository; snapshots: LocationRegistrySnapshotRepository;
    coordinator: RegistryMutationCoordinator; runtime: PreparedLocationRemovalRuntime<Prepared>; now?: () => number;
  }) {}

  execute(input: { creatorId: string; locationId: string; expectedPublishedRevision: number }) {
    if (!input || typeof input.creatorId !== 'string' || !input.creatorId.trim() || input.creatorId.length > 256
      || !isLocationId(input.locationId) || !Number.isSafeInteger(input.expectedPublishedRevision) || input.expectedPublishedRevision < 0) {
      throw new TypeError('Location removal request is invalid.');
    }
    return this.dependencies.coordinator.withMutationLock(async () => {
      const { coordinator, published, snapshots, runtime } = this.dependencies;
      coordinator.assertHealthy();
      const snapshot = await snapshots.readSnapshot();
      const state = snapshot.locations.find(location => location.locationId === input.locationId);
      if (state?.removal) throw new LocationConflictError('This location has been removed.');
      if (!state || state.activeRevision !== input.expectedPublishedRevision) throw new LocationConflictError('The published location changed; reload before removing it.');
      const removedAt = (this.dependencies.now ?? Date.now)();
      if (!Number.isSafeInteger(removedAt) || removedAt < 0) throw new TypeError('Removal timestamp is invalid.');
      const prepared = runtime.refresh(runtime.prepareRemoval(snapshot, input.locationId));
      let result;
      try {
        result = await published.removeWithinMutation({ ...input, expectedRegistryRevision: snapshot.registryRevision, removal: { removedAt, removedBy: input.creatorId } });
      } catch (error) {
        // Unknown durable outcomes must never leave the old runtime publishing a removed location.
        if (error instanceof LocationStorageUnavailableError) { coordinator.quarantine(error); runtime.quarantine(error); }
        throw error;
      }
      runtime.activate(prepared);
      return result;
    });
  }
}
