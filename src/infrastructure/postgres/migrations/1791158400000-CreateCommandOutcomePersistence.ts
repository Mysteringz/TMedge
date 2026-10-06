import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCommandOutcomePersistence1791158400000 implements MigrationInterface {
  name = 'CreateCommandOutcomePersistence1791158400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.command_outcomes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        command_id text NOT NULL CHECK (length(btrim(command_id)) > 0),
        node_id text NOT NULL CHECK (length(btrim(node_id)) > 0),
        command text NOT NULL CHECK (length(btrim(command)) > 0),
        actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
        actor_kind text NOT NULL CHECK (actor_kind IN ('console', 'system', 'student')),
        outcome text NOT NULL CHECK (outcome IN ('requested', 'sent', 'acknowledged', 'timed-out', 'uncertain', 'failed')),
        occurred_at timestamptz NOT NULL,
        CONSTRAINT command_outcomes_same_transition_once UNIQUE (command_id, outcome)
      )
    `);
    await queryRunner.query('CREATE INDEX command_outcomes_node_time_idx ON public.command_outcomes (node_id, occurred_at DESC)');
    await queryRunner.query('CREATE INDEX command_outcomes_command_time_idx ON public.command_outcomes (command_id, occurred_at)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.command_outcomes');
  }
}
