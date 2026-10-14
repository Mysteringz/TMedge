import type { LocationDocument, TrustedLegacyLocationBaseline } from './location-document.js';
import type { LegacySpatialProvenance } from './location-candidate.js';
import type { LocationAssetProvenance } from './location-assets.js';

export interface LocationDraft {
  draftId: string;
  creatorId: string;
  locationId: string;
  draftRevision: number;
  basePublishedRevision: number | null;
  createdAt: number;
  updatedAt: number;
  document: LocationDocument;
  /** Server-derived; never copied from request JSON. */
  legacySpatial?: LegacySpatialProvenance | null;
  /** Server-derived slot ownership/static compatibility; never copied from request JSON. */
  assetProvenance?: LocationAssetProvenance;
}

export interface PublishedLocationRevision {
  locationId: string;
  revision: number;
  createdBy: string;
  createdAt: number;
  document: LocationDocument | TrustedLegacyLocationBaseline;
  /** Server-derived, immutable provenance for unchanged legacy geometry. */
  legacySpatial?: LegacySpatialProvenance | null;
  /** Server-derived immutable provenance for each referenced plan/model asset slot. */
  assetProvenance?: LocationAssetProvenance;
}

export type LocationAssetPurpose = 'floor-plan' | 'model' | 'furniture';
export type FurnitureType = 'table' | 'chair';
export type LocationAssetMediaType = 'image/png' | 'image/jpeg' | 'model/gltf-binary';

export interface LocationAssetMetadata {
  assetId: string;
  creatorId: string;
  purpose: LocationAssetPurpose;
  mediaType: LocationAssetMediaType;
  /** Sanitized user-facing label; never used for authorization or storage paths. */
  displayName?: string;
  /** Required for furniture; absent for room models and floor plans. */
  furnitureType?: FurnitureType;
  sha256: string;
  byteLength: number;
  createdAt: number;
}

export interface PublishedLocationState {
  locationId: string;
  activeRevision: number;
  history: PublishedLocationRevision[];
}

export class LocationConflictError extends Error {
  constructor(message = 'The location revision changed; reload the latest version and try again.') {
    super(message);
    this.name = 'LocationConflictError';
  }
}

export class LocationStorageUnavailableError extends Error {
  constructor() {
    super('Location storage is unavailable.');
    this.name = 'LocationStorageUnavailableError';
  }
}

/** The database could not be read back after a lost COMMIT acknowledgement. */
export class UnknownRegistryCommitOutcomeError extends LocationStorageUnavailableError {
  constructor(
    readonly baseRegistryRevision: number,
    readonly candidateRegistryRevision: number,
    readonly locationId: string,
  ) {
    super();
    this.name = 'UnknownRegistryCommitOutcomeError';
  }
}

/** A registry write's COMMIT acknowledgement was lost and exact state cannot be established. */
export class UnknownRegistryMutationOutcomeError extends LocationStorageUnavailableError {
  constructor(readonly baseRegistryRevision: number, readonly candidateRegistryRevision: number) {
    super();
    this.name = 'UnknownRegistryMutationOutcomeError';
  }
}

export class RegistryMutationQuarantinedError extends LocationStorageUnavailableError {
  constructor() {
    super();
    this.name = 'RegistryMutationQuarantinedError';
  }
}

export class LocationDraftNotFoundError extends Error {
  constructor() {
    super('Location draft was not found.');
    this.name = 'LocationDraftNotFoundError';
  }
}
