import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Add Google's stable OIDC subject without making email an auto-link key. */
export class AddGoogleStudentIdentity1791504000000 implements MigrationInterface {
  name = 'AddGoogleStudentIdentity1791504000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE public.student_users ADD COLUMN google_subject text');
    await runner.query("ALTER TABLE public.student_users ADD CONSTRAINT student_users_google_subject_check CHECK (google_subject IS NULL OR (length(google_subject) BETWEEN 1 AND 255))");
    await runner.query('CREATE UNIQUE INDEX student_users_google_subject_unique ON public.student_users (google_subject) WHERE google_subject IS NOT NULL');
    await runner.query("ALTER TABLE public.student_users DROP CONSTRAINT student_users_salt_check, ADD CONSTRAINT student_users_salt_check CHECK ((salt ~ '^[a-f0-9]{32}$' AND hash ~ '^[a-f0-9]{64}$') OR (google_subject IS NOT NULL AND salt = '' AND hash = ''))");
    await runner.query('ALTER TABLE public.student_users DROP CONSTRAINT student_users_hash_check');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query("DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.student_users WHERE google_subject IS NOT NULL) THEN RAISE EXCEPTION 'cannot roll back Google identity while Google accounts exist'; END IF; END $$");
    await runner.query('ALTER TABLE public.student_users DROP CONSTRAINT student_users_salt_check');
    await runner.query('ALTER TABLE public.student_users ADD CONSTRAINT student_users_salt_check CHECK (salt ~ \'^[a-f0-9]{32}$\')');
    await runner.query('ALTER TABLE public.student_users ADD CONSTRAINT student_users_hash_check CHECK (hash ~ \'^[a-f0-9]{64}$\')');
    await runner.query('DROP INDEX public.student_users_google_subject_unique');
    await runner.query('ALTER TABLE public.student_users DROP CONSTRAINT student_users_google_subject_check, DROP COLUMN google_subject');
  }
}
