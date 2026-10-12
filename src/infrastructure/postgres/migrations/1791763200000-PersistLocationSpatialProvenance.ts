import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores server-derived exact-base legacy geometry alongside drafts and immutable revisions. */
export class PersistLocationSpatialProvenance1791763200000 implements MigrationInterface {
  name = 'PersistLocationSpatialProvenance1791763200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.location_drafts
        ADD COLUMN legacy_spatial jsonb NOT NULL DEFAULT 'null'::jsonb
        CHECK (jsonb_typeof(legacy_spatial) IN ('object', 'null'))
    `);
    await queryRunner.query(`
      ALTER TABLE public.location_published_revisions
        ADD COLUMN legacy_spatial jsonb NOT NULL DEFAULT 'null'::jsonb
        CHECK (jsonb_typeof(legacy_spatial) IN ('object', 'null'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE public.location_published_revisions DROP COLUMN legacy_spatial');
    await queryRunner.query('ALTER TABLE public.location_drafts DROP COLUMN legacy_spatial');
  }
}
