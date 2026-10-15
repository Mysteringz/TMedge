import { parseLocationCandidate } from '../domain/location-candidate.js';
import { LocationConflictError, LocationDraftNotFoundError } from '../domain/location-records.js';
import { resolveLocationAssetProvenance } from './resolve-location-asset-provenance.js';
import { furnitureAssetReferences } from '../domain/furniture-assets.js';
import { InvalidLocationAssetReferenceError } from '../domain/location-assets.js';
import { InvalidLocationDocumentError } from '../domain/location-document.js';
import type { FurnitureLibraryStore, LocationAssetMetadataRepository, LocationDraftRepository, PublishedLocationRepository } from '../repositories/location-storage.js';

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
    furnitureLibrary?: Pick<FurnitureLibraryStore, 'getFurnitureMetadata'>;
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
    const authored = authoredDocument(input.document);
    const candidate = parseLocationCandidate(
      {
        schemaVersion: 1,
        locationId: draft.locationId,
        visibility: draft.document.visibility,
        ...authored,
      },
      base ? { revision: base.revision, document: base.document, legacySpatial: base.legacySpatial } : null,
      draft.basePublishedRevision,
    );
    const assetProvenance = await resolveLocationAssetProvenance(input.creatorId, candidate.document, base ? {
      revision: base.revision, document: base.document, assetProvenance: base.assetProvenance,
    } : null, this.dependencies.assetMetadata);
    for (const reference of furnitureAssetReferences(candidate.document)) {
      const metadata = await this.dependencies.furnitureLibrary?.getFurnitureMetadata(reference.assetId);
      if (!metadata) throw new InvalidLocationAssetReferenceError('The referenced furniture asset is not available.');
      if (metadata.purpose !== 'furniture') throw new InvalidLocationAssetReferenceError('The referenced asset is not furniture.');
      if (metadata.furnitureType !== reference.furnitureType) throw new InvalidLocationDocumentError('The furniture asset type does not match its slot.');
    }
    return this.dependencies.drafts.saveDraft(
      input.creatorId, input.draftId, input.expectedDraftRevision, { ...candidate, assetProvenance },
      (this.dependencies.now ?? Date.now)(),
    );
  }
}

const AUTHORED_KEYS = [
  'name', 'building', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments',
  'planAssetId', 'modelAssetId', 'modelTransform', 'proceduralRoom', 'furnitureDefaults',
];
const REQUIRED_AUTHORED_KEYS = ['name', 'building', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments'];

function authoredDocument(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('The authored location document must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !AUTHORED_KEYS.includes(key))) {
    throw new TypeError('The authored location document contains a server-managed or unknown field.');
  }
  if (REQUIRED_AUTHORED_KEYS.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError('The authored location document is incomplete.');
  }
  return input;
}
