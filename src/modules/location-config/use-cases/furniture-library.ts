import { InvalidLocationAssetReferenceError } from '../domain/location-assets.js';
import type { FurnitureType } from '../domain/location-records.js';
import type { FurnitureLibraryStore } from '../repositories/location-storage.js';

export class FurnitureLibraryUseCase {
  constructor(private readonly store: FurnitureLibraryStore, private readonly now: () => number = Date.now) {}

  create(input: { creatorId: string; furnitureType: FurnitureType; displayName: string; bytes: Uint8Array }) {
    if (!input || typeof input.creatorId !== 'string' || input.creatorId.trim() === '' || input.creatorId.length > 256
      || (input.furnitureType !== 'table' && input.furnitureType !== 'chair')
      || typeof input.displayName !== 'string' || !(input.bytes instanceof Uint8Array)) {
      throw new TypeError('Furniture library upload is invalid.');
    }
    return this.store.createFurnitureItem({ ...input, createdAt: this.now() });
  }

  list(filter: { furnitureType?: FurnitureType; query?: string }) {
    if (filter.furnitureType !== undefined && filter.furnitureType !== 'table' && filter.furnitureType !== 'chair') {
      throw new TypeError('Furniture type is invalid.');
    }
    if (filter.query !== undefined && (filter.query.length < 1 || Array.from(filter.query).length > 128)) {
      throw new TypeError('Furniture search query is invalid.');
    }
    return this.store.listFurnitureMetadata(filter);
  }

  async read(assetId: string) {
    if (typeof assetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
      throw new InvalidLocationAssetReferenceError('The furniture asset is not available.');
    }
    const item = await this.store.readFurnitureItem(assetId);
    if (!item) throw new InvalidLocationAssetReferenceError('The furniture asset is not available.');
    return item;
  }
}
