import type { Actor } from '../../shared/application/contracts.js';
import type { FirmwareBuildExecutor } from './firmware-build-executor.js';
import type { FirmwareBuildJobService } from './firmware-build-job-service.js';
import type { FirmwareBuildJobRecord, FirmwareBuildJobRepository } from '../repositories/firmware-build-job-repository.js';
import type { FirmwareArtifactRepository } from '../repositories/firmware-repository.js';
import { operationalLog } from '../../../shared/logging/operational-logger.js';

const MAX_LOG_LINES = 400;
const MAX_LOG_LINE_CHARS = 4096;
const PROGRESS_PERSIST_INTERVAL_MS = 1000;

export interface DurableFirmwareBuildJobOptions {
  repository: FirmwareBuildJobRepository;
  artifacts: FirmwareArtifactRepository;
  executor: FirmwareBuildExecutor;
  hydrateArtifacts?(artifacts: Awaited<ReturnType<FirmwareArtifactRepository['list']>>, jobs: FirmwareBuildJobRecord[]): void;
  activateArtifact?(artifactId: string): void;
  now?: () => number;
}

/** Persists intent and lifecycle before launching work; restart recovery never reruns jobs. */
export class DurableFirmwareBuildJobService implements FirmwareBuildJobService {
  private readonly now: () => number;
  private sequence = 0;
  private latest: FirmwareBuildJobRecord | null = null;
  private activeId: string | null = null;
  private execution: Promise<void> | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private progressWrite: Promise<void> = Promise.resolve();
  private hasPendingProgress = false;
  private disposed = false;

