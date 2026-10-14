import type { FurnitureType } from './location-records.js';
import { InvalidLocationDocumentError } from './location-document.js';
import type { LocationDocument } from './location-document.js';

export interface FurnitureAssetReference {
  assetId: string;
  furnitureType: FurnitureType;
}

/** Derives only furniture references; plan/model ownership provenance stays separate. */
export function furnitureAssetReferences(document: LocationDocument): FurnitureAssetReference[] {
  const byId = new Map<string, FurnitureType>();
  const add = (assetId: string | undefined, furnitureType: FurnitureType) => {
    if (!assetId) return;
    const existing = byId.get(assetId);
    if (existing && existing !== furnitureType) {
      throw new InvalidLocationDocumentError('One furniture asset cannot be used in both furniture type slots.');
    }
    byId.set(assetId, furnitureType);
  };
  const defaults = document.furnitureDefaults;
  add(defaults?.table?.assetId, 'table');
  add(defaults?.chair?.assetId, 'chair');
  for (const table of document.tables) {
    add(table.furnitureOverrides?.table?.assetId, 'table');
    add(table.furnitureOverrides?.chair?.assetId, 'chair');
  }
  return [...byId].map(([assetId, furnitureType]) => ({ assetId, furnitureType }));
}
