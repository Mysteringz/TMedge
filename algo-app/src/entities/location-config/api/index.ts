import { permissionChanged } from '../../admin-session/index.tsx';
import type { AssetUploadResult, CoverageSuggestionResponse, DraftDetail, DraftSummary, DraftWriteResult, EligibleSensorsResponse, FurnitureLibraryItem, FurnitureType, LocationDocument, LocationList, ProposedSensor, PublicationResult, PublishedSummary } from '../model/types.ts';

export class LocationApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'LocationApiError'; }
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('x-tm-algo', '1'); }
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  permissionChanged(response.status);
  const envelope = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok || envelope?.error) {
    throw new LocationApiError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED', envelope?.error?.message ?? 'Location request failed.');
  }
  if (!envelope || !Object.hasOwn(envelope, 'data')) throw new LocationApiError(502, 'INVALID_RESPONSE', 'Location service returned an invalid response.');
  return envelope.data as T;
}

export function listLocations(): Promise<LocationList> { return jsonRequest('/api/locations'); }

export function listFurnitureLibrary(filter: { type?: FurnitureType; q?: string } = {}): Promise<{ items: FurnitureLibraryItem[] }> {
  const query = new URLSearchParams();
  if (filter.type) query.set('type', filter.type);
  if (filter.q !== undefined) query.set('q', filter.q);
  return jsonRequest(`/api/furniture-library${query.size ? `?${query}` : ''}`);
}

/** Uploads a self-contained GLB into the shared role-gated furniture library. */
export async function uploadFurnitureLibraryItem(type: FurnitureType, file: File): Promise<FurnitureLibraryItem> {
  const maxBytes = 128 * 1024 * 1024;
  if (!file.name.toLowerCase().endsWith('.glb') || file.size < 1 || file.size > maxBytes) {
    throw new TypeError('Choose a non-empty GLB no larger than 128 MiB.');
  }
  const response = await fetch('/api/furniture-library', {
    method: 'POST', credentials: 'same-origin',
    headers: {
      'x-tm-algo': '1', 'content-type': 'model/gltf-binary',
      'x-furniture-type': type, 'x-asset-display-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  permissionChanged(response.status);
  const envelope = await response.json().catch(() => null) as { data?: FurnitureLibraryItem; error?: { code?: string; message?: string } } | null;
  if (!response.ok || envelope?.error || !envelope?.data) {
    throw new LocationApiError(response.status, envelope?.error?.code ?? 'FURNITURE_UPLOAD_FAILED', envelope?.error?.message ?? 'Furniture upload failed.');
  }
  return envelope.data;
}

/** Reads an item by immutable library ID, independent of its uploader or draft usage. */
export async function readFurnitureLibraryItem(assetId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`/api/furniture-library/${encodeURIComponent(assetId)}`, {
    credentials: 'same-origin', headers: { accept: 'model/gltf-binary' }, signal,
  });
  permissionChanged(response.status);
  if (!response.ok) throw new LocationApiError(response.status, response.status === 404 ? 'ASSET_NOT_FOUND' : 'FURNITURE_READ_FAILED', 'Furniture asset is unavailable.');
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (mediaType !== 'model/gltf-binary') throw new LocationApiError(502, 'INVALID_FURNITURE_RESPONSE', 'Location service returned an invalid furniture asset.');
  return response.arrayBuffer();
}

export function createLocationDraft(input: { name: string; building: string; widthCm: number; heightCm: number }): Promise<DraftWriteResult> {
  return jsonRequest('/api/locations/drafts', 'POST', input);
}

export function startLocationEdit(locationId: string, expectedPublishedRevision: number): Promise<DraftWriteResult> {
  return jsonRequest(`/api/locations/${encodeURIComponent(locationId)}/drafts`, 'POST', { expectedPublishedRevision });
}

export function getLocationDraft(draftId: string): Promise<DraftDetail> {
  return jsonRequest(`/api/locations/drafts/${encodeURIComponent(draftId)}`);
}

export function getEligibleDraftSensors(draftId: string): Promise<EligibleSensorsResponse> {
  return jsonRequest(`/api/locations/drafts/${encodeURIComponent(draftId)}/sensors`);
}

export function suggestDraftCoverage(draftId: string, document: LocationDocument, proposedSensors: ProposedSensor[]): Promise<CoverageSuggestionResponse> {
  return jsonRequest(`/api/locations/drafts/${encodeURIComponent(draftId)}/coverage-suggestions`, 'POST', { document, proposedSensors });
}

export function saveLocationDraft(draft: DraftDetail, document: LocationDocument): Promise<DraftWriteResult> {
  return jsonRequest(`/api/locations/drafts/${encodeURIComponent(draft.draftId)}`, 'PUT', {
    expectedDraftRevision: draft.draftRevision, document,
  });
}

export async function uploadFloorPlan(draft: DraftDetail, file: File): Promise<AssetUploadResult> {
  const mediaType = file.type;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') throw new TypeError('Choose a PNG or JPEG floor plan.');
  const response = await fetch(`/api/locations/drafts/${encodeURIComponent(draft.draftId)}/assets/floor-plan`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'x-tm-algo': '1', 'if-match': String(draft.draftRevision), 'content-type': mediaType },
    body: file,
  });
  permissionChanged(response.status);
  const envelope = await response.json().catch(() => null) as { data?: AssetUploadResult; error?: { code?: string; message?: string } } | null;
  if (!response.ok || envelope?.error || !envelope?.data) {
    throw new LocationApiError(response.status, envelope?.error?.code ?? 'UPLOAD_FAILED', envelope?.error?.message ?? 'Floor plan upload failed.');
  }
  return envelope.data;
}

