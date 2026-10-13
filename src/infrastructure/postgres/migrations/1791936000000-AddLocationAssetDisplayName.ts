import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds an optional safe display label to immutable uploaded-model metadata. */
export class AddLocationAssetDisplayName1791936000000 implements MigrationInterface {
  name = 'AddLocationAssetDisplayName1791936000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.location_assets
        ADD COLUMN display_name text NULL,
        ADD CONSTRAINT location_assets_display_name_check CHECK (
          display_name IS NULL OR (purpose = 'model' AND char_length(display_name) BETWEEN 1 AND 128 AND btrim(display_name) <> '')
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_display_name_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP COLUMN display_name');
  }
}
