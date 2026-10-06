import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { PostgresStudentAccountRepository } from '../src/infrastructure/postgres/student-account-repository.js';
import { PostgresStudentActivityRepository } from '../src/infrastructure/postgres/student-activity-repository.js';
import type { StudentActivityEvent } from '../src/modules/student-auth/repositories/student-activity-repository.js';
import { createStudentUser } from '../src/modules/student-auth/application/student-credentials.js';

interface LegacySnapshot { userId: string; eventId: string; email: string; salt: string; hash: string; }

/** Seeds the old schema before the forward migration, including a preserved credential identity. */
export async function seedLegacyActivity(source: DataSource): Promise<LegacySnapshot> {
  // Seed the legacy shape before google_subject exists; the current adapter requires the expanded schema.
  const user = await createStudentUser('preserved@example.edu', 'Preserved', 'strong password');
  assert.ok(user.id);
  await source.query(`INSERT INTO public.student_users (id, email, name, salt, hash, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $6)`,
  [user.id, user.email, user.name, user.salt, user.hash, new Date(user.createdAt)]);
  const eventId = randomUUID();
  await source.query(`INSERT INTO public.student_activity_events (id, user_id, action, outcome, request_id, occurred_at)
    VALUES ($1, $2, 'login', 'succeeded', $3, $4)`, [eventId, user.id, randomUUID(), new Date('2040-01-01T00:00:00Z')]);
  return { userId: user.id, eventId, email: user.email, salt: user.salt, hash: user.hash };
}

/** Verifies the migration preserved authentication events, IDs, and password hashes. */
export async function assertLegacyPreserved(source: DataSource, legacy: LegacySnapshot): Promise<void> {
  const users = await source.query('SELECT id, email, salt, hash FROM public.student_users WHERE id = $1', [legacy.userId]);
  assert.deepEqual(users[0], { id: legacy.userId, email: legacy.email, salt: legacy.salt, hash: legacy.hash });
  const events = await source.query('SELECT id, user_id, action, outcome, details FROM public.student_activity_events WHERE id = $1', [legacy.eventId]);
  assert.deepEqual(events[0], { id: legacy.eventId, user_id: legacy.userId, action: 'login', outcome: 'succeeded', details: {} });
}