  constructor(private readonly options: DurableFirmwareBuildJobOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Interrupted active rows are made visible at startup and are never submitted to the executor. */
  async initialize(): Promise<void> {
    await this.options.repository.markActiveInterrupted(this.now());
    const rows = await this.options.repository.list();
    this.options.hydrateArtifacts?.(await this.options.artifacts.list(), rows);
    this.latest = rows[0] ?? null;
    if (this.latest && (this.latest.lifecycle === 'accepted' || this.latest.lifecycle === 'running')) {
      throw new Error('firmware build startup recovery left an active job');
    }
  }

  async start(uploadId: string, actor: Actor): Promise<boolean> {
    if (this.disposed) throw new Error('firmware build service is stopping');
    if (this.activeId !== null) return false;
    const startedAt = this.now();
    const id = `build-${startedAt.toString(36)}-${++this.sequence}`;
    const accepted: FirmwareBuildJobRecord = {
      id, uploadId, actor, lifecycle: 'accepted', startedAt, finishedAt: null, artifact: null, log: [], error: null,
    };
    try {
      await this.options.repository.create(accepted);
    } catch (error) {
      // A dropped commit acknowledgement is reconciled by the stable job ID.
      const committed = await this.options.repository.get(id).catch(() => null);
      if (!committed || !sameIntent(committed, accepted)) throw error;
    }
    this.latest = accepted;
    operationalLog('firmware_build.intent_committed', { component: 'firmware-build', operationId: id, actorId: actor.id, lifecycle: 'accepted' });
    this.activeId = id;
    const running = { ...accepted, lifecycle: 'running' as const };
    try {
      await this.options.repository.save(running);
      this.latest = running;
    } catch (error) {
      const committed = await this.options.repository.get(id).catch(() => null);
      if (committed?.lifecycle === 'running' && sameIntent(committed, accepted)) this.latest = committed;
      else {
        // Keep the slot reserved. A later explicit process recovery will mark this row interrupted.
        throw error;
      }
    }
    this.execution = this.execute(running);
    return true;
  }

  async status(): Promise<unknown> {
    const record = this.latest ?? (await this.options.repository.list())[0] ?? null;
    if (!record) return null;
    return {
      id: record.id,
      startedAt: record.startedAt,
      lifecycle: record.lifecycle,
      log: record.log.slice(-40),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  async operationalStatus(): Promise<{ latestLifecycle: string | null; interruptedJobs: number; activeJobs: number }> {
    const rows = await this.options.repository.list();
    return {
      latestLifecycle: this.latest?.lifecycle ?? null,
      interruptedJobs: rows.filter((job) => job.lifecycle === 'interrupted').length,
      activeJobs: rows.filter((job) => job.lifecycle === 'accepted' || job.lifecycle === 'running').length,
    };
  }

  async whenIdle(): Promise<void> {
    await this.execution;
    await this.progressWrite;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    await this.options.executor.dispose?.();
    await Promise.race([this.whenIdle(), new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      timeout.unref();
    })]);
  }

  private async execute(started: FirmwareBuildJobRecord): Promise<void> {
    let terminalSuccessWriteUncertain = false;
    try {
      const result = await this.options.executor.execute(
        { jobId: started.id, uploadId: started.uploadId, actor: started.actor },
        (line) => this.recordProgress(started.id, line),
      );
      await this.flushProgress();
      await this.options.artifacts.save(result.artifact);
      const succeeded: FirmwareBuildJobRecord = {
        ...this.current(started.id), lifecycle: 'succeeded', finishedAt: this.now(),
        artifact: result.artifact, log: boundedLog([...this.current(started.id).log, ...result.log]), error: null,
      };
      terminalSuccessWriteUncertain = true;
      await this.saveAndReconcile(succeeded);
      this.latest = succeeded;
      this.options.activateArtifact?.(succeeded.artifact!.id);
      terminalSuccessWriteUncertain = false;
      operationalLog('firmware_build.finished', { component: 'firmware-build', operationId: succeeded.id, lifecycle: succeeded.lifecycle });
    } catch (error) {
      if (terminalSuccessWriteUncertain) {
        const committed = await this.options.repository.get(started.id).catch(() => null);
        if (committed?.lifecycle === 'succeeded' && sameIntent(committed, started)) this.latest = committed;
        // Keep an unconfirmed terminal outcome unresolved; restart marks it interrupted.
        return;
      }
      await this.progressWrite.catch(() => undefined);
      const current = this.current(started.id);
      const failed: FirmwareBuildJobRecord = {
        ...current, lifecycle: 'failed', finishedAt: this.now(),
        log: boundedLog([...current.log, ...errorLog(error)]), error: errorText(error),
      };
      try {
        await this.saveAndReconcile(failed);
        this.latest = failed;
        operationalLog('firmware_build.finished', { component: 'firmware-build', operationId: failed.id, lifecycle: failed.lifecycle });
      } catch {
        // Keep the last committed lifecycle in memory; restart will reconcile active rows as interrupted.
      }
    } finally {
      this.activeId = null;
      this.execution = null;
    }
  }

  private recordProgress(id: string, line: string): void {
    if (this.activeId !== id || this.disposed) return;
    const base = this.current(id);
    this.latest = { ...base, log: boundedLog([...base.log, line.slice(0, MAX_LOG_LINE_CHARS)]) };
    this.hasPendingProgress = true;
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      void this.flushProgress();
    }, PROGRESS_PERSIST_INTERVAL_MS);
    this.progressTimer.unref();
  }

  private flushProgress(): Promise<void> {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const record = this.latest;
    if (!this.hasPendingProgress || !record || record.id !== this.activeId || record.lifecycle !== 'running') return this.progressWrite;
    this.hasPendingProgress = false;
    const previous = this.progressWrite;
    this.progressWrite = previous.catch(() => undefined).then(async () => {
      await this.options.repository.save(record);
    });
    return this.progressWrite;
  }

  private current(id: string): FirmwareBuildJobRecord {
    if (!this.latest || this.latest.id !== id) throw new Error(`build job ${id} is no longer current`);
    return this.latest;
  }

  private async saveAndReconcile(record: FirmwareBuildJobRecord): Promise<void> {
    try {
      await this.options.repository.save(record);
    } catch (error) {
      const committed = await this.options.repository.get(record.id).catch(() => null);
      if (!committed || !sameRecord(committed, record)) throw error;
    }
  }
}

function boundedLog(lines: readonly string[]): string[] {
  return lines.slice(-MAX_LOG_LINES).map((line) => line.slice(0, MAX_LOG_LINE_CHARS));
}

function sameIntent(a: FirmwareBuildJobRecord, b: FirmwareBuildJobRecord): boolean {
  return a.id === b.id && a.uploadId === b.uploadId && a.actor.id === b.actor.id && a.actor.kind === b.actor.kind;
}

function sameRecord(a: FirmwareBuildJobRecord, b: FirmwareBuildJobRecord): boolean {
  return sameIntent(a, b) && a.lifecycle === b.lifecycle && a.finishedAt === b.finishedAt
    && a.artifact?.id === b.artifact?.id && a.artifact?.sha256 === b.artifact?.sha256
    && a.artifact?.size === b.artifact?.size && a.artifact?.version === b.artifact?.version
    && a.error === b.error && JSON.stringify(a.log) === JSON.stringify(b.log);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorLog(error: unknown): string[] {
  if (typeof error !== 'object' || error === null || !('log' in error) || !Array.isArray(error.log)) return [];
  return error.log.filter((line): line is string => typeof line === 'string');
}
