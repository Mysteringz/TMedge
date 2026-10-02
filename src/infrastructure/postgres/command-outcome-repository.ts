import type { DataSource } from 'typeorm';
import type { CommandOutcome, CommandOutcomeRepository } from '../../modules/nodes/repositories/command-outcome-repository.js';

interface OutcomeRow {
  command_id: string; node_id: string; command: string; actor_id: string;
  actor_kind: 'console' | 'system' | 'student'; outcome: CommandOutcome; occurred_at: Date | string;
}

/** Append-only adapter for command intent and delivery outcomes; it never dispatches commands. */
export class PostgresCommandOutcomeRepository implements CommandOutcomeRepository {
  constructor(private readonly source: DataSource) {}

  async record(input: {
    id: string; nodeId: string; command: string; actor: { id: string; kind: 'console' | 'system' | 'student' };
    outcome: CommandOutcome; at: number;
  }): Promise<void> {
    await this.source.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO public.command_outcomes (command_id, node_id, command, actor_id, actor_kind, outcome, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (command_id, outcome) DO NOTHING`,
        [input.id, input.nodeId, input.command, input.actor.id, input.actor.kind, input.outcome, new Date(input.at)],
      );
      const rows = await manager.query(
        `SELECT command_id, node_id, command, actor_id, actor_kind, outcome, occurred_at
         FROM public.command_outcomes WHERE command_id = $1 AND outcome = $2`,
        [input.id, input.outcome],
      ) as OutcomeRow[];
      const row = rows[0];
      if (!row || row.node_id !== input.nodeId || row.command !== input.command || row.actor_id !== input.actor.id
        || row.actor_kind !== input.actor.kind || row.outcome !== input.outcome || epoch(row.occurred_at) !== input.at) {
        throw new Error(`Conflicting command outcome ${input.id}/${input.outcome}`);
      }
    });
  }
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
