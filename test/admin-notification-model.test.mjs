import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WINDOW_MS, mergeSeen, markNotificationsRead, notificationStorageKey, pruneSeen } from '../algo-app/src/entities/operation-notification/model.ts';

test('active read state renews without new alert; failed-source bookkeeping never renews event records', () => {
  const now = WINDOW_MS + 1000, active = { id: 'sensor:offline:100', kind: 'sensor', classification: 'active', label: 'Sensor', outcome: 'Offline', resourceId: 's', occurredAt: 100, href: '/console' };
  const old = [{ id: active.id, at: 10, read: true }];
  const merged = mergeSeen(old, [active], now); assert.equal(merged.entries[0].read, true); assert.equal(merged.entries[0].at, now); assert.equal(merged.fresh.length, 0);
  const failed = mergeSeen(old, [active], now, new Set(['training'])); assert.ok(!failed.entries.some((row) => row.read));
});

test('username scoped bounded7day read/seen records validate and prune corrupt storage', () => {
  const now = WINDOW_MS + 1000;
  assert.notEqual(notificationStorageKey('alice'), notificationStorageKey('bob'));
  const values = Array.from({ length: 250 }, (_, index) => ({ id: `${index}`, at: now - index, read: true }));
  values.push({ id: 'expired', at: 0, read: true }, { id: 'future', at: now + 1, read: true }, { id: 'invalid', at: now, read: 'yes' }, { id: 'x'.repeat(1025), at: now, read: false });
  const records = pruneSeen(values, now); assert.equal(records.length, 200); assert.ok(records.every((row) => row.id.length < 10));
  assert.deepEqual(pruneSeen({ injected: true }, now), []);
});
test('same IDs do not replay, new outcome IDs appear once and read flags persist through polls', () => {
  const item = { id: 'job:completed:100', kind: 'training', resourceId: 'job', label: 'Job', outcome: 'Completed', occurredAt: 100, href: '/train' };
  const baseline = mergeSeen([], [item], 100); assert.equal(baseline.fresh.length, 1);
  const read = markNotificationsRead(baseline.entries, [item.id], 101); assert.equal(read[0].read, true);
  const repeat = mergeSeen(read, [item], 102); assert.equal(repeat.fresh.length, 0); assert.equal(repeat.entries[0].read, true);
  const changed = { ...item, id: 'job:failed:200', outcome: 'Failed' }; const next = mergeSeen(repeat.entries, [item, changed], 200);
  assert.deepEqual(next.fresh.map((row) => row.id), [changed.id]); assert.equal(mergeSeen(next.entries, [item, changed], 201).fresh.length, 0);
});
