import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { FileLocationDraftRepository } from '../src/infrastructure/location-config/file-location-draft-repository.js';
import { FileRegistryMutationCoordinator } from '../src/infrastructure/location-config/file-registry-mutation-coordinator.js';
import { PostgresLocationDraftRepository } from '../src/infrastructure/postgres/location-configuration-repositories.js';
import { syncDirectory } from '../src/shared/directory-sync.js';
import { DeleteLocationDraftUseCase } from '../src/modules/location-config/use-cases/delete-location-draft.js';
import { createLocationId, parseLocationDocument } from '../src/modules/location-config/domain/location-document.js';
import { LocationConflictError, LocationDraftNotFoundError, LocationStorageUnavailableError, type LocationDraft } from '../src/modules/location-config/domain/location-records.js';

test('file removal is revision-checked, atomic and recoverable after unconfirmed directory sync', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-removal-'));
  const coordinator = new FileRegistryMutationCoordinator(join(directory, 'nodes.json'));
  let failRename = false, failDirectorySync = false;
  const operations = {
    rename: (...paths: Parameters<typeof renameSync>) => { if (failRename) throw new Error('injected rename failure'); renameSync(...paths); },
    syncDirectory: (path: string) => { if (failDirectorySync) throw new Error('injected sync failure'); syncDirectory(path); },
  };
  const repository = new FileLocationDraftRepository(directory, coordinator, operations);
  const document = parseLocationDocument({ schemaVersion: 1, locationId: createLocationId('draft-test', '00000000-0000-4000-8000-000000000001'),
    name: 'Private room', building: 'Test', visibility: 'public', widthCm: 400, heightCm: 300, outline: [[0, 0], [400, 0], [400, 300], [0, 300]], zones: [], tables: [], sensorAssignments: [] });
  const draft: LocationDraft = { draftId: '00000000-0000-4000-8000-000000000002', creatorId: 'owner', locationId: document.locationId,
    draftRevision: 1, basePublishedRevision: null, createdAt: 1, updatedAt: 1, document };
  const sibling = { ...draft, draftId: '00000000-0000-4000-8000-000000000003' };
  try {
    await repository.createDraft(draft); await repository.createDraft(sibling);
    const remove = new DeleteLocationDraftUseCase({ drafts: repository, coordinator });
    await assert.rejects(remove.execute({ creatorId: 'foreign', draftId: draft.draftId, expectedDraftRevision: 1 }), LocationDraftNotFoundError);
    await assert.rejects(remove.execute({ creatorId: 'owner', draftId: draft.draftId, expectedDraftRevision: 2 }), LocationConflictError);
    failRename = true;
    await assert.rejects(remove.execute({ creatorId: 'owner', draftId: draft.draftId, expectedDraftRevision: 1 }), LocationStorageUnavailableError);
    assert.equal((await repository.listDrafts('owner')).length, 2, 'failed rename leaves both drafts authoritative');
    failRename = false; failDirectorySync = true;
    assert.equal((await remove.execute({ creatorId: 'owner', draftId: draft.draftId, expectedDraftRevision: 1 })).durability, 'unconfirmed');
    await assert.rejects(repository.getDraftForRead('owner', draft.draftId), LocationStorageUnavailableError);
    failDirectorySync = false;
    assert.equal(await repository.getDraftForRead('owner', draft.draftId), null);
    const restarted = new FileLocationDraftRepository(directory, coordinator);
    assert.equal(await restarted.getDraftForRead('owner', draft.draftId), null);
    assert.equal((await restarted.getDraftForRead('owner', sibling.draftId))?.draftRevision, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('PostgreSQL removal reconciles a lost acknowledgement only when readback proves absence', async () => {
  const id = '00000000-0000-4000-8000-000000000002';
  const repository = new PostgresLocationDraftRepository({ async query() { throw new Error('connection lost'); } } as unknown as DataSource);
  repository.getDraft = async () => null;
  assert.deepEqual(await repository.deleteDraftWithinMutation('owner', id, 1), { kind: 'deleted', draftId: id, durability: 'confirmed' });
  repository.getDraft = async () => { throw new LocationStorageUnavailableError(); };
  await assert.rejects(repository.deleteDraftWithinMutation('owner', id, 1), LocationStorageUnavailableError);
  repository.getDraft = async () => ({ draftId: id, draftRevision: 1 } as LocationDraft);
  await assert.rejects(repository.deleteDraftWithinMutation('owner', id, 1), LocationStorageUnavailableError, 'a surviving draft cannot be reported deleted');
});
