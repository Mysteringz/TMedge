import { randomUUID } from 'node:crypto';
import { createLocationId, parseLocationDocument } from '../domain/location-document.js';
import { LocationConflictError } from '../domain/location-records.js';
import type { LocationDraftRepository, LocationRegistrySnapshotRepository, PublishedLocationRepository, RegistryMutationCoordinator } from '../repositories/location-storage.js';

export interface CreateLocationDraftInput { creatorId: string; name: string; building: string; widthCm: number; heightCm: number }

export class CreateLocationDraftUseCase {
  constructor(private readonly dependencies: {
    edgeId: string;
    drafts: LocationDraftRepository;
    published: PublishedLocationRepository;
    snapshots: LocationRegistrySnapshotRepository;
    coordinator: RegistryMutationCoordinator;
    now?: () => number;
    createUuid?: () => string;
  }) {}

  async execute(input: CreateLocationDraftInput) {
    validateInput(input);
    const { coordinator, snapshots, published } = this.dependencies;
    const locationId = await coordinator.withMutationLock(async () => {
      coordinator.assertHealthy();
      await snapshots.readSnapshot();
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = createLocationId(this.dependencies.edgeId, (this.dependencies.createUuid ?? randomUUID)());
        try { await published.assertLocationIdAvailable(id); return id; }
        catch (error) { if (!(error instanceof LocationConflictError)) throw error; }
      }
      throw new LocationConflictError('A unique location ID could not be allocated.');
    });
    const createdAt = (this.dependencies.now ?? Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Draft timestamp is invalid.');
    const document = parseLocationDocument({
      schemaVersion: 1,
      locationId,
      name: input.name,
      building: input.building,
      visibility: 'public',
      widthCm: input.widthCm,
      heightCm: input.heightCm,
      outline: [[0, 0], [input.widthCm, 0], [input.widthCm, input.heightCm], [0, input.heightCm]],
      zones: [],
      tables: [],
      sensorAssignments: [],
    });
    return this.dependencies.drafts.createDraft({
      draftId: randomUUID(), creatorId: input.creatorId, locationId,
      draftRevision: 1, basePublishedRevision: null, createdAt, updatedAt: createdAt,
      document, legacySpatial: null, assetProvenance: {},
    });
  }
}

function validateInput(input: CreateLocationDraftInput): void {
  if (!input || typeof input.creatorId !== 'string' || input.creatorId.trim() === '' || input.creatorId.length > 256
    || typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 160
    || typeof input.building !== 'string' || input.building.trim() === '' || input.building.length > 160
    || typeof input.widthCm !== 'number' || !Number.isFinite(input.widthCm) || input.widthCm < 100 || input.widthCm > 100000
    || typeof input.heightCm !== 'number' || !Number.isFinite(input.heightCm) || input.heightCm < 100 || input.heightCm > 100000) {
    throw new TypeError('New location metadata is invalid.');
  }
}
