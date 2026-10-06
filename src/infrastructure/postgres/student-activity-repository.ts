import type { DataSource } from 'typeorm';
import { ApplicationError } from '../../modules/shared/application/contracts.js';
import type { StudentActivityEvent, StudentActivityRepository } from '../../modules/student-auth/repositories/student-activity-repository.js';
import type { StudentActivityDetails } from '../../shared/student-activity.js';
import { sanitizeStudentActivityDetails } from '../../modules/student-auth/domain/student-activity-details.js';

interface ActivityRow {
  id: string; user_id: string | null; action: StudentActivityEvent['action']; outcome: StudentActivityEvent['outcome'];
  request_id: string; occurred_at: Date | string; details: StudentActivityDetails;
}

interface SummaryRow {
  user_id: string; email: string; name: string;
  search_count: string | number; no_result_search_count: string | number; space_view_count: string | number;
  table_select_count: string | number; directions_view_count: string | number;
  login_count: string | number; failed_login_count: string | number;
  first_activity_at: Date | string | null; last_activity_at: Date | string | null; last_search_at: Date | string | null;
}

/** Operator-only counts over the remaining retained activity, including students with no events. */
export interface StudentActivitySummary {
  userId: string; email: string; name: string;
  searchCount: number; noResultSearchCount: number; spaceViewCount: number; tableSelectCount: number;
  directionsViewCount: number; loginCount: number; failedLoginCount: number;
  firstActivityAt: number | null; lastActivityAt: number | null; lastSearchAt: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stores bounded authentication/usage context and supports retained-history reporting. */
export class PostgresStudentActivityRepository implements StudentActivityRepository {
  constructor(private readonly source: DataSource) {}

  async record(event: StudentActivityEvent): Promise<void> {
    await this.available(async () => {
      await this.source.query(`INSERT INTO public.student_activity_events
        (id, user_id, action, outcome, request_id, occurred_at, details) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [event.id, event.userId, event.action, event.outcome, event.requestId, new Date(event.occurredAt),
        JSON.stringify(sanitizeStudentActivityDetails(event.details ?? {}))]);
    });
  }

  async prune(before: number): Promise<number> {
    return this.available(async () => {
      const rows = await this.source.query(`WITH removed AS (
        DELETE FROM public.student_activity_events WHERE occurred_at < $1 RETURNING id
      ) SELECT count(*) AS count FROM removed`, [new Date(before)]) as Array<{ count: string | number }>;
      return safeCount(rows[0]?.count ?? 0);
    });
  }

  async countBefore(before: number): Promise<number> {
    return this.available(async () => {
      const rows = await this.source.query('SELECT count(*) AS count FROM public.student_activity_events WHERE occurred_at < $1',
        [new Date(before)]) as Array<{ count: string | number }>;
      return safeCount(rows[0]?.count ?? 0);
    });
  }

  async list(limit = 100, userId?: string): Promise<StudentActivityEvent[]> {
    validateLimit(limit);
    if (userId !== undefined && !UUID_RE.test(userId)) throw new ApplicationError('validation', 'Student user ID must be a UUID.');
    return this.available(async () => {
      const filter = userId === undefined ? '' : 'WHERE user_id = $2';
      const rows = await this.source.query(`SELECT id, user_id, action, outcome, request_id, occurred_at, details
        FROM public.student_activity_events ${filter} ORDER BY occurred_at DESC, id LIMIT $1`,
      userId === undefined ? [limit] : [limit, userId]) as ActivityRow[];
      return rows.map((row) => ({ id: row.id, userId: row.user_id, action: row.action, outcome: row.outcome,
        requestId: row.request_id, occurredAt: new Date(row.occurred_at).getTime(), details: row.details }));
    });
  }

  async summary(limit = 100): Promise<StudentActivitySummary[]> {
    validateLimit(limit);
    return this.available(async () => {
      const rows = await this.source.query(`SELECT * FROM public.student_activity_summary
        ORDER BY last_activity_at DESC NULLS LAST, user_id LIMIT $1`, [limit]) as SummaryRow[];
      return rows.map((row) => ({ userId: row.user_id, email: row.email, name: row.name,
        searchCount: safeCount(row.search_count), noResultSearchCount: safeCount(row.no_result_search_count),
        spaceViewCount: safeCount(row.space_view_count), tableSelectCount: safeCount(row.table_select_count),
        directionsViewCount: safeCount(row.directions_view_count), loginCount: safeCount(row.login_count),
        failedLoginCount: safeCount(row.failed_login_count), firstActivityAt: timestamp(row.first_activity_at),
        lastActivityAt: timestamp(row.last_activity_at), lastSearchAt: timestamp(row.last_search_at) }));
    });
  }

  private async available<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ApplicationError('unavailable', 'Student activity storage is unavailable.');
    }
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ApplicationError('validation', 'Activity limit must be 1..1000.');
}

function safeCount(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new ApplicationError('unavailable', 'Student activity count exceeds the safe range.');
  return result;
}

function timestamp(value: Date | string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}
