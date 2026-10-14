import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFurnitureLocationAssets1792022400000 implements MigrationInterface {
  name = 'AddFurnitureLocationAssets1792022400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE public.location_assets ADD COLUMN furniture_type text NULL');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_purpose_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_media_type_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_display_name_check');
    await queryRunner.query(`
      ALTER TABLE public.location_assets
        ADD CONSTRAINT location_assets_purpose_check CHECK (purpose IN ('floor-plan', 'model', 'furniture')),
        ADD CONSTRAINT location_assets_media_type_check CHECK (media_type IN ('image/png', 'image/jpeg', 'model/gltf-binary')),
        ADD CONSTRAINT location_assets_check CHECK (
          (purpose = 'floor-plan' AND media_type IN ('image/png', 'image/jpeg') AND byte_length <= 20971520)
          OR (purpose = 'model' AND media_type = 'model/gltf-binary' AND byte_length <= 134217728)
          OR (purpose = 'furniture' AND media_type = 'model/gltf-binary' AND byte_length <= 134217728)
        ),
        ADD CONSTRAINT location_assets_furniture_type_check CHECK (
          (purpose = 'furniture' AND furniture_type IS NOT NULL AND furniture_type IN ('table', 'chair'))
          OR (purpose <> 'furniture' AND furniture_type IS NULL)
        ),
        ADD CONSTRAINT location_assets_display_name_check CHECK (
          (purpose = 'furniture' AND display_name IS NOT NULL AND char_length(display_name) BETWEEN 1 AND 128 AND btrim(display_name) <> '')
          OR (purpose = 'model' AND (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 128 AND btrim(display_name) <> '')))
          OR (purpose = 'floor-plan' AND display_name IS NULL)
        )
    `);
    await queryRunner.query(`
      CREATE INDEX location_assets_furniture_library_idx
        ON public.location_assets (furniture_type, created_at DESC, asset_id ASC)
        WHERE purpose = 'furniture'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows: unknown = await queryRunner.query("SELECT 1 FROM public.location_assets WHERE purpose = 'furniture' LIMIT 1");
    if (Array.isArray(rows) && rows.length > 0) {
      throw new Error('Cannot revert furniture metadata while immutable furniture assets exist.');
    }
    await queryRunner.query('DROP INDEX public.location_assets_furniture_library_idx');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_furniture_type_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_display_name_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_media_type_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP CONSTRAINT location_assets_purpose_check');
    await queryRunner.query('ALTER TABLE public.location_assets DROP COLUMN furniture_type');
    await queryRunner.query(`
      ALTER TABLE public.location_assets
        ADD CONSTRAINT location_assets_purpose_check CHECK (purpose IN ('floor-plan', 'model')),
        ADD CONSTRAINT location_assets_media_type_check CHECK (media_type IN ('image/png', 'image/jpeg', 'model/gltf-binary')),
        ADD CONSTRAINT location_assets_check CHECK (
          (purpose = 'floor-plan' AND media_type IN ('image/png', 'image/jpeg') AND byte_length <= 20971520)
          OR (purpose = 'model' AND media_type = 'model/gltf-binary' AND byte_length <= 134217728)
        ),
        ADD CONSTRAINT location_assets_display_name_check CHECK (
          display_name IS NULL OR (purpose = 'model' AND char_length(display_name) BETWEEN 1 AND 128 AND btrim(display_name) <> '')
        )
    `);
  }
}
