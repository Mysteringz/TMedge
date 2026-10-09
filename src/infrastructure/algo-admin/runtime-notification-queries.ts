import type { TrainJob } from '../../algo/train/store.js';
import type { RolloutService } from '../../modules/rollouts/application/rollout-service.js';
import type { NotificationCandidate } from '../../modules/algo-admin/domain/operation-notification.js';
import type { NotificationQueries } from '../../modules/algo-admin/repositories/notification-queries.js';

const TRAINING_OUTCOMES: Record<string, string> = { COMPLETED: 'Completed', FAILED: 'Failed', TIMEOUT: 'Timed out', OUT_OF_MEMORY: 'Out of memory', SUBMIT_FAILED: 'Submission failed', CANCELLED: 'Cancelled', UNKNOWN: 'Unknown' };
const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 160) : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const candidate = (kind: 'training' | 'firmware', resourceId: string, label: string, outcome: string, occurredAt: number | null, fallback: number | null): NotificationCandidate | null => {
  if (!resourceId || !label || (occurredAt ?? fallback) === null) return null;
  return { id: JSON.stringify([kind, resourceId, outcome, occurredAt]), kind, resourceId, label, outcome, occurredAt, windowAt: occurredAt ?? fallback!, href: kind === 'training' ? `/train?job=${encodeURIComponent(resourceId)}` : '/updates' };
};

/** Reads full retained state; never connects HPC or derives events from audit records. */
export class RuntimeNotificationQueries implements NotificationQueries {
  constructor(private readonly listJobs: (owner: string) => TrainJob[] | null, private readonly rollouts: Pick<RolloutService, 'current' | 'history'>) {}
  training(owner: string): NotificationCandidate[] | null {
    const jobs = this.listJobs(owner); if (jobs === null) return null;
    const items: NotificationCandidate[] = [];
    for (const job of jobs) {
      if (job.user !== owner) continue;
      const outcome = TRAINING_OUTCOMES[job.status]; if (!outcome) continue;
      // UNKNOWN is actively polled: updatedAt is an observation time, not a stable transition.
      const occurredAt = job.status === 'UNKNOWN' ? null : time(job.endedAt) ?? (job.status === 'SUBMIT_FAILED' ? time(job.updatedAt) : null);
      const item = candidate('training', text(job.id), text(job.spec?.name) || text(job.id), outcome, occurredAt, time(job.submittedAt) ?? time(job.createdAt));
      if (item) items.push(item);
    }
    return items;
  }
  firmware(): NotificationCandidate[] {
    const items: NotificationCandidate[] = [];
    for (const value of [this.rollouts.current(), ...this.rollouts.history()]) {
      const rollout = record(value), id = text(rollout.id), nodes = Array.isArray(rollout.nodes) ? rollout.nodes.map(record) : [];
      if (!id) continue;
      const label = text(rollout.version) || text(rollout.buildId) || id;
      const uncertain = rollout.recoveryState === 'interrupted' || nodes.some((node) => node.outcomeUncertain === true);
      const failed = nodes.some((node) => node.state === 'failed');
      const terminal = rollout.stage === 'done' || rollout.stage === 'stopped';
      const outcome = uncertain ? 'Uncertain' : failed && terminal ? 'Failed' : rollout.stage === 'stopped' ? 'Stopped' : rollout.stage === 'done' && nodes.length && nodes.every((node) => node.state === 'confirmed') ? 'Completed' : terminal ? 'Uncertain' : null;
      if (outcome) {
        const item = candidate('firmware', id, label, outcome, time(rollout.finishedAt), time(rollout.startedAt));
        if (item) items.push(item);
      }
      if (!terminal) for (const node of nodes) {
        const outcome = node.outcomeUncertain === true ? 'Uncertain' : node.state === 'failed' ? 'Failed' : null;
        if (!outcome) continue;
        const item = candidate('firmware', `${id}:${text(node.uid)}`, `${label} · ${text(node.label) || text(node.uid)}`, outcome, time(node.updatedAt), time(rollout.startedAt));
        if (item) items.push(item);
      }
    }
    return items;
  }
}
