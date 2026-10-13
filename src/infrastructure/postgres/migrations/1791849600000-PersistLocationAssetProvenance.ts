import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Records server-derived per-slot ownership without rewriting immutable revision history. */
export class PersistLocationAssetProvenance1791849600000 implements MigrationInterface {
  name = 'PersistLocationAssetProvenance1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.location_drafts
        ADD COLUMN asset_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(asset_provenance) = 'object')
    `);
    await queryRunner.query(`
      ALTER TABLE public.location_published_revisions
        ADD COLUMN asset_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(asset_provenance) = 'object')
    `);
    // Trusted revision-zero rows are the only old records that can own a
    // static model reference without upload metadata. The immutable trigger
    // is suspended only for this deterministic migration backfill.
    await queryRunner.query('ALTER TABLE public.location_published_revisions DISABLE TRIGGER location_published_revisions_immutable');
    await queryRunner.query(`
      UPDATE public.location_published_revisions
      SET asset_provenance = jsonb_build_object(
        'modelAssetId', jsonb_build_object(
          'kind', 'legacy-static', 'basePublishedRevision', 0,
          'locationId', location_id, 'assetId', document->>'modelAssetId'
        )
      )
      WHERE revision = 0 AND document ? 'modelAssetId' AND document ? 'modelTransform'
    `);
    await queryRunner.query('ALTER TABLE public.location_published_revisions ENABLE TRIGGER location_published_revisions_immutable');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE public.location_published_revisions DROP COLUMN asset_provenance');
    await queryRunner.query('ALTER TABLE public.location_drafts DROP COLUMN asset_provenance');
  }
}
