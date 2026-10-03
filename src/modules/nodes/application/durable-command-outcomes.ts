import { randomUUID } from 'node:crypto';
import { ApplicationError, type Actor } from '../../shared/application/contracts.js';
import type { NodeCommand } from './execute-node-command.js';
import type { CommandOutcomeRepository } from '../repositories/command-outcome-repository.js';
import { operationalLog } from '../../../shared/logging/operational-logger.js';

const MAX_PENDING = 512;
const DEFAULT_ACK_TIMEOUT_MS = 60_000;

interface PendingCommand {
  id: string;
  uid: string;
  command: string;
  actor: Actor;
  timer: ReturnType<typeof setTimeout>;
}

/** Records intent before transport dispatch and correlates STATUS.lastCmd without changing the wire protocol. */
export class DurableCommandOutcomes {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly recentStatus = new Map<string, { sequence: number; at: number }>();
  private disposed = false;

  constructor(
    private readonly repository: CommandOutcomeRepository,
    private readonly dispatch: (command: NodeCommand) => Promise<number>,
    private readonly now: () => number = Date.now,
    private readonly ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  ) {}

  async initialize(): Promise<void> {
    await this.repository.markInFlightUncertain?.(this.now());
  }

  async send(command: NodeCommand, actor: Actor): Promise<void> {
    if (this.disposed) throw new Error('command outcome service is stopping');
    if (this.pending.size >= MAX_PENDING) throw new Error('too many unacknowledged node commands');
    const id = randomUUID();
    const description = `${command.opcode}:${command.argument}:${command.value}`;
    const requestedAt = this.now();
    try {
      await this.repository.record({ id, nodeId: command.uid, command: description, actor, outcome: 'requested', at: requestedAt });
      operationalLog('node_command.outcome', { component: 'node-command', operationId: id, nodeId: command.uid, actorId: actor.id, outcome: 'requested' });
    } catch {
      throw new ApplicationError('unavailable', 'command persistence is unavailable; no command was sent');
    }
    let sequence: number;
    try {
      sequence = await this.dispatch(command);
    } catch (error) {
      await this.recordOutcome(id, command.uid, description, actor, 'uncertain');
      throw error;
    }
    const sentAt = this.now();
    try {
      await this.repository.record({ id, nodeId: command.uid, command: description, actor, outcome: 'sent', at: sentAt });
    } catch (error) {
      await this.recordOutcome(id, command.uid, description, actor, 'uncertain');
      throw new ApplicationError('unavailable', 'command delivery may have occurred, but its durable outcome is uncertain');
    }
    const key = `${command.uid}:${sequence}`;
    const earlyAck = this.recentStatus.get(command.uid);
    if (earlyAck?.sequence === sequence && this.now() - earlyAck.at <= this.ackTimeoutMs) {
      this.recentStatus.delete(command.uid);
      await this.recordOutcome(id, command.uid, description, actor, 'acknowledged');
      return;
    }
    const timer = setTimeout(() => {
      const item = this.pending.get(key);
      if (!item) return;
      this.pending.delete(key);
      void this.recordOutcome(item.id, item.uid, item.command, item.actor, 'timed-out');
    }, this.ackTimeoutMs);
    timer.unref();
    this.pending.set(key, { id, uid: command.uid, command: description, actor, timer });
  }

  /** Called from the status path; persistence is deferred off the packet callback. */
  observeStatus(uid: string, lastCommand: number): void {
    if (this.recentStatus.size >= MAX_PENDING) this.recentStatus.delete(this.recentStatus.keys().next().value as string);
    this.recentStatus.set(uid, { sequence: lastCommand, at: this.now() });
    const key = `${uid}:${lastCommand}`;
    const item = this.pending.get(key);
    if (!item) return;
    this.pending.delete(key);
    clearTimeout(item.timer);
    setImmediate(() => { void this.recordOutcome(item.id, item.uid, item.command, item.actor, 'acknowledged'); });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const count = this.pending.size;
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const item of items) clearTimeout(item.timer);
    if (count > 0) {
      try {
        await this.repository.markInFlightUncertain?.(this.now());
      } catch {
        // Keep shutdown bounded; initialize() reconciles durable in-flight rows on restart.
        operationalLog('node_command.reconciliation_deferred', {
          component: 'node-command',
          outcome: 'uncertain',
          count,
        });
      }
    }
  }

  private async recordOutcome(
    id: string, nodeId: string, command: string, actor: Actor,
    outcome: 'acknowledged' | 'timed-out' | 'uncertain',
  ): Promise<void> {
    try {
      await this.repository.record({ id, nodeId, command, actor, outcome, at: this.now() });
      operationalLog('node_command.outcome', { component: 'node-command', operationId: id, nodeId, actorId: actor.id, outcome });
    } catch {
      // The last committed state remains sent/requested; startup marks it uncertain.
    }
  }
}
