import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileLocationAssetStore } from '../src/infrastructure/location-config/file-location-asset-store.js';
import { HttpPublishedModelDistributor } from '../src/infrastructure/location-config/http-published-model-distributor.js';
import { parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import type { LocationDraft, PublishedLocationRevision } from '../src/modules/location-config/domain/location-records.js';
import type { FurnitureLibraryStore, LocationAssetStore } from '../src/modules/location-config/repositories/location-storage.js';
import { createWebApp } from '../src/web/main.js';
import { FilePublishedModelStore } from '../src/web/published-model-store.js';

const TOKEN = 'web-transfer-test-token-0123456789';
const WRONG_TOKEN = 'another-web-transfer-token-012345';
const LOCATION_ID = 'location_edge-a_00000000-0000-4000-8000-000000000001';

test('published model distributor waits for exact durable acknowledgements from every web target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'location-model-transfer-'));
  const bytes = makeGlb();
  const assets = new FileLocationAssetStore(join(root, 'edge-data'));
  const metadata = await assets.put('manager-a', 'model', 'model/gltf-binary', bytes);
  const furniture = await assets.createFurnitureItem({ creatorId: 'other-uploader', furnitureType: 'table', displayName: 'Shared table.glb', bytes, createdAt: 4 });
  const tableAssignment = { assetId: furniture.assetId, scale: 1.25, yawDeg: 35, elevationM: 0.04 };
  const good = await startTarget(join(root, 'web-good'), TOKEN);
  const secondGood = await startTarget(join(root, 'web-second-good'), TOKEN);
  const bad = await startTarget(join(root, 'web-bad'), WRONG_TOKEN);
  const provenance = { modelAssetId: { kind: 'upload' as const, ownerId: 'manager-a' } };
  const document = parseLocationDocument({
    schemaVersion: 1, locationId: LOCATION_ID, name: 'Room', building: 'North', visibility: 'public',
    widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    sensorAssignments: [], modelAssetId: metadata.assetId,
    modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
    furnitureDefaults: { table: tableAssignment },
    tables: [{
      id: 'ROOM-TABLE', name: 'Room table', zoneId: 'zone-a', capacity: 1,
      shape: { type: 'rect', x: 100, y: 100, width: 100, height: 80 },
      seats: [{ id: 'ROOM-SEAT', x: 150, y: 200, neighbors: [] }],
      furnitureOverrides: { table: tableAssignment },
    }],
    zones: [{ id: 'zone-a', name: 'Room', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
  });
  const draft: LocationDraft = {
    draftId: '00000000-0000-4000-8000-000000000002', creatorId: 'manager-a', locationId: LOCATION_ID,
    draftRevision: 2, basePublishedRevision: null, createdAt: 1, updatedAt: 2, document, assetProvenance: provenance,
  };
  const candidate: PublishedLocationRevision = {
    locationId: LOCATION_ID, revision: 1, createdBy: 'manager-a', createdAt: 3, document, assetProvenance: provenance,
  };
  try {
    const distributor = new HttpPublishedModelDistributor([good.url, secondGood.url], TOKEN, 'edge-a', assets, 2_000);
    await distributor.acknowledge({ draft, candidate, basePublishedRevision: null });
    for (const target of [good, secondGood]) {
      const stored = await new FilePublishedModelStore(join(target.directory, 'published-models')).read(metadata.assetId);
      assert.ok(stored, 'each target durably stores the transferred immutable bytes');
      assert.deepEqual(stored.bytes, bytes);
      assert.equal(stored.sha256, metadata.sha256);
      const shared = await new FilePublishedModelStore(join(target.directory, 'published-models')).read(furniture.assetId);
      assert.ok(shared, 'the furniture uploader is not required to be the publishing model owner');
      assert.deepEqual(shared.bytes, bytes);
      assert.equal(shared.sha256, furniture.sha256);
      assert.equal(target.transferCount(), 2, 'room model plus the deduplicated default/override furniture ID are transferred once each');
    }

    const otherDocument = parseLocationDocument({
      schemaVersion: 1, locationId: 'location_edge-b_00000000-0000-4000-8000-000000000004', name: 'Other room', building: 'South', visibility: 'public',
      widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
      zones: [], tables: [], sensorAssignments: [], furnitureDefaults: { table: tableAssignment },
    });
    const otherCandidate: PublishedLocationRevision = {
      locationId: otherDocument.locationId, revision: 1, createdBy: 'manager-b', createdAt: 5, document: otherDocument, assetProvenance: {},
    };
    const otherDraft: LocationDraft = {
      ...draft, draftId: '00000000-0000-4000-8000-000000000003', locationId: otherDocument.locationId,
      creatorId: 'manager-b', document: otherDocument, assetProvenance: {},
    };
    await distributor.acknowledge({ draft: otherDraft, candidate: otherCandidate, basePublishedRevision: null });
    assert.equal(good.transferCount(), 3, 'the same global furniture ID is acknowledged idempotently across another location ID');
    assert.equal(secondGood.transferCount(), 3);

    const partiallyUnavailable = new HttpPublishedModelDistributor([good.url, bad.url], TOKEN, 'edge-a', assets, 2_000);
    await assert.rejects(partiallyUnavailable.acknowledge({ draft, candidate, basePublishedRevision: null }), /did not confirm|rejected GLB asset transfer/,
      'a single unacknowledged configured target makes distribution fail');
    await assert.rejects(new HttpPublishedModelDistributor([], TOKEN, 'edge-a', assets).acknowledge({ draft, candidate, basePublishedRevision: null }),
      /No authenticated student web asset target/);

    const priorGoodCount = good.transferCount();
    const badFurnitureStore = {
      read: assets.read.bind(assets),
      readFurnitureItem: async (assetId: string) => {
        const stored = await assets.readFurnitureItem(assetId);
        return stored ? { ...stored, bytes: makeGlb('changed') } : null;
      },
    } as LocationAssetStore & Pick<FurnitureLibraryStore, 'readFurnitureItem'>;
    await assert.rejects(new HttpPublishedModelDistributor([good.url], TOKEN, 'edge-a', badFurnitureStore, 2_000)
      .acknowledge({ draft, candidate, basePublishedRevision: null }), /inconsistent with its immutable metadata/);
    assert.equal(good.transferCount(), priorGoodCount, 'invalid bytes in any asset are detected before any target transfer starts');
  } finally {
    await Promise.all([good.close(), secondGood.close(), bad.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('published model distributor bounds large GLB reads and target fan-out after complete preflight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'location-model-bounded-transfer-'));
  const modelBytes = makeLargeGlb('large-room');
  const tableBytes = makeLargeGlb('large-table');
  const chairBytes = makeLargeGlb('large-chair');
  const backing = new FileLocationAssetStore(join(root, 'edge-data'));
  const model = await backing.put('manager-a', 'model', 'model/gltf-binary', modelBytes);
  const table = await backing.createFurnitureItem({ creatorId: 'uploader-a', furnitureType: 'table', displayName: 'Table.glb', bytes: tableBytes, createdAt: 1 });
  const chair = await backing.createFurnitureItem({ creatorId: 'uploader-b', furnitureType: 'chair', displayName: 'Chair.glb', bytes: chairBytes, createdAt: 1 });
  const document = parseLocationDocument({
    schemaVersion: 1, locationId: LOCATION_ID, name: 'Large room', building: 'North', visibility: 'public',
    widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [], tables: [], sensorAssignments: [], modelAssetId: model.assetId,
    modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
    furnitureDefaults: {
      table: { assetId: table.assetId, scale: 1, yawDeg: 0, elevationM: 0 },
      chair: { assetId: chair.assetId, scale: 1, yawDeg: 0, elevationM: 0 },
    },
  });
  const provenance = { modelAssetId: { kind: 'upload' as const, ownerId: 'manager-a' } };
  const draft: LocationDraft = {
    draftId: '00000000-0000-4000-8000-000000000002', creatorId: 'manager-a', locationId: LOCATION_ID,
    draftRevision: 1, basePublishedRevision: null, createdAt: 1, updatedAt: 1, document, assetProvenance: provenance,
  };
  const candidate: PublishedLocationRevision = {
    locationId: LOCATION_ID, revision: 1, createdBy: 'manager-a', createdAt: 2, document, assetProvenance: provenance,
  };
  const readBytes = new Map([[model.assetId, modelBytes], [table.assetId, tableBytes], [chair.assetId, chairBytes]]);
  let activeReads = 0, maximumConcurrentReads = 0;
  const read = async (ownerId: string, assetId: string) => {
    assert.equal(ownerId, 'manager-a');
    activeReads++;
    maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const stored = await backing.read(ownerId, assetId);
      return stored && readBytes.has(assetId) ? { ...stored, bytes: readBytes.get(assetId)! } : stored;
    } finally { activeReads--; }
  };
  const readFurnitureItem = async (assetId: string) => {
    activeReads++;
    maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const stored = await backing.readFurnitureItem(assetId);
      return stored && readBytes.has(assetId) ? { ...stored, bytes: readBytes.get(assetId)! } : stored;
    } finally { activeReads--; }
  };
  const assets = { read, readFurnitureItem } as LocationAssetStore & Pick<FurnitureLibraryStore, 'readFurnitureItem'>;
  const originalFetch = globalThis.fetch;
  let activeTransfers = 0, maximumConcurrentTransfers = 0, transferredBytesInFlight = 0, maximumTransferBytesInFlight = 0, transferCount = 0;
  globalThis.fetch = async (input, init) => {
    activeTransfers++;
    const body = init?.body;
    assert.ok(Buffer.isBuffer(body));
    const bodyBytes = (body as Buffer).byteLength;
    transferredBytesInFlight += bodyBytes;
    maximumConcurrentTransfers = Math.max(maximumConcurrentTransfers, activeTransfers);
    maximumTransferBytesInFlight = Math.max(maximumTransferBytesInFlight, transferredBytesInFlight);
    transferCount++;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3));
      const assetId = new URL(String(input)).pathname.split('/').at(-1)!;
      const headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, assetId, sha256: headers.get('x-tm-sha256') }), { status: 201 });
    } finally { activeTransfers--; transferredBytesInFlight -= bodyBytes; }
  };
  try {
    await new HttpPublishedModelDistributor(['https://target-a.example', 'https://target-b.example'], TOKEN, 'edge-a', assets)
      .acknowledge({ draft, candidate, basePublishedRevision: null });
    assert.equal(maximumConcurrentReads, 1, 'asset source reads are sequential during both the all-source preflight and second pass');
    assert.equal(maximumConcurrentTransfers, 1, 'the target-by-asset matrix is delivered sequentially');
    assert.equal(maximumTransferBytesInFlight, Math.max(modelBytes.byteLength, tableBytes.byteLength, chairBytes.byteLength),
      'live transfer body memory never holds more than one large asset at once');
    assert.equal(transferCount, 6, 'three unique assets reach each of two configured targets');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('published model distributor rejects malformed, mismatched, or extended acknowledgements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'location-model-invalid-ack-'));
  const bytes = makeGlb();
  const assets = new FileLocationAssetStore(join(root, 'edge-data'));
  const metadata = await assets.put('manager-a', 'model', 'model/gltf-binary', bytes);
  const document = parseLocationDocument({
    schemaVersion: 1, locationId: LOCATION_ID, name: 'Room', building: 'North', visibility: 'public',
    widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [], tables: [], sensorAssignments: [], modelAssetId: metadata.assetId,
    modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
  });
  const provenance = { modelAssetId: { kind: 'upload' as const, ownerId: 'manager-a' } };
  const draft: LocationDraft = {
    draftId: '00000000-0000-4000-8000-000000000002', creatorId: 'manager-a', locationId: LOCATION_ID,
    draftRevision: 1, basePublishedRevision: null, createdAt: 1, updatedAt: 1, document, assetProvenance: provenance,
  };
  const candidate: PublishedLocationRevision = {
    locationId: LOCATION_ID, revision: 1, createdBy: 'manager-a', createdAt: 2, document, assetProvenance: provenance,
  };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const originalFetch = globalThis.fetch;
  try {
    const invalidBodies = [
      '{malformed',
      JSON.stringify({ ok: true, assetId: '00000000-0000-4000-8000-000000000099', sha256: digest }),
      JSON.stringify({ ok: true, assetId: metadata.assetId, sha256: '0'.repeat(64) }),
      JSON.stringify({ ok: true, assetId: metadata.assetId, sha256: digest, locationId: LOCATION_ID }),
    ];
    for (const body of invalidBodies) {
      globalThis.fetch = async () => new Response(body, { status: 201 });
      await assert.rejects(
        new HttpPublishedModelDistributor(['https://target.example'], TOKEN, 'edge-a', assets)
          .acknowledge({ draft, candidate, basePublishedRevision: null }),
        /invalid GLB asset acknowledgement|did not confirm the exact GLB asset bytes/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

async function startTarget(directory: string, token: string): Promise<{ url: string; directory: string; transferCount(): number; close(): Promise<void> }> {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: token, sessionSecret: Buffer.alloc(40, 7),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: [], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  let transfers = 0;
  web.server.on('request', (request) => { if (request.url?.startsWith('/api/edge/location-assets/')) transfers++; });
  const address = web.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    directory,
    transferCount: () => transfers,
    async close() {
      web.server.closeAllConnections();
      await web.dispose();
      await new Promise<void>((resolve) => web.server.close(() => resolve()));
    },
  };
}

function makeGlb(generator = 'fixture'): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator } }), 'utf8');
  const length = Math.ceil(json.byteLength / 4) * 4;
  const output = Buffer.alloc(20 + length, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}

function makeLargeGlb(generator: string): Buffer {
  const targetChunkBytes = 4 * 1024 * 1024;
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator } }), 'utf8');
  const chunkBytes = Math.ceil(targetChunkBytes / 4) * 4;
  const output = Buffer.alloc(20 + chunkBytes, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(chunkBytes, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}
