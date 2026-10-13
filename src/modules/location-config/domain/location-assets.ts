import type { LocationAssetPurpose } from './location-records.js';
import type { LocationDocument, TrustedLegacyLocationBaseline } from './location-document.js';

export type LocationAssetSlot = 'planAssetId' | 'modelAssetId';

export interface UploadedLocationAssetProvenance {
  kind: 'upload';
  ownerId: string;
}

/** Trusted marker for a static model already present in the revision-0 seed. */
export interface LegacyStaticModelProvenance {
  kind: 'legacy-static';
  basePublishedRevision: 0;
  locationId: string;
  assetId: string;
}

export type LocationAssetProvenanceEntry = UploadedLocationAssetProvenance | LegacyStaticModelProvenance;
export type LocationAssetProvenance = Partial<Record<LocationAssetSlot, LocationAssetProvenanceEntry>>;

export interface LocationAssetReference {
  slot: LocationAssetSlot;
  assetId: string;
  purpose: LocationAssetPurpose;
}

export class InvalidLocationAssetReferenceError extends Error {
  constructor(message = 'The asset is not available to this location draft.') {
    super(message);
    this.name = 'InvalidLocationAssetReferenceError';
  }
}

type AssetDocument = Pick<LocationDocument | TrustedLegacyLocationBaseline, 'locationId'> &
  Partial<Pick<LocationDocument | TrustedLegacyLocationBaseline, 'planAssetId' | 'modelAssetId'>>;

export function locationAssetReferences(document: AssetDocument): LocationAssetReference[] {
  const references: LocationAssetReference[] = [];
  if (document.planAssetId !== undefined) references.push({ slot: 'planAssetId', assetId: document.planAssetId, purpose: 'floor-plan' });
  if (document.modelAssetId !== undefined) references.push({ slot: 'modelAssetId', assetId: document.modelAssetId, purpose: 'model' });
  if (references.length === 2 && references[0]!.assetId === references[1]!.assetId) {
    throw new InvalidLocationAssetReferenceError('A single asset cannot be used for both a floor plan and a model.');
  }
  return references;
}

/** Validates the exact set of server-side provenance entries for document slots. */
export function parseLocationAssetProvenance(value: unknown, document: AssetDocument): LocationAssetProvenance {
  const references = locationAssetReferences(document);
  if (value === undefined || value === null) {
    if (references.length === 0) return {};
    throw new InvalidLocationAssetReferenceError('Asset provenance is missing for a referenced asset.');
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new InvalidLocationAssetReferenceError('Asset provenance is invalid.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'planAssetId' && key !== 'modelAssetId')) {
    throw new InvalidLocationAssetReferenceError('Asset provenance contains an unknown slot.');
  }
  const referenceBySlot = new Map(references.map((reference) => [reference.slot, reference]));
  if (Object.keys(input).length !== references.length || references.some((reference) => !Object.hasOwn(input, reference.slot))) {
    throw new InvalidLocationAssetReferenceError('Asset provenance must match the referenced asset slots exactly.');
  }
  const result: LocationAssetProvenance = {};
  for (const reference of references) {
    const raw = input[reference.slot];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidLocationAssetReferenceError('Asset provenance entry is invalid.');
    const entry = raw as Record<string, unknown>;
    if (entry.kind === 'upload') {
      if (Object.keys(entry).some((key) => key !== 'kind' && key !== 'ownerId') || typeof entry.ownerId !== 'string'
        || entry.ownerId.trim() === '' || entry.ownerId.length > 256) {
        throw new InvalidLocationAssetReferenceError('Upload provenance is invalid.');
      }
      result[reference.slot] = { kind: 'upload', ownerId: entry.ownerId };
      continue;
    }
    if (entry.kind === 'legacy-static' && reference.slot === 'modelAssetId'
      && Object.keys(entry).every((key) => ['kind', 'basePublishedRevision', 'locationId', 'assetId'].includes(key))
      && Object.keys(entry).length === 4 && entry.basePublishedRevision === 0
      && entry.locationId === document.locationId && entry.assetId === reference.assetId) {
      result.modelAssetId = {
        kind: 'legacy-static', basePublishedRevision: 0, locationId: document.locationId, assetId: reference.assetId,
      };
      continue;
    }
    throw new InvalidLocationAssetReferenceError('Asset provenance does not match this location revision.');
  }
  // The map comparison above also prevents orphan, unreferenced provenance.
  if (referenceBySlot.size !== references.length) throw new InvalidLocationAssetReferenceError();
  return result;
}

export function sameLocationAssetProvenance(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a ?? {})) === JSON.stringify(canonicalJson(b ?? {}));
}

/** Confirms that a revision only inherits exact base-slot entries or introduces uploads by its creator. */
export function validateLocationAssetProvenanceTransition(
  document: LocationDocument,
  provenanceInput: unknown,
  creatorId: string,
  base: { revision: number; document: LocationDocument | TrustedLegacyLocationBaseline; assetProvenance?: LocationAssetProvenance } | null,
): LocationAssetProvenance {
  const provenance = parseLocationAssetProvenance(provenanceInput, document);
  const baseProvenance = base ? parseLocationAssetProvenance(base.assetProvenance, base.document) : {};
  if (baseProvenance.modelAssetId?.kind === 'legacy-static' && document.modelAssetId === undefined) {
    throw new InvalidLocationAssetReferenceError('A legacy static model must be retained unchanged or replaced with an uploaded GLB.');
  }
  for (const reference of locationAssetReferences(document)) {
    const entry = provenance[reference.slot];
    if (!entry) throw new InvalidLocationAssetReferenceError();
    if (base && base.document[reference.slot] === reference.assetId) {
      const inherited = baseProvenance[reference.slot];
      if (!inherited || !sameLocationAssetProvenance(entry, inherited)) throw new InvalidLocationAssetReferenceError();
      if (entry.kind === 'legacy-static' && (reference.slot !== 'modelAssetId'
        || entry.basePublishedRevision !== 0 || entry.locationId !== document.locationId || entry.assetId !== reference.assetId)) {
        throw new InvalidLocationAssetReferenceError();
      }
      if (entry.kind === 'legacy-static' && !sameJson(document.modelTransform, base.document.modelTransform)) {
        throw new InvalidLocationAssetReferenceError('A legacy static model transform cannot be edited; replace the model with an upload.');
      }
      continue;
    }
    if (entry.kind !== 'upload' || entry.ownerId !== creatorId) throw new InvalidLocationAssetReferenceError();
  }
  return provenance;
}

export function legacyStaticModelProvenance(document: TrustedLegacyLocationBaseline): LocationAssetProvenance {
  return document.modelAssetId ? {
    modelAssetId: {
      kind: 'legacy-static', basePublishedRevision: 0, locationId: document.locationId, assetId: document.modelAssetId,
    },
  } : {};
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]));
  return value;
}
