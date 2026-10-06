import type { StudentActivityDetails, StudentUsageAction } from '../../../shared/student-activity.js';

export type StudentActivityAction = 'signup' | 'login' | 'logout' | StudentUsageAction;
export type StudentActivityOutcome = 'succeeded' | 'failed' | 'rate-limited';

/** An allowlisted event with no credentials, raw request body or unknown-account identifiers. */
export interface StudentActivityEvent {
  id: string;
  userId: string | null;
  action: StudentActivityAction;
  outcome: StudentActivityOutcome;
  requestId: string;
  occurredAt: number;
  details?: StudentActivityDetails;
}

export interface StudentActivityRepository {
  record(event: StudentActivityEvent): Promise<void>;
  prune(before: number): Promise<number>;
}
