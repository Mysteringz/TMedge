import type { EdgeRuntime } from '../../edge/runtime.js';
import type { ParamBroker } from '../../algo/params.js';
import type { TrainJob } from '../../algo/train/store.js';
import type { FirmwareSummary, ParameterSummary, SensorSummary, TrainingSummary } from '../../modules/algo-admin/domain/operational-health.js';
import type { OperationalQueries } from '../../modules/algo-admin/repositories/operational-queries.js';
import { projectFirmware } from './project-firmware-health.js';
import { healthText, healthTimestamp, nullableHealthTimestamp } from './health-observation-values.js';

export interface RuntimeOperationalOptions {
  runtime: Pick<EdgeRuntime, 'nodes' | 'rolloutService'>;
  broker: Pick<ParamBroker, 'changes'>;
  listJobs(owner: string): TrainJob[] | null;
  firmwareHealth?: () => Promise<unknown>;
}
const FAILURE = new Set(['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'SUBMIT_FAILED']);
const REMOTE_ACTIVE = new Set(['SUBMITTED', 'PENDING', 'RUNNING', 'UNKNOWN']);

/** Reads existing live services without opening sessions or retaining raw records. */
export class RuntimeOperationalQueries implements OperationalQueries {
  constructor(private readonly options: RuntimeOperationalOptions) {}

  sensors(now: number): SensorSummary {
    const rows = this.options.runtime.nodes(now).map((node) => ({
      uid: healthText(node.uid), label: healthText(node.label), floorId: node.floorId === null ? null : healthText(node.floorId), online: node.online,
      reportReceivedAt: nullableHealthTimestamp(node.reportReceivedAt), statusReceivedAt: nullableHealthTimestamp(node.status?.receivedAt),
    }));
    rows.sort((a, b) => Number(a.online) - Number(b.online) || a.uid.localeCompare(b.uid));
    return { total: rows.length, offline: rows.filter((n) => !n.online && n.reportReceivedAt !== null).length,
      unknown: rows.filter((n) => n.reportReceivedAt === null).length, rows: rows.slice(0, 20) };
  }

  training(owner: string): TrainingSummary | null {
    const jobs = this.options.listJobs(owner);
    if (jobs === null) return null;
    const sorted = jobs.slice().sort((a, b) => Number(FAILURE.has(b.status)) - Number(FAILURE.has(a.status)) || b.updatedAt - a.updatedAt);
    return { total: jobs.length, failed: jobs.filter((j) => FAILURE.has(j.status)).length,
      rows: sorted.slice(0, 10).map((job) => ({ id: healthText(job.id), name: healthText(job.spec.name), status: healthText(job.status),
        updatedAt: healthTimestamp(job.updatedAt), lastPolledAt: nullableHealthTimestamp(job.lastPolledAt), endedAt: nullableHealthTimestamp(job.endedAt),
        remoteObservationRequired: REMOTE_ACTIVE.has(job.status) })) };
  }

  async firmware(): Promise<FirmwareSummary | null> {
    if (!this.options.firmwareHealth) return null;
    const build = await this.options.firmwareHealth();
    const service = this.options.runtime.rolloutService;
    return projectFirmware(build, service.current(), service.history());
  }

  parameters(): ParameterSummary {
    const changes = this.options.broker.changes().slice().sort((a, b) => a.revertAt - b.revertAt);
    return { total: changes.length, rows: changes.slice(0, 20).map((change) => ({
      uid: healthText(change.uid), param: healthText(change.param), binding: healthText(change.binding), revertAt: healthTimestamp(change.revertAt),
      confirmedAt: nullableHealthTimestamp(change.confirmedAt), restoring: change.restoring === true,
    })) };
  }
}
