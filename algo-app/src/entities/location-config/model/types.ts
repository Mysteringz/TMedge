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
  shape?: TableShape; rect?: Rect; seatRadiusCm?: number; furnitureOverrides?: FurnitureSlots;
}
export type FurnitureType = 'table' | 'chair';
export interface FurnitureAssignment { assetId: string; scale: number; yawDeg: number; elevationM: number }
export interface FurnitureSlots { table?: FurnitureAssignment; chair?: FurnitureAssignment }
export interface FurnitureLibraryItem { assetId: string; type: FurnitureType; displayName: string }
export interface SensorAssignment {
  uid: string;
  pose: { x: number; y: number; heightCm: number; yawDeg: number; mirror: boolean };
  owns: string[];
}
export interface EligibleSensor {
  uid: string; label: string; simulated: boolean; rgb: boolean; detector: 'node' | 'edge';
  /** Live pose is present only for an eligible sensor already assigned to this location. */
  pose: SensorAssignment['pose'] | null;
}
export interface EligibleSensorsResponse { locationId: string; sensors: EligibleSensor[] }
export interface ProposedSensor { uid: string; pose: SensorAssignment['pose'] }
export interface SensorSeatCoverageCount { uid: string; coveredSeats: number }
export interface TableCoverageSuggestion {
  tableId: string; coveredBy: string[]; suggestedOwner: string | null;
  seatCoverage: { totalSeats: number; coveredSeats: number; bySensor: SensorSeatCoverageCount[] };
}
export interface CoverageSuggestionResponse { locationId: string; suggestions: TableCoverageSuggestion[] }
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
  proceduralRoom?: 'simple-rectangle-v1';
  furnitureDefaults?: FurnitureSlots;
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
  /** True only when this exact asset reference still equals the pinned published base slot. */
  fromPublishedBase: boolean;
  /** Sanitized original basename for uploaded models only; absent for legacy/older assets. */
  displayName?: string;
}
export interface DraftWriteResult {
  draftId: string; locationId: string; draftRevision: number; basePublishedRevision: number | null;
  currentPublishedRevision?: number | null;
  locationRemoved?: boolean;
  visibility: 'public' | 'console'; durability: 'confirmed' | 'unconfirmed';
  legacyBaseAvailable: boolean; document: LocationDocument;
}
export interface DraftDetail extends DraftWriteResult {
  updatedAt?: number;
  assetCapabilities?: Partial<Record<'planAssetId' | 'modelAssetId', AssetCapability>>;
}
export interface LocationList { published: PublishedSummary[]; drafts: DraftSummary[] }
export interface AssetUploadResult { assetId: string; mediaType: string; sha256: string; byteLength: number; draftRevision: number; durability: 'confirmed' | 'unconfirmed'; displayName?: string }
export interface PublicationResult { kind: 'committed'; locationId: string; publishedRevision: number; registryRevision: number; durability: 'confirmed' | 'unconfirmed'; acknowledgement: 'received' | 'reconciled' }
