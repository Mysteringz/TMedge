import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRegistrationProvisioningAuditSchema1790812800000 implements MigrationInterface {
  name = 'CreateRegistrationProvisioningAuditSchema1790812800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE public.provisioning_request_status AS ENUM ('pending', 'approved', 'denied', 'expired')
    `);
    await queryRunner.query(`
      CREATE TYPE public.provisioning_actor_kind AS ENUM ('console', 'system', 'student')
    `);
    await queryRunner.query(`
      CREATE TABLE public.registered_nodes (
        uid text PRIMARY KEY,
        label text NOT NULL,
        simulated boolean NOT NULL DEFAULT false,
        rgb boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE public.node_placements (
        uid text PRIMARY KEY REFERENCES public.registered_nodes(uid) ON DELETE RESTRICT,
        floor_id text NOT NULL,
        x double precision NOT NULL,
        y double precision NOT NULL,
        height_cm double precision NOT NULL,
        yaw_deg double precision NOT NULL,
        mirror boolean NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE public.node_table_owners (
        table_id text PRIMARY KEY,
        uid text NOT NULL REFERENCES public.node_placements(uid) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX node_table_owners_uid_idx ON public.node_table_owners (uid)');
    await queryRunner.query(`
      CREATE TABLE public.provisioning_requests (
        id uuid PRIMARY KEY,
        uid text NOT NULL,
        label text NOT NULL,
        firmware text,
        requested_by text NOT NULL,
        requested_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        status public.provisioning_request_status NOT NULL,
        resolved_at timestamptz,
        resolved_by_id text,
        resolved_by_kind public.provisioning_actor_kind,
        registered_uid text REFERENCES public.registered_nodes(uid) ON DELETE RESTRICT,
        CONSTRAINT provisioning_requests_expiry_after_request
          CHECK (expires_at > requested_at),
        CONSTRAINT provisioning_requests_resolution_after_request
          CHECK (resolved_at IS NULL OR resolved_at >= requested_at),
        CONSTRAINT provisioning_requests_expired_after_deadline
          CHECK (status <> 'expired' OR (resolved_at IS NOT NULL AND resolved_at >= expires_at)),
        CONSTRAINT provisioning_requests_pending_unresolved
          CHECK (status <> 'pending' OR (
            resolved_at IS NULL AND resolved_by_id IS NULL AND resolved_by_kind IS NULL AND registered_uid IS NULL
          )),
        CONSTRAINT provisioning_requests_terminal_resolved
          CHECK (status = 'pending' OR (
            resolved_at IS NOT NULL AND resolved_by_id IS NOT NULL AND resolved_by_kind IS NOT NULL
          )),
        CONSTRAINT provisioning_requests_approval_registration
          CHECK (
            (status = 'approved' AND registered_uid = uid)
            OR (status IN ('pending', 'denied', 'expired') AND registered_uid IS NULL)
          )
      )
    `);
    await queryRunner.query('CREATE INDEX provisioning_requests_uid_idx ON public.provisioning_requests (uid)');
    await queryRunner.query('CREATE INDEX provisioning_requests_status_expiry_idx ON public.provisioning_requests (status, expires_at)');
    await queryRunner.query(`
      CREATE UNIQUE INDEX provisioning_requests_one_pending_uid_uq
        ON public.provisioning_requests (uid) WHERE status = 'pending'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX provisioning_requests_registered_uid_uq
        ON public.provisioning_requests (registered_uid) WHERE registered_uid IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE public.provisioning_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id text NOT NULL,
        actor_kind public.provisioning_actor_kind NOT NULL,
        action text NOT NULL CHECK (length(btrim(action)) > 0),
        subject_id text NOT NULL CHECK (length(btrim(subject_id)) > 0),
        occurred_at timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX provisioning_audit_events_subject_time_idx
        ON public.provisioning_audit_events (subject_id, occurred_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.provisioning_audit_events');
    await queryRunner.query('DROP TABLE public.provisioning_requests');
    await queryRunner.query('DROP TABLE public.node_table_owners');
    await queryRunner.query('DROP TABLE public.node_placements');
    await queryRunner.query('DROP TABLE public.registered_nodes');
    await queryRunner.query('DROP TYPE public.provisioning_actor_kind');
    await queryRunner.query('DROP TYPE public.provisioning_request_status');
  }
}
