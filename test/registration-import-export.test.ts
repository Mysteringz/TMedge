import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistrationImportExport } from '../src/modules/registration/application/registration-import-export.js';
import type { RegistryNodeRecord, RegistryRepository } from '../src/modules/registration/repositories/registry-repository.js';
import { buildRegistry, type Registry } from '../src/edge/registry.js';
import { nodesJson, siteJson } from './fixtures.js';

class MemoryRegistryRepository implements RegistryRepository {
  nodes = new Map<string, RegistryNodeRecord>();
  writes = 0;

  async listNodes(): Promise<RegistryNodeRecord[]> { return [...this.nodes.values()]; }

  async importNodes(nodes: readonly RegistryNodeRecord[]): Promise<{ inserted: number; unchanged: number }> {
    this.writes += 1;
    let inserted = 0;
    let unchanged = 0;
    for (const node of nodes) {
      const existing = this.nodes.get(node.uid);
      if (existing) {
        assert.deepEqual(existing, node);
        unchanged += 1;
      } else {
        this.nodes.set(node.uid, structuredClone(node));
        inserted += 1;
      }
    }
    return { inserted, unchanged };
  }
}

test('registration dry run reports duplicate and missing references without writes', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const json = nodesJson();
  json.nodes.push(structuredClone(json.nodes[0]!));
  json.nodes[0]!.floor = 'missing-floor';
  json.nodes[0]!.owns = ['missing-table'];

  const preview = await service.preview(siteJson(), json);
  assert.equal(preview.valid, false);
  assert.ok(preview.diagnostics.some((item) => item.code === 'duplicate_uid'));
  assert.ok(preview.diagnostics.some((item) => item.code === 'missing_floor'));
  assert.ok(preview.diagnostics.some((item) => item.code === 'missing_table'));
  const dryRun = await service.import(siteJson(), json, { dryRun: true });
  assert.equal(dryRun.inserted, 0);
  assert.equal(repository.writes, 0);
});

test('validated import is insert-only and export/load preserve placement and null placement', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const json = nodesJson();
  json.nodes[0]!.uid = 'aa:00:00:00:00:01';
  json.nodes[0]!.detector = 'edge';
  json.nodes.push({ uid: 'aa:00:00:00:00:02', label: 'unplaced', owns: [] });

  const preview = await service.import(siteJson(), json, { dryRun: true });
  assert.equal(preview.valid, true);
  assert.equal(preview.insertable, json.nodes.length);
  assert.equal(repository.writes, 0);

  const imported = await service.import(siteJson(), json);
  assert.equal(imported.inserted, json.nodes.length);
  const repeated = await service.import(siteJson(), json);
  assert.equal(repeated.inserted, 0);
  assert.equal(repeated.unchanged, json.nodes.length);

  const exported = await service.export(siteJson());
  const exportedUnplaced = exported.nodes.find((node) => node.uid === 'aa:00:00:00:00:02');
  assert.ok(exportedUnplaced);
  assert.equal('floor' in exportedUnplaced, false);
  assert.equal('pose' in exportedUnplaced, false);
  const reloaded = await service.loadRegistry(siteJson());
  assert.equal(reloaded.nodes.get('aa:00:00:00:00:01')?.floorId, json.nodes[0]!.floor);
  assert.equal(reloaded.nodes.get('aa:00:00:00:00:02')?.floorId, null);
  assert.equal(reloaded.nodes.get('aa:00:00:00:00:02')?.pose, null);
  assert.equal(reloaded.nodes.get('aa:00:00:00:00:01')?.detector, 'edge');
  assert.equal(exported.nodes.find((node) => node.uid === 'aa:00:00:00:00:01')?.detector, 'edge');
  assert.deepEqual(registrySummary(reloaded), registrySummary(buildRegistry(siteJson(), json)));
});

test('registry validator reports invalid coverage and rejects the import', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const json = nodesJson();
  json.nodes[0]!.pose = { x: 20, y: 20, heightCm: 350, yawDeg: 0, mirror: false };
  const preview = await service.preview(siteJson(), json);
  assert.equal(preview.valid, false);
  assert.ok(preview.diagnostics.some((item) => item.code === 'invalid_coverage'));
  assert.equal(repository.writes, 0);
});

test('repeat import reports changed existing data as a conflict and preserves the committed row', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const json = nodesJson();
  json.nodes[0]!.uid = 'aa:00:00:00:00:11';
  assert.equal((await service.import(siteJson(), json)).inserted, json.nodes.length);
  json.nodes[0]!.label = 'Changed label';

  const result = await service.import(siteJson(), json);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'database_conflict'));
  assert.equal(repository.nodes.get('aa:00:00:00:00:11')?.label, 'Above M1 (sim)');
  assert.equal(repository.writes, 1);
});

test('preview and import reject a fresh UID claiming an existing owner table without writes', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const committed = nodesJson();
  assert.equal((await service.import(siteJson(), committed)).valid, true);
  const incoming = { nodes: [structuredClone(committed.nodes[0]!)] };
  incoming.nodes[0]!.uid = 'aa:00:00:00:00:99';
  assert.doesNotThrow(() => buildRegistry(siteJson(), incoming), 'incoming JSON is valid in isolation');

  const before = structuredClone([...repository.nodes.values()]);
  const preview = await service.preview(siteJson(), incoming);
  assert.equal(preview.valid, false);
  assert.ok(preview.diagnostics.some((item) => item.code === 'database_conflict' && /already owned/.test(item.message)));
  const dryRun = await service.import(siteJson(), incoming, { dryRun: true });
  const apply = await service.import(siteJson(), incoming);
  assert.equal(dryRun.inserted, 0);
  assert.equal(apply.valid, false);
  assert.equal(apply.inserted, 0);
  assert.equal(repository.writes, 1, 'only initial committed registrations are written');
  assert.deepEqual([...repository.nodes.values()], before);
});

test('merged validation deduplicates an unchanged UID while allowing a fresh unplaced node', async () => {
  const repository = new MemoryRegistryRepository();
  const service = new RegistrationImportExport(repository);
  const committed = nodesJson();
  await service.import(siteJson(), committed);
  const incoming = { nodes: [structuredClone(committed.nodes[0]!), { uid: 'aa:00:00:00:00:99', label: 'New unplaced' }] };
  const preview = await service.preview(siteJson(), incoming);
  assert.equal(preview.valid, true);
  assert.equal(preview.unchanged, 1);
  assert.equal(preview.insertable, 1);
  assert.deepEqual(preview.diagnostics, []);
  const result = await service.import(siteJson(), incoming);
  assert.equal(result.inserted, 1);
  assert.equal(result.unchanged, 1);
  assert.equal((await service.loadRegistry(siteJson())).nodes.size, committed.nodes.length + 1);
});

function registrySummary(registry: Registry): unknown {
  return {
    site: registry.site,
    floors: registry.floors,
    nodes: [...registry.nodes.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
    tables: [...registry.tables.keys()].sort(),
    seatIndex: [...registry.seatIndex.entries()]
      .map(([id, value]) => ({ id, seat: value.seat, tableId: value.table.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
