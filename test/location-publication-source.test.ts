import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublishedDraft, parsePublicationSource } from '../src/modules/location-config/domain/publication-source.js';
import type { LocationDraft, PublishedLocationRevision } from '../src/modules/location-config/domain/location-records.js';

const draftId = '00000000-0000-4000-8000-000000000001';

test('publication receipts reject malformed and forward-pointing source revisions', () => {
  const source = { draftId, draftRevision: 2, basePublishedRevision: 1 };
  assert.deepEqual(parsePublicationSource(source, 3), source);
  assert.equal(parsePublicationSource(undefined), undefined);
  assert.equal(parsePublicationSource(null), undefined);
  for (const invalid of [{ ...source, draftId: '../private' }, { ...source, draftRevision: 0 },
    { ...source, basePublishedRevision: 3 }, { ...source, basePublishedRevision: -1 }, { ...source, unexpected: true }]) {
    assert.throws(() => parsePublicationSource(invalid, 3), /Publication source/);
  }
});

test('draft visibility matches the exact creator, location, draft ID and draft revision in immutable history', () => {
  const draft = { draftId, draftRevision: 2, creatorId: 'owner', locationId: 'room' } as LocationDraft;
  const revision = { locationId: 'room', createdBy: 'owner', sourceDraft: { draftId, draftRevision: 2, basePublishedRevision: null } } as PublishedLocationRevision;
  assert.equal(isPublishedDraft(draft, [revision]), true);
  assert.equal(isPublishedDraft(draft, []), false);
  for (const changed of [{ ...draft, creatorId: 'other' }, { ...draft, locationId: 'other' },
    { ...draft, draftId: '00000000-0000-4000-8000-000000000002' }, { ...draft, draftRevision: 3 }]) {
    assert.equal(isPublishedDraft(changed, [revision]), false);
  }
  assert.equal(isPublishedDraft(draft, [{ ...revision, sourceDraft: undefined }]), false, 'legacy publications do not guess the source draft');
});
