import type { Actor } from '../../shared/application/contracts.js';
import type { FirmwareBuildExecutor, FirmwareBuildRequest } from './firmware-build-executor.js';

export interface FirmwareBuildJobStatus {
  startedAt: number;
  log: string[];
  error?: string;
}

interface ActiveBuild extends FirmwareBuildJobStatus {
  jobId: string;
}

/** Tracks the accepted build independently from the executor's long-running work. */
export class FirmwareBuildJobs {
  private active: ActiveBuild | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(
    private readonly executor: FirmwareBuildExecutor,
    private readonly now: () => number = Date.now,
    private readonly errorRetentionMs = 5 * 60_000,
  ) {}

  /** Accepts one build at a time and reports whether a current build conflicted. */
  start(uploadId: string, actor: Actor): boolean {
    if (this.active && !this.active.error) return false;
    this.clearExpiry();
    const startedAt = this.now();
    const jobId = `build-${startedAt.toString(36)}-${++this.sequence}`;
    this.active = { jobId, startedAt, log: [] };
    void this.execute({ jobId, uploadId, actor });
    return true;
  }

  /** Returns a defensive copy of the current polling payload. */
  status(): FirmwareBuildJobStatus | null {
    if (!this.active) return null;
    const { startedAt, log, error } = this.active;
    return { startedAt, log: log.slice(-40), ...(error ? { error } : {}) };
  }

  /** Releases timers when the owning console server closes. */
  async dispose(): Promise<void> {
    this.clearExpiry();
    await this.executor.dispose?.();
  }

  private async execute(request: FirmwareBuildRequest): Promise<void> {
    try {
      await this.executor.execute(request, (line) => this.recordProgress(request.jobId, line));
      if (this.active?.jobId === request.jobId) this.active = null;
    } catch (error: unknown) {
      this.recordFailure(request.jobId, error);
    }
  }

  private recordProgress(jobId: string, line: string): void {
    if (this.active?.jobId !== jobId) return;
    this.active.log.push(line);
    if (this.active.log.length > 400) this.active.log.splice(0, this.active.log.length - 400);
  }

  private recordFailure(jobId: string, error: unknown): void {
    if (this.active?.jobId !== jobId) return;
    const details = errorDetails(error);
    this.active.error = details.message ?? String(error);
    this.active.log = (details.log.length ? details.log : this.active.log).slice(-400);
    this.expiry = setTimeout(() => { if (this.active?.jobId === jobId) this.active = null; }, this.errorRetentionMs);
    this.expiry.unref();
  }

  private clearExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }
}

function errorDetails(error: unknown): { message?: string; log: string[] } {
  if (typeof error !== 'object' || error === null) return { log: [] };
  const message = 'message' in error && typeof error.message === 'string' ? error.message : undefined;
  const output = 'log' in error && Array.isArray(error.log) ? error.log : [];
  return {
    ...(message !== undefined ? { message } : {}),
    log: output.filter((line): line is string => typeof line === 'string'),
  };
}
