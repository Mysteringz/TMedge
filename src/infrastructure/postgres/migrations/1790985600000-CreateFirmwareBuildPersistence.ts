import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFirmwareBuildPersistence1790985600000 implements MigrationInterface {
  name = 'CreateFirmwareBuildPersistence1790985600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.firmware_artifacts (
        id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{16}$'),
        sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        size bigint NOT NULL CHECK (size > 0),
        version text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT firmware_artifact_id_matches_hash CHECK (id = left(sha256, 16))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE public.firmware_build_jobs (
        id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
        upload_id text NOT NULL CHECK (length(btrim(upload_id)) > 0),
        actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
        actor_kind text NOT NULL CHECK (actor_kind IN ('console', 'system', 'student')),
        lifecycle text NOT NULL CHECK (lifecycle IN ('accepted', 'running', 'succeeded', 'failed', 'interrupted')),
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        artifact_id text REFERENCES public.firmware_artifacts(id) ON DELETE RESTRICT,
        log jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
          jsonb_typeof(log) = 'array' AND jsonb_array_length(log) <= 400 AND octet_length(log::text) <= 131072
        ),
        error text,
        CONSTRAINT firmware_build_jobs_finish_time CHECK (finished_at IS NULL OR finished_at >= started_at),
        CONSTRAINT firmware_build_jobs_terminal_time CHECK (
          (lifecycle IN ('accepted', 'running') AND finished_at IS NULL)
          OR (lifecycle IN ('succeeded', 'failed', 'interrupted') AND finished_at IS NOT NULL)
        ),
        CONSTRAINT firmware_build_jobs_success_artifact CHECK (lifecycle <> 'succeeded' OR artifact_id IS NOT NULL)
      )
    `);
    await queryRunner.query('CREATE INDEX firmware_build_jobs_started_idx ON public.firmware_build_jobs (started_at DESC, id)');
    await queryRunner.query('CREATE INDEX firmware_build_jobs_lifecycle_idx ON public.firmware_build_jobs (lifecycle, started_at DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.firmware_build_jobs');
    await queryRunner.query('DROP TABLE public.firmware_artifacts');
  }
}