/** Exercises metadata invariants directly so server validation cannot conceal a schema gap. */
export async function assertUsageConstraints(source: DataSource): Promise<void> {
  const invalid: unknown[] = [null, [], { password: 'secret' }, { seats: 0 }, { seats: 31 }, { seats: 1.5 },
    { seats: '2' }, { seats: null }, { resultCount: -1 }, { resultCount: 21 }, { resultCount: 1.5 },
    { resultCount: '0' }, { floorId: '' }, { floorId: '<script>' }, { floorId: 'a'.repeat(101) },
    { venueId: 'spaces are not IDs' }, { tableId: null }, { liveData: 'false' }];
  const runner = source.createQueryRunner();
  await runner.startTransaction();
  try {
    for (const details of [...invalid.map((value) => JSON.stringify(value)), `{"seats":1.${'0'.repeat(2100)}}`]) {
      await runner.query('SAVEPOINT invalid_metadata');
      await assert.rejects(runner.query(`INSERT INTO public.student_activity_events (action, outcome, request_id, occurred_at, details)
        VALUES ('seat-search', 'succeeded', $1, now(), $2::jsonb)`, [randomUUID(), details]), /chk_student_activity_details/);
      await runner.query('ROLLBACK TO SAVEPOINT invalid_metadata');
    }
    await runner.query(`INSERT INTO public.student_activity_events (action, outcome, request_id, occurred_at, details)
      VALUES ('seat-search', 'succeeded', $1, now(), $2::jsonb)`, [randomUUID(), JSON.stringify({
      seats: 30, resultCount: 20, floorId: 'floor.a:1', venueId: 'venue-1', tableId: 'table_1', liveData: false,
    })]);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

/** Runtime-role access, per-user filters, zero-event rows, and retained-history aggregation. */
export async function assertUsageActivity(source: DataSource): Promise<void> {
  const accounts = new PostgresStudentAccountRepository(source);
  const user = await accounts.create('usage@example.edu', 'Usage', 'strong password');
  const zero = await accounts.create('zero@example.edu', 'Zero', 'strong password');
  assert.ok(user.id && zero.id);
  const activity = new PostgresStudentActivityRepository(source);
  const start = new Date('2039-01-01T00:00:00Z').getTime();
  const specs: Array<Pick<StudentActivityEvent, 'action' | 'outcome' | 'details'>> = [
    { action: 'seat-search', outcome: 'succeeded', details: { seats: 2, resultCount: 0, liveData: false } },
    { action: 'seat-search', outcome: 'succeeded', details: { seats: 3, resultCount: 2, floorId: 'floor-1' } },
    { action: 'seat-search', outcome: 'failed', details: { resultCount: 0 } },
    { action: 'space-view', outcome: 'succeeded', details: { seats: 2, floorId: 'floor-1' } },
    { action: 'table-select', outcome: 'succeeded', details: { seats: 2, floorId: 'floor-1', tableId: 'table-1' } },
    { action: 'directions-view', outcome: 'succeeded', details: { seats: 2, floorId: 'floor-1' } },
    { action: 'login', outcome: 'succeeded' }, { action: 'login', outcome: 'failed' },
    { action: 'login', outcome: 'rate-limited' },
  ];
  for (const [index, spec] of specs.entries()) await activity.record({ ...spec, id: randomUUID(), requestId: randomUUID(), userId: user.id, occurredAt: start + index * 1000 });
  await activity.record({ id: randomUUID(), requestId: randomUUID(), userId: null, action: 'login', outcome: 'failed', occurredAt: start });
  const events = await activity.list(100, user.id);
  assert.equal(events.length, specs.length);
  assert.ok(events.every((event) => event.userId === user.id));
  assert.deepEqual(events.find((event) => event.action === 'table-select')?.details, specs[4]?.details);
  assert.deepEqual(events.find((event) => event.action === 'login')?.details, {});
  const summaries = await activity.summary(1000);
  assert.deepEqual(summaries.find((row) => row.userId === user.id), {
    userId: user.id, email: user.email, name: user.name, searchCount: 2, noResultSearchCount: 1,
    spaceViewCount: 1, tableSelectCount: 1, directionsViewCount: 1, loginCount: 1, failedLoginCount: 2,
    firstActivityAt: start, lastActivityAt: start + 8000, lastSearchAt: start + 1000,
  });
  assert.deepEqual(summaries.find((row) => row.userId === zero.id), {
    userId: zero.id, email: zero.email, name: zero.name, searchCount: 0, noResultSearchCount: 0,
    spaceViewCount: 0, tableSelectCount: 0, directionsViewCount: 0, loginCount: 0, failedLoginCount: 0,
    firstActivityAt: null, lastActivityAt: null, lastSearchAt: null,
  });
}

/** Down removes usage history only and restores the original enum without deleting accounts/auth. */
export async function assertUsageRollback(source: DataSource, legacy: LegacySnapshot): Promise<void> {
  const users = await source.query('SELECT id, email, salt, hash FROM public.student_users WHERE id = $1', [legacy.userId]);
  assert.deepEqual(users[0], { id: legacy.userId, email: legacy.email, salt: legacy.salt, hash: legacy.hash });
  const events = await source.query('SELECT user_id, action, outcome FROM public.student_activity_events WHERE id = $1', [legacy.eventId]);
  assert.deepEqual(events[0], { user_id: legacy.userId, action: 'login', outcome: 'succeeded' });
  const usage = await source.query("SELECT count(*)::int AS count FROM public.student_activity_events WHERE action::text NOT IN ('signup', 'login', 'logout')");
  assert.equal(usage[0].count, 0);
  const schema = await source.query(`SELECT to_regclass('public.student_activity_summary') AS summary,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'student_activity_events' AND column_name = 'details') AS details`);
  assert.deepEqual(schema[0], { summary: null, details: 0 });
  await source.query(`INSERT INTO public.student_activity_events (user_id, action, outcome, request_id, occurred_at)
    VALUES ($1, 'logout', 'succeeded', $2, now())`, [legacy.userId, randomUUID()]);
}
