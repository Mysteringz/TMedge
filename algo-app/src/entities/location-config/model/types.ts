export type Point = [number, number];
export interface Rect { x: number; y: number; width: number; height: number }
export type TableShape =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'circle'; cx: number; cy: number; radius: number }
  | { type: 'polygon'; points: Point[] };
export interface Seat { id: string; x: number; y: number; neighbors: string[]; side?: 'L' | 'R' | 'T' | 'B'; index?: number }
export interface Zone { id: string; name: string; polygon: Point[] }
export interface Table {
  id: string; name: string; zoneId: string; capacity: number; seats: Seat[];
  shape?: TableShape; rect?: Rect; seatRadiusCm?: number;
}
export interface SensorAssignment {
  uid: string;
  pose: { x: number; y: number; heightCm: number; yawDeg: number; mirror: boolean };
  owns: string[];
}
export interface ModelTransform {
  scale: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  positionM: { x: number; y: number; z: number };
}
/** Authored DTO. The server adds schemaVersion, locationId, visibility and provenance itself. */
export interface LocationDocument {
  name: string; building: string; widthCm: number; heightCm: number; outline: Point[];
  zones: Zone[]; tables: Table[]; sensorAssignments: SensorAssignment[];
  planAssetId?: string; modelAssetId?: string; modelTransform?: ModelTransform;
}
export interface PublishedSummary {
  locationId: string; name: string; building: string; visibility: 'public' | 'console'; activeRevision: number;
}
export interface DraftSummary {
  draftId: string; locationId: string; name: string; building: string; visibility: 'public' | 'console';
  draftRevision: number; basePublishedRevision: number | null; updatedAt: number;
}
export interface AssetCapability {
  source: 'upload' | 'legacy-static'; previewAvailable: boolean; alignmentEditable: boolean; replaceWithUpload: boolean;
}
export interface DraftDetail {
  draftId: string; locationId: string; draftRevision: number; basePublishedRevision: number | null;
  visibility: 'public' | 'console'; durability?: 'confirmed' | 'unconfirmed'; updatedAt?: number;
  legacyBaseAvailable: boolean; document: LocationDocument;
  assetCapabilities?: Partial<Record<'planAssetId' | 'modelAssetId', AssetCapability>>;
}
export interface LocationList { published: PublishedSummary[]; drafts: DraftSummary[] }
export interface AssetUploadResult { assetId: string; mediaType: string; sha256: string; byteLength: number; draftRevision: number; durability: 'confirmed' | 'unconfirmed' }
export interface PublicationResult { kind: 'committed'; locationId: string; publishedRevision: number; registryRevision: number; durability: 'confirmed' | 'unconfirmed'; acknowledgement: 'received' | 'reconciled' }
