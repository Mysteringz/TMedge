import type { Actor } from '../../shared/application/contracts.js';

export type CommandOutcome = 'requested' | 'sent' | 'acknowledged' | 'timed-out' | 'uncertain' | 'failed';

/** Durable command intent and delivery outcome; adapters must not replay on startup. */
export interface CommandOutcomeRepository {
  record(input: { id: string; nodeId: string; command: string; actor: Actor; outcome: CommandOutcome; at: number }): Promise<void>;
  markInFlightUncertain?(at: number): Promise<void>;
}
