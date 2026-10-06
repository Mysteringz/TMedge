import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DataSource } from 'typeorm';
import { PostgresStudentActivityRepository } from '../src/infrastructure/postgres/student-activity-repository.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import type { StudentActivityEvent } from '../src/modules/student-auth/repositories/student-activity-repository.js';

function repository(query: (sql: string, values?: unknown[]) => Promise<unknown>): PostgresStudentActivityRepository {
  // The adapter depends only on query; this test boundary deliberately replaces external database I/O.
  return new PostgresStudentActivityRepository({ query } as DataSource);
}

test('activity adapter preserves auth calls and parameterizes bounded usage details', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const activity = repository(async (sql, values) => { calls.push({ sql, values }); return []; });
  const event: StudentActivityEvent = { id: randomUUID(), userId: randomUUID(), requestId: randomUUID(), action: 'login', outcome: 'succeeded', occurredAt: 123456 };
  await activity.record(event);
  assert.equal(calls[0]?.values?.[6], '{}');
  await activity.record({ ...event, action: 'seat-search', details: { seats: 2, resultCount: 0, floorId: 'floor-1', secret: 'private', liveData: false } as StudentActivityEvent['details'] });
  assert.equal(calls[1]?.values?.[6], '{"seats":2,"floorId":"floor-1","resultCount":0,"liveData":false}');
  assert.match(calls[1]?.sql ?? '', /\$7::jsonb/);
  assert.doesNotMatch(calls[1]?.sql ?? '', /floor-1|private/);
});

test('activity list UUID filters stay parameterized and invalid options never reach storage', async () => {
  const userId = randomUUID();
  let queries = 0;
  const activity = repository(async (sql, values) => {
    queries += 1;
    assert.match(sql, /WHERE user_id = \$2/);
    assert.deepEqual(values, [5, userId]);
    return [{ id: randomUUID(), user_id: userId, action: 'seat-search', outcome: 'succeeded', request_id: randomUUID(), occurred_at: new Date(1000), details: { seats: 2 } }];
  });
  assert.deepEqual((await activity.list(5, userId))[0]?.details, { seats: 2 });
  const validation = (error: unknown): boolean => error instanceof ApplicationError && error.kind === 'validation';
  await assert.rejects(activity.list(5, "' OR 1=1--"), validation);
  await assert.rejects(activity.list(1001, userId), validation);
  await assert.rejects(activity.summary(0), validation);
  assert.equal(queries, 1);
});

test('summary adapter converts bigint strings and nullable dates without losing count precision', async () => {
  const userId = randomUUID();
  let count = '9007199254740991';
  const activity = repository(async (sql, values) => {
    assert.match(sql, /public.student_activity_summary/);
    assert.deepEqual(values, [100]);
    return [{ user_id: userId, email: 'user@example.edu', name: 'User', search_count: count, no_result_search_count: '0',
      space_view_count: '1', table_select_count: '2', directions_view_count: '3', login_count: '4', failed_login_count: '5',
      first_activity_at: null, last_activity_at: new Date(2000), last_search_at: '1970-01-01T00:00:01.000Z' }];
  });
  assert.deepEqual((await activity.summary())[0], { userId, email: 'user@example.edu', name: 'User', searchCount: Number.MAX_SAFE_INTEGER,
    noResultSearchCount: 0, spaceViewCount: 1, tableSelectCount: 2, directionsViewCount: 3, loginCount: 4, failedLoginCount: 5,
    firstActivityAt: null, lastActivityAt: 2000, lastSearchAt: 1000 });
  count = '9007199254740992';
  await assert.rejects(activity.summary(), (error: unknown) => error instanceof ApplicationError && error.kind === 'unavailable');
});
