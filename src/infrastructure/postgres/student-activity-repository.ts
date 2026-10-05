import type { DataSource } from 'typeorm';
import { ApplicationError } from '../../modules/shared/application/contracts.js';
import type { StudentActivityEvent, StudentActivityRepository } from '../../modules/student-auth/repositories/student-activity-repository.js';

interface ActivityRow {
  id: string; user_id: string | null; action: StudentActivityEvent['action']; outcome: StudentActivityEvent['outcome'];
  request_id: string; occurred_at: Date | string;
}

/** Stores only fixed authentication event fields and supports time-based retention. */
export class PostgresStudentActivityRepository implements StudentActivityRepository {
  constructor(private readonly source: DataSource) {}

  async record(event: StudentActivityEvent): Promise<void> {
    await this.available(async () => {
      await this.source.query(`INSERT INTO public.student_activity_events
        (id, user_id, action, outcome, request_id, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.userId, event.action, event.outcome, event.requestId, new Date(event.occurredAt)]);
    });
  }

  async prune(before: number): Promise<number> {
    return this.available(async () => {
      const rows = await this.source.query(`WITH removed AS (
        DELETE FROM public.student_activity_events WHERE occurred_at < $1 RETURNING id
      ) SELECT count(*)::integer AS count FROM removed`, [new Date(before)]) as Array<{ count: number }>;
      return rows[0]?.count ?? 0;
    });
  }

  async countBefore(before: number): Promise<number> {
    return this.available(async () => {
      const rows = await this.source.query('SELECT count(*)::integer AS count FROM public.student_activity_events WHERE occurred_at < $1',
        [new Date(before)]) as Array<{ count: number }>;
      return rows[0]?.count ?? 0;
    });
  }

  async list(limit = 100): Promise<StudentActivityEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ApplicationError('validation', 'Activity limit must be 1..1000.');
    return this.available(async () => {
      const rows = await this.source.query(`SELECT id, user_id, action, outcome, request_id, occurred_at
        FROM public.student_activity_events ORDER BY occurred_at DESC, id LIMIT $1`, [limit]) as ActivityRow[];
      return rows.map((row) => ({ id: row.id, userId: row.user_id, action: row.action, outcome: row.outcome,
        requestId: row.request_id, occurredAt: new Date(row.occurred_at).getTime() }));
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
