import { ApplicationError } from '../../shared/application/contracts.js';
import type { RolloutService } from './rollout-service.js';
import type { RolloutTarget } from '../domain/rollout-target.js';
import type { RolloutRecord, RolloutRepository } from '../repositories/rollout-repository.js';
import type { RolloutView } from '../../../edge/rollout.js';
import { Rollouts } from '../../../edge/rollout.js';
import { operationalLog } from '../../../shared/logging/operational-logger.js';

/** Serializes operator actions and commits the snapshot before rollout dispatch. */
export class DurableRolloutService implements RolloutService {
  private initialized = false;
  private operation: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private lastPersistedFingerprint = '';

  constructor(private readonly state: Rollouts, private readonly repository: RolloutRepository, private readonly now: () => number = Date.now) {
    state.setBeforeDispatch(() => this.persist());
  }

  async initialize(): Promise<void> {
    const interrupted = await this.repository.interruptActive(this.now());
    const [current, history] = await Promise.all([this.repository.current(), this.repository.history()]);
    const records = history.slice();
    if (interrupted && !records.some((row) => row.id === interrupted.id)) records.unshift(interrupted);
    const restoredHistory = records.map(toView).reverse();
    this.state.restore(current ? toView(current) : null, restoredHistory);
    this.lastPersistedFingerprint = this.fingerprint();
    this.initialized = true;
  }

  current(): unknown { return this.state.current(); }
  history(): unknown[] { return this.state.history(); }

  async start(buildId: string, target: RolloutTarget, actor: string): Promise<unknown> {
    return this.serialize(async () => {
      this.requireInitialized();
      const previous = this.viewSnapshot();
      let created: RolloutView;
      try {
        created = this.state.start(buildId, target, actor, true);
      } catch (error) {
        this.restore(previous);
        throw error;
      }
      try {
        await this.persist();
      } catch {
        const committed = await this.repository.current().catch(() => null);
        if (!committed || committed.id !== created.id || committed.stage !== created.stage) {
          this.restore(previous);
          throw new ApplicationError('unavailable', 'rollout persistence is unavailable; no rollout was started');
        }
        this.lastPersistedFingerprint = this.fingerprint();
      }
      operationalLog('firmware_rollout.transition', {
        component: 'rollout', operationId: created.id, actorId: actor, lifecycle: 'pilot', outcome: 'committed', count: created.nodes.length,
      });
      this.state.tick();
      return created;
    });
  }

  async cancel(actor: string): Promise<void> {
    await this.serialize(async () => {
      this.requireInitialized();
      const previous = this.viewSnapshot();
      this.state.cancel(actor);
      try {
        await this.persist();
        const current = this.state.current();
        if (current) operationalLog('firmware_rollout.transition', {
          component: 'rollout', operationId: current.id, actorId: actor, lifecycle: current.stage, outcome: 'committed',
        });
      } catch {
        const committed = (await this.repository.history().catch(() => []))
          .find((record) => record.id === previous.current?.id && record.stage === 'stopped');
        if (committed) {
          this.lastPersistedFingerprint = this.fingerprint();
          return;
        }
        this.restore(previous);
        throw new ApplicationError('unavailable', 'rollout persistence is unavailable; cancellation was not committed');
      }
    });
  }

  async tick(): Promise<void> {
    await this.serialize(async () => {
      this.requireInitialized();
      await this.persist();
      this.state.tick();
    });
  }

  async dispose(): Promise<void> {
    await Promise.race([this.operation, new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      timeout.unref();
    })]);
  }

  private async persist(): Promise<void> {
    const write = this.writes.then(async () => {
      const fingerprint = this.fingerprint();
      if (fingerprint === this.lastPersistedFingerprint) return;
      const current = this.state.current();
      const history = this.state.history();
      try {
        await this.repository.saveSnapshot(current ? toRecord(current) : null, history.map(toRecord));
        this.lastPersistedFingerprint = fingerprint;
      } catch (error) {
        if (current) operationalLog('firmware_rollout.persistence_failed', {
          component: 'rollout', operationId: current.id, lifecycle: current.stage, outcome: 'failed',
        });
        throw error;
      }
    });
    this.writes = write.then(() => undefined, () => undefined);
    await write;
  }

  private fingerprint(): string {
    const current = this.state.current();
    return JSON.stringify({ current: current ? toRecord(current) : null, history: this.state.history().map(toRecord) });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task, task);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private viewSnapshot(): { current: RolloutView | null; history: RolloutView[] } {
    return { current: this.state.current(), history: this.state.history().slice().reverse() };
  }

  private restore(snapshot: { current: RolloutView | null; history: RolloutView[] }): void {
    this.state.restore(snapshot.current, snapshot.history);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new ApplicationError('unavailable', 'rollout recovery has not completed');
  }
}

function toRecord(view: RolloutView): RolloutRecord {
  return {
    id: view.id, buildId: view.buildId, version: view.version, target: view.target, startedBy: view.startedBy,
    startedAt: view.startedAt, finishedAt: view.finishedAt, stage: view.stage,
    ...(view.recoveryState ? { recoveryState: view.recoveryState } : {}), note: view.note,
    nodes: view.nodes.map((node) => ({ ...node })),
  };
}

function toView(record: RolloutRecord): RolloutView {
  return {
    id: record.id, buildId: record.buildId, version: record.version, target: record.target,
    startedBy: record.startedBy, startedAt: record.startedAt, finishedAt: record.finishedAt,
    stage: record.stage, ...(record.recoveryState ? { recoveryState: record.recoveryState } : {}), note: record.note,
    nodes: record.nodes.map((node) => ({ ...node })),
  };
}
