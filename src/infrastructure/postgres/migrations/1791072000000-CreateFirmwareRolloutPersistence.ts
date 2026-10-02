import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFirmwareRolloutPersistence1791072000000 implements MigrationInterface {
  name = 'CreateFirmwareRolloutPersistence1791072000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.firmware_rollouts (
        id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
        build_id text NOT NULL CHECK (length(btrim(build_id)) > 0),
        version text NOT NULL,
        target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
        started_by text NOT NULL CHECK (length(btrim(started_by)) > 0),
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        stage text NOT NULL CHECK (stage IN ('pilot', 'rest', 'done', 'stopped')),
        recovery_state text CHECK (recovery_state IS NULL OR recovery_state = 'interrupted'),
        note text NOT NULL DEFAULT '',
        CONSTRAINT firmware_rollouts_finish_time CHECK (finished_at IS NULL OR finished_at >= started_at),
        CONSTRAINT firmware_rollouts_stage_time CHECK (
          (stage IN ('pilot', 'rest') AND finished_at IS NULL)
          OR (stage IN ('done', 'stopped') AND finished_at IS NOT NULL)
        ),
        CONSTRAINT firmware_rollouts_recovery_stopped CHECK (recovery_state IS NULL OR stage = 'stopped')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX firmware_rollouts_one_active_uq ON public.firmware_rollouts ((true))
        WHERE stage IN ('pilot', 'rest')
    `);
    await queryRunner.query('CREATE INDEX firmware_rollouts_history_idx ON public.firmware_rollouts (started_at DESC, id)');
    await queryRunner.query(`
      CREATE TABLE public.firmware_rollout_nodes (
        rollout_id text NOT NULL REFERENCES public.firmware_rollouts(id) ON DELETE CASCADE,
        uid text NOT NULL,
        label text NOT NULL,
        floor_id text,
        gateway_id text,
        transport text CHECK (transport IS NULL OR transport IN ('udp', 'gateway', 'direct')),
        state text NOT NULL CHECK (state IN ('queued', 'sending', 'downloading', 'verifying', 'applying', 'rebooting', 'confirmed', 'failed', 'skipped')),
        percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
        error text,
        started_at timestamptz,
        updated_at timestamptz NOT NULL,
        outcome_uncertain boolean NOT NULL DEFAULT false,
        PRIMARY KEY (rollout_id, uid)
      )
    `);
    await queryRunner.query('CREATE INDEX firmware_rollout_nodes_uid_idx ON public.firmware_rollout_nodes (uid, updated_at DESC)');
    await queryRunner.query(`
      CREATE TABLE public.firmware_rollout_node_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        rollout_id text NOT NULL REFERENCES public.firmware_rollouts(id) ON DELETE CASCADE,
        uid text NOT NULL,
        state text NOT NULL CHECK (state IN ('queued', 'sending', 'downloading', 'verifying', 'applying', 'rebooting', 'confirmed', 'failed', 'skipped')),
        percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
        error text,
        occurred_at timestamptz NOT NULL,
        outcome_uncertain boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query('CREATE INDEX firmware_rollout_node_events_rollout_idx ON public.firmware_rollout_node_events (rollout_id, id)');
    await queryRunner.query('CREATE INDEX firmware_rollout_node_events_uid_idx ON public.firmware_rollout_node_events (uid, occurred_at DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.firmware_rollout_node_events');
    await queryRunner.query('DROP TABLE public.firmware_rollout_nodes');
    await queryRunner.query('DROP TABLE public.firmware_rollouts');
  }
}
