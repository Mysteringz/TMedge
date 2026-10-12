import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLocationConfigurationStorage1791676800000 implements MigrationInterface {
  name = 'CreateLocationConfigurationStorage1791676800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.location_registry_revision (
        id smallint PRIMARY KEY CHECK (id = 1),
        revision bigint NOT NULL CHECK (revision >= 0)
      )
    `);
    await queryRunner.query('INSERT INTO public.location_registry_revision (id, revision) VALUES (1, 0)');
    await queryRunner.query(`
      CREATE TABLE public.location_drafts (
        draft_id uuid PRIMARY KEY,
        creator_id text NOT NULL CHECK (length(btrim(creator_id)) > 0),
        location_id text NOT NULL CHECK (length(btrim(location_id)) > 0),
        draft_revision integer NOT NULL CHECK (draft_revision >= 1),
        base_published_revision integer CHECK (base_published_revision IS NULL OR base_published_revision >= 0),
        created_at bigint NOT NULL CHECK (created_at >= 0),
        updated_at bigint NOT NULL CHECK (updated_at >= created_at),
        document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object')
      )
    `);
    await queryRunner.query('CREATE INDEX location_drafts_owner_updated_idx ON public.location_drafts (creator_id, updated_at DESC)');
    await queryRunner.query(`
      CREATE TABLE public.location_published_revisions (
        location_id text NOT NULL CHECK (length(btrim(location_id)) > 0),
        revision integer NOT NULL CHECK (revision >= 0),
        created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
        created_at bigint NOT NULL CHECK (created_at >= 0),
        document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
        PRIMARY KEY (location_id, revision)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION public.reject_location_revision_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'published location revisions are immutable' USING ERRCODE = '55000';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER location_published_revisions_immutable
      BEFORE UPDATE OR DELETE ON public.location_published_revisions
      FOR EACH ROW EXECUTE FUNCTION public.reject_location_revision_mutation()
    `);
    await queryRunner.query(`
      CREATE TABLE public.location_active_revisions (
        location_id text PRIMARY KEY,
        revision integer NOT NULL,
        FOREIGN KEY (location_id, revision)
          REFERENCES public.location_published_revisions (location_id, revision)
          ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE TABLE public.location_assets (
        asset_id uuid PRIMARY KEY,
        creator_id text NOT NULL CHECK (length(btrim(creator_id)) > 0),
        purpose text NOT NULL CHECK (purpose IN ('floor-plan', 'model')),
        media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'model/gltf-binary')),
        sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        byte_length bigint NOT NULL CHECK (byte_length > 0),
        created_at bigint NOT NULL CHECK (created_at >= 0),
        CHECK ((purpose = 'floor-plan' AND media_type IN ('image/png', 'image/jpeg') AND byte_length <= 20971520)
          OR (purpose = 'model' AND media_type = 'model/gltf-binary' AND byte_length <= 134217728))
      )
    `);
    await queryRunner.query('CREATE INDEX location_assets_owner_idx ON public.location_assets (creator_id, created_at DESC)');
    await queryRunner.query(`
      CREATE FUNCTION public.reject_location_asset_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'location asset metadata is immutable' USING ERRCODE = '55000';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER location_assets_immutable
      BEFORE UPDATE OR DELETE ON public.location_assets
      FOR EACH ROW EXECUTE FUNCTION public.reject_location_asset_mutation()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER location_assets_immutable ON public.location_assets');
    await queryRunner.query('DROP TABLE public.location_assets');
    await queryRunner.query('DROP FUNCTION public.reject_location_asset_mutation()');
    await queryRunner.query('DROP TABLE public.location_active_revisions');
    await queryRunner.query('DROP TRIGGER location_published_revisions_immutable ON public.location_published_revisions');
    await queryRunner.query('DROP TABLE public.location_published_revisions');
    await queryRunner.query('DROP FUNCTION public.reject_location_revision_mutation()');
    await queryRunner.query('DROP TABLE public.location_drafts');
    await queryRunner.query('DROP TABLE public.location_registry_revision');
  }
}
