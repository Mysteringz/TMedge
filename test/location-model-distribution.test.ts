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
  const good = await startTarget(join(root, 'web-good'), TOKEN);
  const secondGood = await startTarget(join(root, 'web-second-good'), TOKEN);
  const bad = await startTarget(join(root, 'web-bad'), WRONG_TOKEN);
  const provenance = { modelAssetId: { kind: 'upload' as const, ownerId: 'manager-a' } };
  const document = parseLocationDocument({
    schemaVersion: 1, locationId: LOCATION_ID, name: 'Room', building: 'North', visibility: 'public',
    widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    zones: [], tables: [], sensorAssignments: [], modelAssetId: metadata.assetId,
    modelTransform: { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } },
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
    await distributor.acknowledge({ draft, candidate });
    for (const target of [good, secondGood]) {
      const stored = await new FilePublishedModelStore(join(target.directory, 'published-models')).read(metadata.assetId);
      assert.ok(stored, 'each target durably stores the transferred immutable bytes');
      assert.deepEqual(stored.bytes, bytes);
      assert.equal(stored.sha256, metadata.sha256);
    }

    const partiallyUnavailable = new HttpPublishedModelDistributor([good.url, bad.url], TOKEN, 'edge-a', assets, 2_000);
    await assert.rejects(partiallyUnavailable.acknowledge({ draft, candidate }), /did not confirm|rejected model transfer/,
      'a single unacknowledged configured target makes distribution fail');
    await assert.rejects(new HttpPublishedModelDistributor([], TOKEN, 'edge-a', assets).acknowledge({ draft, candidate }),
      /No authenticated student web model target/);
  } finally {
    await Promise.all([good.close(), secondGood.close(), bad.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

async function startTarget(directory: string, token: string): Promise<{ url: string; directory: string; close(): Promise<void> }> {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: token, sessionSecret: Buffer.alloc(40, 7),
    usersPath: join(directory, 'users.json'), publishedModelsDir: join(directory, 'published-models'),
    allowedDomains: [], signupOpen: false, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((resolve) => web.server.listen(0, '127.0.0.1', resolve));
  const address = web.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    directory,
    async close() {
      web.server.closeAllConnections();
      await web.dispose();
      await new Promise<void>((resolve) => web.server.close(() => resolve()));
    },
  };
}

function makeGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}}', 'utf8');
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
