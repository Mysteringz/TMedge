import type { TrainJob } from '../../algo/train/store.js';
import type { RolloutService } from '../../modules/rollouts/application/rollout-service.js';
import type { NotificationCandidate, NotificationSourceView } from '../../modules/algo-admin/domain/operation-notification.js';
import type { PendingChange } from '../../algo/params.js';
import type { NotificationQueries } from '../../modules/algo-admin/repositories/notification-queries.js';

const TRAINING_OUTCOMES: Record<string, string> = { COMPLETED: 'Completed', FAILED: 'Failed', TIMEOUT: 'Timed out', OUT_OF_MEMORY: 'Out of memory', SUBMIT_FAILED: 'Submission failed', CANCELLED: 'Cancelled', UNKNOWN: 'Unknown' };
const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 160) : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const candidate = (kind: 'training' | 'firmware', resourceId: string, label: string, outcome: string, occurredAt: number | null, fallback: number | null): NotificationCandidate | null => {
  if (!resourceId || !label || (occurredAt ?? fallback) === null) return null;
  return { id: JSON.stringify([kind, resourceId, outcome, occurredAt]), kind, resourceId, label, outcome, occurredAt, windowAt: occurredAt ?? fallback!, href: kind === 'training' ? `/train?job=${encodeURIComponent(resourceId)}` : '/updates' };
};

export interface NotificationSensor { uid: string; label: string; online: boolean; reportReceivedAt?: number | null; status?: { receivedAt: number } | null }
export interface NotificationStatusQueries { nodes?: (now: number) => NotificationSensor[]; changes?: () => Pick<PendingChange, 'uid' | 'param' | 'binding' | 'at' | 'revertAt' | 'confirmedAt' | 'restoring'>[]; build?: () => Promise<unknown> }
const activeItem = (kind: 'sensor' | 'firmware' | 'parameter', resourceId: string, label: string, outcome: string, boundary: number | null, detail = ''): NotificationCandidate => ({ id: JSON.stringify([kind, resourceId, outcome, boundary]), kind, resourceId, label, outcome, occurredAt: boundary, windowAt: boundary ?? 0, classification: 'active', detail, href: kind === 'sensor' ? '/console' : kind === 'parameter' ? '/flow' : '/updates' });

