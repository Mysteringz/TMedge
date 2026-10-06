import { randomUUID } from 'node:crypto';
import type { StudentActivityAction, StudentActivityEvent, StudentActivityOutcome, StudentActivityRepository } from '../repositories/student-activity-repository.js';
import { operationalLog } from '../../../shared/logging/operational-logger.js';
import type { StudentActivityDetails } from '../../../shared/student-activity.js';
import { sanitizeStudentActivityDetails } from '../domain/student-activity-details.js';

const DAY_MS = 86_400_000;
type PendingWrite = { event: StudentActivityEvent } | { pruneBefore: number };

/** Bounded best-effort auth and usage activity; student actions never depend on this sink. */
export class StudentActivityLog {
  private readonly pending: PendingWrite[] = [];
  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private active = false;
  private droppedEvents = 0;
  private failedWrites = 0;
  private lastSuccessfulWriteAt: number | null = null;

  constructor(
    private readonly repository: StudentActivityRepository,
    private readonly options: { maxPending?: number; retentionDays?: number; now?: () => number } = {},
  ) {
    for (const value of [options.maxPending ?? 1000, options.retentionDays ?? 90]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Activity queue and retention must be positive integers');
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.prune();
    this.timer = setInterval(() => this.prune(), DAY_MS);
    this.timer.unref();
  }

  record(action: StudentActivityAction, outcome: StudentActivityOutcome, userId: string | null, requestId: string, details?: StudentActivityDetails): boolean {
    return this.enqueue({ event: {
      id: randomUUID(), userId, action, outcome, requestId, occurredAt: this.now(),
      ...(details ? { details: sanitizeStudentActivityDetails(details) } : {}),
    } });
  }

  stats() {
    return { queuedEvents: this.pending.length + Number(this.active), droppedEvents: this.droppedEvents,
      failedWrites: this.failedWrites, lastSuccessfulWriteAt: this.lastSuccessfulWriteAt };
  }

  flush(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (this.pending.length > 0) void this.flush();
      });
    }
    return this.draining;
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.flush(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    if (timer) clearTimeout(timer);
    this.droppedEvents += this.pending.filter((entry) => 'event' in entry).length;
    this.pending.length = 0;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private prune(): void {
    this.enqueue({ pruneBefore: this.now() - (this.options.retentionDays ?? 90) * DAY_MS });
  }

  private enqueue(write: PendingWrite): boolean {
    if (this.stopped || this.pending.length + Number(this.active) >= (this.options.maxPending ?? 1000)) {
      if ('event' in write) this.droppedEvents += 1;
      // Log exponentially spaced totals so a flooded queue cannot flood operational logs.
      if (this.droppedEvents > 0 && Number.isInteger(Math.log2(this.droppedEvents))) {
        operationalLog('student_activity.dropped', { component: 'student-activity', outcome: 'queue-full', count: this.droppedEvents });
      }
      return false;
    }
    this.pending.push(write);
    void this.flush();
    return true;
  }

  private async drain(): Promise<void> {
    let entry: PendingWrite | undefined;
    while ((entry = this.pending.shift())) {
      this.active = true;
      try {
        if ('event' in entry) await this.repository.record(entry.event);
        else await this.repository.prune(entry.pruneBefore);
        this.lastSuccessfulWriteAt = this.now();
      } catch {
        this.failedWrites += 1;
        if ('event' in entry) this.droppedEvents += 1;
        operationalLog('student_activity.write_failed', { component: 'student-activity', outcome: 'failed', count: this.failedWrites });
      } finally {
        this.active = false;
      }
    }
  }
}
