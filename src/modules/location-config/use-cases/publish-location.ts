import { type LocationSensorAssignment } from '../domain/location-document.js';
import { revalidateLocationCandidate } from '../domain/location-candidate.js';
import { locationModelPresentationDisposition } from '../domain/location-assets.js';
import { LocationConflictError, LocationDraftNotFoundError, UnknownRegistryCommitOutcomeError, RegistryMutationQuarantinedError, type PublishedLocationRevision } from '../domain/location-records.js';
import { resolveLocationAssetProvenance, sameResolvedLocationAssetProvenance } from './resolve-location-asset-provenance.js';
import type {
  LocationAssetMetadataRepository, LocationDraftRepository, LocationRegistrySnapshotRepository, LocationRegistryNodeSnapshot,
  PreparedLocationRuntime, PublishedLocationRepository, PublishedModelDistributor, RegistryMutationCoordinator,
  LocationRegistrySnapshot,
} from '../repositories/location-storage.js';

export interface PublishLocationInput {
  creatorId: string;
  draftId: string;
  expectedDraftRevision: number;
  expectedPublishedRevision: number | null;
}

export interface PublishLocationResult {
  kind: 'committed';
  locationId: string;
  publishedRevision: number;
  registryRevision: number;
  durability: 'confirmed' | 'unconfirmed';
  acknowledgement: 'received' | 'reconciled';
}

export class PublishedModelDistributionUnavailableError extends Error {
  constructor() {
    super('A published GLB requires a configured model distributor.');
    this.name = 'PublishedModelDistributionUnavailableError';
  }
}

export class PublishedModelDistributionFailedError extends Error {
  constructor(cause: unknown) {
    super('A student web tier did not acknowledge the published GLB.', { cause });
    this.name = 'PublishedModelDistributionFailedError';
  }
}

export class PublishLocationUseCase<Prepared> {
  constructor(private readonly dependencies: {
    drafts: LocationDraftRepository;
    published: PublishedLocationRepository;
    snapshots: LocationRegistrySnapshotRepository;
    mutationCoordinator: RegistryMutationCoordinator;
    runtime: PreparedLocationRuntime<Prepared>;
    assetMetadata?: LocationAssetMetadataRepository;
    modelDistributor?: PublishedModelDistributor;
    now?: () => number;
  }) {}

  execute(input: PublishLocationInput): Promise<PublishLocationResult> {
    validateInput(input);
    return this.dependencies.mutationCoordinator.withMutationLock(() => this.publishWithinMutation(input));
  }

