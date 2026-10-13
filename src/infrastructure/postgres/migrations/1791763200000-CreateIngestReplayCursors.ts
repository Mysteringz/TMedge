import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIngestReplayCursors1791763200000 implements MigrationInterface {
  name = 'CreateIngestReplayCursors1791763200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.ingest_replay_cursors (
        uid text PRIMARY KEY CHECK (uid ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
        boot bigint NOT NULL CHECK (boot BETWEEN 0 AND 4294967295),
        sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 4294967295),
        updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE public.ingest_command_cursor (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 4294967295),
        updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.ingest_command_cursor');
    await queryRunner.query('DROP TABLE public.ingest_replay_cursors');
  }
}
