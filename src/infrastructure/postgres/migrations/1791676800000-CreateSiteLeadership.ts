import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSiteLeadership1791676800000 implements MigrationInterface {
  name = 'CreateSiteLeadership1791676800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.site_leadership (
        site_id text PRIMARY KEY CHECK (site_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
        origin_id text NOT NULL CHECK (origin_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
        holder_id uuid NOT NULL,
        generation bigint NOT NULL CHECK (generation > 0),
        lease_until timestamptz NOT NULL,
        acquired_at timestamptz NOT NULL,
        renewed_at timestamptz NOT NULL,
        CHECK (lease_until >= renewed_at),
        CHECK (renewed_at >= acquired_at)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.site_leadership');
  }
}