/** Reads full retained state; never connects HPC or derives events from audit records. */
export class RuntimeNotificationQueries implements NotificationQueries {
  constructor(private readonly listJobs: (owner: string) => TrainJob[] | null, private readonly rollouts: Pick<RolloutService, 'current' | 'history'>, private readonly status: NotificationStatusQueries = {}) {}
  training(owner: string, now = Date.now()): NotificationSourceView | null {
    const jobs = this.listJobs(owner); if (jobs === null) return { state: 'disabled', items: [] };
    const items: NotificationCandidate[] = [];
    for (const job of jobs) {
      if (job.user !== owner) continue;
      const outcome = TRAINING_OUTCOMES[job.status]; if (!outcome) continue;
      // UNKNOWN is actively polled: updatedAt is an observation time, not a stable transition.
      const occurredAt = job.status === 'UNKNOWN' ? null : time(job.endedAt) ?? (job.status === 'SUBMIT_FAILED' ? time(job.updatedAt) : null);
      const item = candidate('training', text(job.id), text(job.spec?.name) || text(job.id), outcome, occurredAt, time(job.submittedAt) ?? time(job.createdAt));
      if (item) items.push(job.status === 'UNKNOWN' ? { ...item, classification: 'active' } : item);
    }
    const own = jobs.filter((job) => job.user === owner), active = own.filter((job) => ['SUBMITTED', 'PENDING', 'RUNNING', 'UNKNOWN', 'SUBMITTING'].includes(job.status));
    const unknown = active.some((job) => job.status === 'UNKNOWN' || time(job.lastPolledAt) === null), stale = active.some((job) => job.lastPolledAt !== null && now - job.lastPolledAt > 60000);
    return { items, summary: { total: own.length, issues: items.filter((item) => !['Completed', 'Cancelled'].includes(item.outcome)).length, active: active.length, status: `${own.length} jobs - ${active.length} active${unknown ? ' - Remote status unknown' : stale ? ' - Remote status stale' : ''}`, observedAt: active.length ? Math.min(...active.map((job) => time(job.lastPolledAt) ?? 0)) || null : null, stale } };
  }
  private firmwareOutcomes(values: unknown[]): NotificationCandidate[] {
    const items: NotificationCandidate[] = [];
    for (const value of values) {
      const rollout = record(value), id = text(rollout.id), nodes = Array.isArray(rollout.nodes) ? rollout.nodes.map(record) : [];
      if (!id) continue;
      const label = text(rollout.version) || text(rollout.buildId) || id;
      const uncertain = rollout.recoveryState === 'interrupted' || nodes.some((node) => node.outcomeUncertain === true);
      const failed = nodes.some((node) => node.state === 'failed');
      const terminal = rollout.stage === 'done' || rollout.stage === 'stopped';
      const outcome = uncertain ? 'Uncertain' : failed && terminal ? 'Failed' : rollout.stage === 'stopped' ? 'Stopped' : rollout.stage === 'done' && nodes.length && nodes.every((node) => node.state === 'confirmed') ? 'Completed' : terminal ? 'Uncertain' : null;
      if (outcome && terminal) {
        const item = candidate('firmware', id, label, outcome, time(rollout.finishedAt), time(rollout.startedAt));
        if (item) items.push(item);
      }
      if (!terminal) for (const node of nodes) {
        const outcome = node.outcomeUncertain === true ? 'Uncertain' : node.state === 'failed' ? 'Failed' : null;
        if (!outcome) continue;
        const item = activeItem('firmware', `${id}:${text(node.uid)}`, `${label} - ${text(node.label) || text(node.uid)}`, outcome, time(node.startedAt) ?? time(rollout.startedAt));
        if (item) items.push(item);
      }
    }
    return items;
  }
  sensor(now: number): NotificationSourceView {
    if (!this.status.nodes) return { state: 'disabled', items: [] };
    const nodes = this.status.nodes(now), items: NotificationCandidate[] = [];
    for (const node of nodes) {
      const report = time(node.reportReceivedAt), observedStatus = time(node.status?.receivedAt), uid = text(node.uid), label = text(node.label) || uid;
      if (report === null) items.push(activeItem('sensor', uid, label, 'No report received', null, 'Sensor status unknown'));
      else if (!node.online) items.push(activeItem('sensor', uid, label, 'Offline report', report, 'No recent REPORT'));
      if (observedStatus !== null && now - observedStatus > 60000) items.push(activeItem('sensor', `${uid}:status`, label, 'Stale STATUS', observedStatus, 'Last STATUS observation is stale'));
    }
    const offline = nodes.filter((node) => node.reportReceivedAt != null && !node.online).length, unknown = nodes.filter((node) => node.reportReceivedAt == null).length;
    return { items, summary: { total: nodes.length, issues: items.length, status: `${nodes.length} sensors - ${offline} offline - ${unknown} no report`, observedAt: Math.max(0, ...nodes.map((node) => time(node.reportReceivedAt) ?? 0)) || null, stale: offline > 0 || items.some((item) => item.outcome === 'Stale STATUS') } };
  }
  parameter(_now: number): NotificationSourceView {
    if (!this.status.changes) return { state: 'disabled', items: [] };
    const changes = this.status.changes(), items = changes.map((change) => {
      const semantic = change.restoring ? 'Restoring' : change.confirmedAt === null ? 'Awaiting confirmation' : 'Pending reversion';
      const item = activeItem('parameter', `${text(change.uid)}:${text(change.param)}:${text(change.binding)}`, `${text(change.uid)} - ${text(change.param)}`, semantic, time(change.at) ?? time(change.revertAt), 'Parameter recovery remains pending');
      return { ...item, deadlineAt: time(change.revertAt) };
    });
    return { items, summary: { total: changes.length, issues: changes.length, status: `${changes.length} pending reversions`, observedAt: Math.max(0, ...changes.map((change) => time(change.at) ?? 0)) || null, stale: false } };
  }
  async firmware(now = Date.now()): Promise<NotificationSourceView> {
    const currentValue = this.rollouts.current(), history = this.rollouts.history(), current = record(currentValue);
    const items = this.firmwareOutcomes([currentValue, ...history]);
    const building = this.status.build ? record(await this.status.build()) : {}, started = time(building.startedAt);
    const buildState = Object.keys(building).length ? building.lifecycle === 'interrupted' ? 'Uncertain' : building.error || building.lifecycle === 'failed' ? 'Build failed' : 'Building' : null;
    if (buildState && (started !== null || text(building.id))) items.push(activeItem('firmware', `build:${text(building.id) || started}`, 'Firmware build', buildState, started));
    const nodes = Array.isArray(current.nodes) ? current.nodes.map(record) : [], terminal = current.stage === 'done' || current.stage === 'stopped';
    if (text(current.id) && !terminal) {
      const phase = current.recoveryState === 'interrupted' || nodes.some((node) => node.outcomeUncertain) ? 'Uncertain' : current.stage === 'pilot' ? 'Pilot rollout' : 'Rollout in progress';
      items.push(activeItem('firmware', `rollout:${text(current.id)}`, text(current.version) || text(current.id), phase, time(current.startedAt), `${nodes.filter((node) => node.state === 'confirmed').length}/${nodes.length} nodes confirmed`));
    }
    const progress = nodes.length ? Math.round(nodes.reduce((sum, node) => sum + (typeof node.percent === 'number' && Number.isFinite(node.percent) ? Math.max(0, Math.min(100, node.percent)) : 0), 0) / nodes.length) : undefined;
    return { items, summary: { total: history.length + (text(current.id) ? 1 : 0), issues: items.filter((item) => ['Failed', 'Uncertain', 'Build failed'].includes(item.outcome)).length, active: Number(!!buildState) + Number(!!text(current.id) && !terminal), status: [buildState ?? (this.status.build ? 'Build idle' : 'Build not configured'), text(current.id) ? `${text(current.stage)} rollout${progress === undefined ? '' : ` - ${progress}%`}` : 'No current rollout'].join(' - '), observedAt: now, stale: false, ...(progress === undefined ? {} : { progress }) } };
  }

}