/** Uploads one self-contained GLB into the caller's current private draft. */
export async function uploadDraftModel(draft: DraftDetail, file: File): Promise<AssetUploadResult> {
  const maxBytes = 128 * 1024 * 1024;
  if (!file.name.toLowerCase().endsWith('.glb') || file.size < 1 || file.size > maxBytes) {
    throw new TypeError('Choose a non-empty GLB no larger than 128 MiB.');
  }
  const response = await fetch(`/api/locations/drafts/${encodeURIComponent(draft.draftId)}/assets/model`, {
    method: 'PUT', credentials: 'same-origin',
    headers: {
      'x-tm-algo': '1', 'if-match': String(draft.draftRevision), 'content-type': 'model/gltf-binary',
      'x-asset-display-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  permissionChanged(response.status);
  const envelope = await response.json().catch(() => null) as { data?: AssetUploadResult; error?: { code?: string; message?: string } } | null;
  if (!response.ok || envelope?.error || !envelope?.data) {
    throw new LocationApiError(response.status, envelope?.error?.code ?? 'MODEL_UPLOAD_FAILED', envelope?.error?.message ?? 'GLB upload failed.');
  }
  return envelope.data;
}

/** The server-returned draft/asset pair is the only source of preview paths. */
export async function readDraftPlan(draftId: string, assetId: string): Promise<Blob> {
  const response = await fetch(`/api/locations/drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(assetId)}`, { credentials: 'same-origin' });
  permissionChanged(response.status);
  if (!response.ok) throw new LocationApiError(response.status, response.status === 404 ? 'ASSET_NOT_FOUND' : 'PREVIEW_FAILED', 'Floor plan preview is unavailable.');
  return response.blob();
}

/** Reads only a server-authorized exact model reference from the owned draft. */
export async function readDraftModel(draftId: string, assetId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`/api/locations/drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(assetId)}`, {
    credentials: 'same-origin', headers: { accept: 'model/gltf-binary' }, signal,
  });
  permissionChanged(response.status);
  if (!response.ok) throw new LocationApiError(response.status, response.status === 404 ? 'ASSET_NOT_FOUND' : 'MODEL_PREVIEW_FAILED', 'GLB preview is unavailable.');
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (mediaType !== 'model/gltf-binary') throw new LocationApiError(502, 'INVALID_MODEL_RESPONSE', 'Location service returned an invalid GLB preview.');
  return response.arrayBuffer();
}

export function publishLocationDraft(draft: DraftDetail): Promise<PublicationResult> {
  return jsonRequest(`/api/locations/drafts/${encodeURIComponent(draft.draftId)}/publications`, 'POST', {
    expectedDraftRevision: draft.draftRevision, expectedPublishedRevision: draft.basePublishedRevision,
  });
}

export type { DraftSummary, PublishedSummary };
