import type { LocationAssetMetadata, LocationDraft, PublishedLocationRevision, PublishedLocationState } from '../domain/location-records.js';
import type { LocationDocument, LocationSensorAssignment } from '../domain/location-document.js';

export type CommitDurability = 'confirmed' | 'unconfirmed';

export interface DraftWriteOutcome {
  kind: 'committed';
  durability: CommitDurability;
  draft: LocationDraft;
  contentSha256: string;
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
  listDrafts(creatorId: string): Promise<LocationDraft[]>;
  saveDraft(creatorId: string, draftId: string, expectedRevision: number, document: LocationDocument, updatedAt: number): Promise<DraftWriteOutcome>;
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

export interface LocationAssetMetadataRepository {
  saveAssetMetadata(metadata: LocationAssetMetadata): Promise<void>;
  getAssetMetadata(creatorId: string, assetId: string): Promise<LocationAssetMetadata | null>;
}

export interface LocationAssetStore {
  put(creatorId: string, purpose: LocationAssetMetadata['purpose'], declaredMediaType: string, bytes: Uint8Array, createdAt: number): Promise<LocationAssetMetadata>;
  read(creatorId: string, assetId: string): Promise<{ metadata: LocationAssetMetadata; bytes: Buffer } | null>;
}

/** Serializes provisioning, registration imports and location registry changes. */
export interface RegistryMutationCoordinator {
  withMutationLock<T>(operation: () => Promise<T> | T): Promise<T>;
  assertHealthy(): void;
  quarantine(reason: unknown): void;
  /** File coordinators retry this exact readback before the next registry mutation. */
  latchDurabilityRecovery?(recover: () => void): void;
}