  private async publishWithinMutation(input: PublishLocationInput): Promise<PublishLocationResult> {
    const { mutationCoordinator, drafts, published, snapshots, runtime } = this.dependencies;
    mutationCoordinator.assertHealthy();
    const snapshot = await snapshots.readSnapshot();
    const draft = await drafts.getDraftForReadWithinMutation(input.creatorId, input.draftId);
    if (!draft) throw new LocationDraftNotFoundError();
    if (draft.draftRevision !== input.expectedDraftRevision) throw new LocationConflictError('The draft changed; reload it before publishing.');
    const state = snapshot.locations.find((location) => location.locationId === draft.locationId) ?? null;
    const activeRevision = state?.activeRevision ?? null;
    if (activeRevision !== input.expectedPublishedRevision || draft.basePublishedRevision !== activeRevision) {
      throw new LocationConflictError('The published location changed; reload it before publishing.');
    }
    const basePublishedRevision = draft.basePublishedRevision === null
      ? null
      : stateRevision(state ?? undefined, draft.basePublishedRevision);
    if (draft.basePublishedRevision !== null && !basePublishedRevision) {
      throw new LocationConflictError('The pinned base location revision is no longer available.');
    }
    const validated = revalidateLocationCandidate(
      draft.document,
      draft.legacySpatial,
      basePublishedRevision ? {
        revision: basePublishedRevision.revision,
        document: basePublishedRevision.document,
        legacySpatial: basePublishedRevision.legacySpatial,
      } : null,
      draft.basePublishedRevision,
    );
    const document = validated.document;
    if (document.locationId !== draft.locationId) throw new LocationConflictError('The draft location identity is invalid.');
    const assetProvenance = await resolveLocationAssetProvenance(input.creatorId, document, basePublishedRevision ? {
      revision: basePublishedRevision.revision,
      document: basePublishedRevision.document,
      assetProvenance: basePublishedRevision.assetProvenance,
    } : null, this.dependencies.assetMetadata);
    if (!sameResolvedLocationAssetProvenance(assetProvenance, draft.assetProvenance)) {
      throw new LocationConflictError('The draft asset references changed; reload it before publishing.');
    }

    if (!state) await published.assertLocationIdAvailable(draft.locationId);
    validateSensorAssignments(document.sensorAssignments, snapshot.nodes, document.locationId, document.visibility);

    const createdAt = (this.dependencies.now ?? Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Publication timestamp is invalid.');
    const candidate: PublishedLocationRevision = {
      locationId: document.locationId,
      revision: (activeRevision ?? 0) + 1,
      createdBy: input.creatorId,
      createdAt,
      document,
      legacySpatial: validated.legacySpatial,
      assetProvenance,
    };
    const modelProvenance = assetProvenance.modelAssetId;
    const runtimeDocument = modelProvenance?.kind === 'legacy-static'
      ? { ...document, modelAssetId: undefined, modelTransform: undefined }
      : document;
    const modelDisposition = locationModelPresentationDisposition(document, assetProvenance);
    let prepared = runtime.prepare(snapshot, runtimeDocument, validated.legacySpatial, modelDisposition);

    if (document.visibility === 'public' && document.modelAssetId && modelProvenance?.kind === 'upload') {
      const distributor = this.dependencies.modelDistributor;
      if (!distributor) throw new PublishedModelDistributionUnavailableError();
      try { await distributor.acknowledge({ draft, candidate, basePublishedRevision }); }
      catch (error) { throw new PublishedModelDistributionFailedError(error); }
      // Ingest continues while transfer is pending. Refresh the detached, pre-serialized snapshot from the shared tracks.
    }

    prepared = runtime.refresh(prepared);

    let result;
    try {
      result = await published.commitWithinMutation({
        expectedRegistryRevision: snapshot.registryRevision,
        expectedPublishedRevision: activeRevision,
        revision: candidate,
        assignments: document.sensorAssignments,
      });
    } catch (error) {
      if (error instanceof UnknownRegistryCommitOutcomeError || error instanceof RegistryMutationQuarantinedError) runtime.quarantine(error);
      throw error;
    }
    runtime.activate(prepared);
    return {
      kind: 'committed',
      locationId: document.locationId,
      publishedRevision: result.activeRevision,
      registryRevision: result.registryRevision,
      durability: result.durability,
      acknowledgement: result.acknowledgement,
    };
  }
}

function validateInput(input: PublishLocationInput): void {
  if (!input || typeof input.creatorId !== 'string' || input.creatorId.trim() === '' || input.creatorId.length > 256
    || typeof input.draftId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.draftId)
    || !Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1
    || (input.expectedPublishedRevision !== null && (!Number.isSafeInteger(input.expectedPublishedRevision) || input.expectedPublishedRevision < 0))) {
    throw new TypeError('Publication request is invalid.');
  }
}

function stateRevision(state: LocationRegistrySnapshot['locations'][number] | undefined, revision: number): PublishedLocationRevision | null {
  return state?.history.find((item) => item.revision === revision) ?? null;
}

function validateSensorAssignments(
  assignments: readonly LocationSensorAssignment[],
  nodes: readonly LocationRegistryNodeSnapshot[],
  locationId: string,
  visibility: 'public' | 'console',
): void {
  const byUid = new Map(nodes.map((node) => [node.uid.toLowerCase(), node]));
  for (const assignment of assignments) {
    const node = byUid.get(assignment.uid.toLowerCase());
    if (!node) throw new LocationConflictError(`Sensor ${assignment.uid} is not approved on this edge.`);
    if (node.floorId !== null && node.floorId !== locationId) {
      throw new LocationConflictError(`Sensor ${assignment.uid} already belongs to another location.`);
    }
    if (node.floorId === null && (node.pose !== null || node.owns.length > 0)) {
      throw new LocationConflictError(`Sensor ${assignment.uid} has an invalid unplaced registry state.`);
    }
    if (node.rgb && visibility !== 'console') {
      throw new LocationConflictError(`RGB sensor ${assignment.uid} cannot be assigned to a public location.`);
    }
  }
}
