import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Receipts are written in the same transaction as the immutable published revision. */
export class TrackLocationPublicationSource1792108800000 implements MigrationInterface {
  name = 'TrackLocationPublicationSource1792108800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.location_published_revisions ADD COLUMN source_draft jsonb NULL
      CHECK (source_draft IS NULL OR jsonb_typeof(source_draft) = 'object')`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows: unknown = await queryRunner.query(`SELECT 1 FROM public.location_published_revisions WHERE source_draft IS NOT NULL
      AND ((source_draft->>'basePublishedRevision')::bigint IS DISTINCT FROM CASE WHEN revision = 1 AND source_draft->>'basePublishedRevision' IS NULL THEN NULL ELSE revision - 1 END) LIMIT 1`);
    if (Array.isArray(rows) && rows.length) throw new Error('Cannot remove publication receipts while history depends on older draft bases.');
    await queryRunner.query('ALTER TABLE public.location_published_revisions DROP COLUMN source_draft');
  }
}
