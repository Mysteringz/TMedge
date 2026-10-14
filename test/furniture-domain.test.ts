import assert from 'node:assert/strict';
import test from 'node:test';
import { furnitureAssetReferences } from '../src/modules/location-config/domain/furniture-assets.js';
import { locationAssetReferences, parseLocationAssetProvenance } from '../src/modules/location-config/domain/location-assets.js';
import { InvalidLocationDocumentError, parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';

const TABLE_ASSET = '11111111-1111-4111-8111-111111111111';
const CHAIR_ASSET = '22222222-2222-4222-8222-222222222222';

function document(fields: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    locationId: 'location-furniture-test',
    name: 'Furniture room', building: 'North', widthCm: 400, heightCm: 300,
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [{ id: 'zone-1', name: 'Room', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
    tables: [{
      id: 'table-1', name: 'Table 1', zoneId: 'zone-1', capacity: 1,
      shape: { type: 'rect', x: 100, y: 100, width: 80, height: 60 },
      seats: [{ id: 'seat-1', x: 120, y: 80, neighbors: [] }],
    }],
    sensorAssignments: [],
    ...fields,
  };
}

test('schema v1 parses complete furniture defaults and full table overrides', () => {
  const parsed = parseLocationDocument(document({
    furnitureDefaults: { table: { assetId: TABLE_ASSET.toUpperCase(), scale: 0.01, yawDeg: 360, elevationM: 10 } },
    tables: [{
      id: 'table-1', name: 'Table 1', zoneId: 'zone-1', capacity: 1,
      shape: { type: 'rect', x: 100, y: 100, width: 80, height: 60 },
      seats: [{ id: 'seat-1', x: 120, y: 80, neighbors: [] }],
      furnitureOverrides: { chair: { assetId: CHAIR_ASSET, scale: 1, yawDeg: -360, elevationM: 0 } },
    }],
  }));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.furnitureDefaults?.table?.assetId, TABLE_ASSET);
  assert.deepEqual(parsed.tables[0]!.furnitureOverrides, { chair: { assetId: CHAIR_ASSET, scale: 1, yawDeg: -360, elevationM: 0 } });
});

test('furniture parser rejects null, empty, partial, unknown, and out-of-range assignments', () => {
  const valid = { table: { assetId: TABLE_ASSET, scale: 1, yawDeg: 0, elevationM: 0 } };
  for (const furnitureDefaults of [
    null,
    {},
    { table: null },
    { table: { assetId: TABLE_ASSET, scale: 1, yawDeg: 0 } },
    { table: { ...valid.table, creatorId: 'someone' } },
    { table: { ...valid.table, scale: 0.009 } },
    { table: { ...valid.table, yawDeg: 360.1 } },
    { table: { ...valid.table, elevationM: -0.01 } },
    { sofa: valid.table },
  ]) {
    assert.throws(() => parseLocationDocument(document({ furnitureDefaults })), InvalidLocationDocumentError);
  }
  assert.throws(() => parseLocationDocument(document({ tables: [{
    id: 'table-1', name: 'Table 1', zoneId: 'zone-1', capacity: 1,
    shape: { type: 'rect', x: 100, y: 100, width: 80, height: 60 },
    seats: [{ id: 'seat-1', x: 120, y: 80, neighbors: [] }], furnitureOverrides: {},
  }] })), InvalidLocationDocumentError);
});

test('furniture references are separately derived and deduplicated without changing plan/model provenance', () => {
  const parsed = parseLocationDocument(document({
    furnitureDefaults: { table: { assetId: TABLE_ASSET, scale: 1, yawDeg: 0, elevationM: 0 } },
    tables: [{
      id: 'table-1', name: 'Table 1', zoneId: 'zone-1', capacity: 1,
      shape: { type: 'rect', x: 100, y: 100, width: 80, height: 60 },
      seats: [{ id: 'seat-1', x: 120, y: 80, neighbors: [] }],
      furnitureOverrides: {
        table: { assetId: TABLE_ASSET, scale: 2, yawDeg: 45, elevationM: 0.2 },
        chair: { assetId: CHAIR_ASSET, scale: 1, yawDeg: 0, elevationM: 0 },
      },
    }],
  }));
  assert.deepEqual(furnitureAssetReferences(parsed), [
    { assetId: TABLE_ASSET, furnitureType: 'table' },
    { assetId: CHAIR_ASSET, furnitureType: 'chair' },
  ]);
  assert.deepEqual(locationAssetReferences(parsed), [], 'the pre-existing plan/model reference helper remains isolated');
  assert.deepEqual(parseLocationAssetProvenance({}, parsed), {}, 'furniture carries no client or server owner provenance');
  assert.throws(() => parseLocationAssetProvenance({ furnitureDefaults: { assetId: TABLE_ASSET } }, parsed), /unknown slot/);
  const incompatible = parseLocationDocument(document({
    furnitureDefaults: {
      table: { assetId: TABLE_ASSET, scale: 1, yawDeg: 0, elevationM: 0 },
      chair: { assetId: TABLE_ASSET, scale: 1, yawDeg: 0, elevationM: 0 },
    },
  }));
  assert.throws(() => furnitureAssetReferences(incompatible), InvalidLocationDocumentError);
});
