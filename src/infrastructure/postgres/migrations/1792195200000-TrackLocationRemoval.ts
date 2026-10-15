import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep the immutable revision pointer while recording removal from the live registry. */
export class TrackLocationRemoval1792195200000 implements MigrationInterface {
  name = 'TrackLocationRemoval1792195200000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE public.location_active_revisions
      ADD COLUMN removed_at bigint NULL,
      ADD COLUMN removed_by text NULL,
      ADD CONSTRAINT location_removal_metadata CHECK ((removed_at IS NULL AND removed_by IS NULL)
        OR (removed_at IS NOT NULL AND removed_at >= 0 AND removed_by IS NOT NULL AND length(btrim(removed_by)) BETWEEN 1 AND 256))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query('SELECT 1 FROM public.location_active_revisions WHERE removed_at IS NOT NULL LIMIT 1') as unknown[];
    if (rows.length) throw new Error('Cannot discard removal markers while locations are removed.');
    await runner.query('ALTER TABLE public.location_active_revisions DROP CONSTRAINT location_removal_metadata, DROP COLUMN removed_at, DROP COLUMN removed_by');
  }
}
