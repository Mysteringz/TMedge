import type { MigrationInterface, QueryRunner } from 'typeorm';

const AUTH_ACTIONS = "'signup', 'login', 'logout'";
const USAGE_ACTIONS = "'seat-search', 'space-view', 'table-select', 'directions-view'";

/** Extends retained activity without rewriting accounts or authentication history. */
export class ExtendStudentUsageActivity1791417600000 implements MigrationInterface {
  name = 'ExtendStudentUsageActivity1791417600000';

  async up(runner: QueryRunner): Promise<void> {
    await replaceActionEnum(runner, `${AUTH_ACTIONS}, ${USAGE_ACTIONS}`);
    await runner.query("ALTER TABLE public.student_activity_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb");
    await runner.query(`ALTER TABLE public.student_activity_events ADD CONSTRAINT chk_student_activity_details CHECK (
      CASE WHEN jsonb_typeof(details) = 'object' THEN octet_length(details::text) <= 2048
      AND details - ARRAY['seats', 'floorId', 'venueId', 'tableId', 'resultCount', 'liveData']::text[] = '{}'::jsonb
      AND ${numberCheck('seats', 1, 30)} AND ${numberCheck('resultCount', 0, 20)}
      AND ${identifierCheck('floorId')} AND ${identifierCheck('venueId')} AND ${identifierCheck('tableId')}
      AND (NOT details ? 'liveData' OR jsonb_typeof(details->'liveData') = 'boolean') ELSE false END
    )`);
    await runner.query(`CREATE VIEW public.student_activity_summary AS
      SELECT u.id AS user_id, u.email, u.name,
        count(e.id) FILTER (WHERE e.action = 'seat-search' AND e.outcome = 'succeeded') AS search_count,
        count(e.id) FILTER (WHERE e.action = 'seat-search' AND e.outcome = 'succeeded' AND (e.details->>'resultCount')::numeric = 0) AS no_result_search_count,
        count(e.id) FILTER (WHERE e.action = 'space-view' AND e.outcome = 'succeeded') AS space_view_count,
        count(e.id) FILTER (WHERE e.action = 'table-select' AND e.outcome = 'succeeded') AS table_select_count,
        count(e.id) FILTER (WHERE e.action = 'directions-view' AND e.outcome = 'succeeded') AS directions_view_count,
        count(e.id) FILTER (WHERE e.action = 'login' AND e.outcome = 'succeeded') AS login_count,
        count(e.id) FILTER (WHERE e.action = 'login' AND e.outcome IN ('failed', 'rate-limited')) AS failed_login_count,
        min(e.occurred_at) AS first_activity_at, max(e.occurred_at) AS last_activity_at,
        max(e.occurred_at) FILTER (WHERE e.action = 'seat-search' AND e.outcome = 'succeeded') AS last_search_at
      FROM public.student_users u LEFT JOIN public.student_activity_events e ON e.user_id = u.id
      GROUP BY u.id, u.email, u.name`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP VIEW public.student_activity_summary');
    // Usage history must be exported first if it is needed after rollback.
    await runner.query(`DELETE FROM public.student_activity_events WHERE action::text IN (${USAGE_ACTIONS})`);
    await runner.query('ALTER TABLE public.student_activity_events DROP COLUMN details');
    await replaceActionEnum(runner, AUTH_ACTIONS);
  }
}

async function replaceActionEnum(runner: QueryRunner, actions: string): Promise<void> {
  await runner.query('ALTER TYPE public.student_activity_action RENAME TO student_activity_action_previous');
  await runner.query(`CREATE TYPE public.student_activity_action AS ENUM (${actions})`);
  await runner.query(`ALTER TABLE public.student_activity_events ALTER COLUMN action TYPE public.student_activity_action
    USING action::text::public.student_activity_action`);
  await runner.query('DROP TYPE public.student_activity_action_previous');
}

function numberCheck(key: 'seats' | 'resultCount', minimum: number, maximum: number): string {
  return `(NOT details ? '${key}' OR CASE WHEN jsonb_typeof(details->'${key}') = 'number' THEN
    (details->>'${key}')::numeric BETWEEN ${minimum} AND ${maximum}
    AND (details->>'${key}')::numeric = trunc((details->>'${key}')::numeric) ELSE false END)`;
}

function identifierCheck(key: 'floorId' | 'venueId' | 'tableId'): string {
  return `(NOT details ? '${key}' OR (jsonb_typeof(details->'${key}') = 'string'
    AND details->>'${key}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'))`;
}
