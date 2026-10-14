import type { AssetCapability, LocationDocument } from '../../../entities/location-config/model/types.ts';
import { isSimpleRoomRectangleOutline, SIMPLE_ROOM_SOURCE } from '../../../../../src/shared/simple-room-geometry.ts';

export type LocationRoomSource = 'generated' | 'custom' | 'legacy-static' | '2d';

/** Returns the persisted source without inferring a source from layout contents. */
export function locationRoomSource(document: LocationDocument, capability?: AssetCapability): LocationRoomSource {
  if (document.proceduralRoom === SIMPLE_ROOM_SOURCE) return 'generated';
  if (document.modelAssetId) return capability?.source === 'legacy-static' ? 'legacy-static' : 'custom';
  return '2d';
}

/** Whether this document can use the fixed rectangular generated-room shell. */
export function canSelectGeneratedRoom(document: LocationDocument): boolean {
  return isSimpleRoomRectangleOutline(document.outline, document.widthCm, document.heightCm);
}

/** Explicitly selects the generated source and removes the active model reference/alignment. */
export function selectGeneratedRoom(document: LocationDocument): LocationDocument | null {
  if (!canSelectGeneratedRoom(document)) return null;
  const next = { ...document, proceduralRoom: SIMPLE_ROOM_SOURCE };
  delete next.modelAssetId;
  delete next.modelTransform;
  return next;
}

/** Explicitly selects the existing 2D-only publication mode. */
export function selectTwoDimensional(document: LocationDocument, capability?: AssetCapability): LocationDocument | null {
  if (capability?.source === 'legacy-static') return null;
  const next = { ...document };
  delete next.proceduralRoom;
  delete next.modelAssetId;
  delete next.modelTransform;
  return next;
}

/** A confirmation is required whenever the explicit transition removes model state. */
export function requiresModelClearConfirmation(document: LocationDocument): boolean {
  return !!document.modelAssetId || !!document.modelTransform;
}
