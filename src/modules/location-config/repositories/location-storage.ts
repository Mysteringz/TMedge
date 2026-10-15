import type { FurnitureType, LocationAssetMetadata, LocationDraft, PublishedLocationRevision, PublishedLocationState } from '../domain/location-records.js';
import type { LocationDocument, LocationSensorAssignment } from '../domain/location-document.js';
import type { ValidatedLocationCandidate } from '../domain/location-candidate.js';
import type { LegacySpatialProvenance } from '../domain/location-candidate.js';
import type { NodePose } from '../../../shared/types.js';
import type { LocationModelPresentationDisposition } from '../domain/location-assets.js';

export type CommitDurability = 'confirmed' | 'unconfirmed';

export interface DraftWriteOutcome {
  kind: 'committed';
  durability: CommitDurability;
  draft: LocationDraft;
  contentSha256: string;
}

export interface DraftDeletionOutcome {
  kind: 'deleted';
  draftId: string;
  durability: CommitDurability;
}

export interface RegistryCommitOutcome {
  kind: 'committed';
  durability: CommitDurability;
  acknowledgement: 'received' | 'reconciled';
  registryRevision: number;
  activeRevision: number;
  contentSha256?: string;
}

export interface LocationDraftRepository {
  createDraft(draft: LocationDraft): Promise<DraftWriteOutcome>;
  getDraft(creatorId: string, draftId: string): Promise<LocationDraft | null>;
  /** Read an authoritative draft snapshot, reconciling any applied-but-unconfirmed file write first. */
  getDraftForRead(creatorId: string, draftId: string): Promise<LocationDraft | null>;
  /** Same reconciliation path for callers that already hold RegistryMutationCoordinator. */
  getDraftForReadWithinMutation(creatorId: string, draftId: string): Promise<LocationDraft | null>;
  listDrafts(creatorId: string): Promise<LocationDraft[]>;
  /** Caller holds RegistryMutationCoordinator; delete only the exact revision confirmed by its creator. */
  deleteDraftWithinMutation(creatorId: string, draftId: string, expectedRevision: number): Promise<DraftDeletionOutcome>;
  saveDraft(creatorId: string, draftId: string, expectedRevision: number, candidate: ValidatedLocationCandidate, updatedAt: number): Promise<DraftWriteOutcome>;
}

export interface PublishedLocationRepository {
  assertLocationIdAvailable(locationId: string): Promise<void>;
  getActive(locationId: string): Promise<PublishedLocationState | null>;
  listActive(): Promise<PublishedLocationState[]>;
  listHistory(locationId: string): Promise<PublishedLocationRevision[]>;
  /** Caller holds RegistryMutationCoordinator for the whole prepare/commit/activate sequence. */
  commitWithinMutation(input: {
    expectedRegistryRevision: number;
    expectedPublishedRevision: number | null;
    revision: PublishedLocationRevision;
    assignments: readonly LocationSensorAssignment[];
  }): Promise<RegistryCommitOutcome>;
  registryRevision(): Promise<number>;
}

export interface LocationRegistryNodeSnapshot {
  uid: string;
  label: string;
  floorId: string | null;
  pose: NodePose | null;
  owns: string[];
  simulated: boolean;
  rgb: boolean;
  detector: 'node' | 'edge';
}

/** One consistent view read while RegistryMutationCoordinator is held. */
export interface LocationRegistrySnapshot {
  registryRevision: number;
  nodes: readonly LocationRegistryNodeSnapshot[];
  locations: readonly PublishedLocationState[];
}

export interface LocationRegistrySnapshotRepository {
  readSnapshot(): Promise<LocationRegistrySnapshot>;
}

/** Runtime adapter builds everything before durable commit, then only swaps an already prepared generation. */
export interface PreparedLocationRuntime<Prepared> {
  prepare(
    snapshot: LocationRegistrySnapshot,
    candidate: LocationDocument,
    legacySpatial?: LegacySpatialProvenance | null,
    modelDisposition?: LocationModelPresentationDisposition,
  ): Prepared;
  refresh(prepared: Prepared): Prepared;
  activate(prepared: Prepared): void;
  quarantine(reason: unknown): void;
}

export interface PublishedModelDistributionRequest {
  draft: LocationDraft;
  candidate: PublishedLocationRevision;
  /** Exact immutable revision from which inherited model bytes may be resolved. */
  basePublishedRevision: PublishedLocationRevision | null;
}

export interface PublishedModelDistributor {
  /** Resolves authorized immutable bytes and waits for durable acknowledgement from every student target. */
  acknowledge(request: PublishedModelDistributionRequest): Promise<void>;
}

export interface LocationAssetMetadataRepository {
  saveAssetMetadata(metadata: LocationAssetMetadata): Promise<void>;
  getAssetMetadata(creatorId: string, assetId: string): Promise<LocationAssetMetadata | null>;
}

export interface LocationAssetStore {
  put(creatorId: string, purpose: LocationAssetMetadata['purpose'], declaredMediaType: string, bytes: Uint8Array, createdAt: number, displayName?: string): Promise<LocationAssetMetadata>;
  read(creatorId: string, assetId: string): Promise<{ metadata: LocationAssetMetadata; bytes: Buffer } | null>;
}

export type FurnitureLibraryMetadata = LocationAssetMetadata & {
  purpose: 'furniture';
  furnitureType: FurnitureType;
  displayName: string;
};

export interface FurnitureLibraryStore {
  createFurnitureItem(input: { creatorId: string; furnitureType: FurnitureType; displayName: string; bytes: Uint8Array; createdAt: number }): Promise<FurnitureLibraryMetadata>;
  getFurnitureMetadata(assetId: string): Promise<FurnitureLibraryMetadata | null>;
  listFurnitureMetadata(filter: { furnitureType?: FurnitureType; query?: string }): Promise<FurnitureLibraryMetadata[]>;
  readFurnitureItem(assetId: string): Promise<{ metadata: FurnitureLibraryMetadata; bytes: Buffer } | null>;
}

/** Serializes provisioning, registration imports and location registry changes. */
export interface RegistryMutationCoordinator {
  withMutationLock<T>(operation: () => Promise<T> | T): Promise<T>;
  assertHealthy(): void;
  quarantine(reason: unknown): void;
  /** File coordinators retry this exact readback before the next registry mutation. */
  latchDurabilityRecovery?(recover: () => void): void;
}
