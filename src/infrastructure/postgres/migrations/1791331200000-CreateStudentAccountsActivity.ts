import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive student schema; runtime migration execution stays disabled. */
export class CreateStudentAccountsActivity1791331200000 implements MigrationInterface {
  name = 'CreateStudentAccountsActivity1791331200000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query("CREATE TYPE public.student_activity_action AS ENUM ('signup', 'login', 'logout')");
    await runner.query("CREATE TYPE public.student_activity_outcome AS ENUM ('succeeded', 'failed', 'rate-limited')");
    await runner.query(`CREATE TABLE public.student_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'),
      name text NOT NULL CHECK (length(btrim(name)) > 0),
      salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{32}$'),
      hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE public.student_activity_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES public.student_users(id) ON DELETE SET NULL,
      action public.student_activity_action NOT NULL,
      outcome public.student_activity_outcome NOT NULL,
      request_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query('CREATE INDEX idx_student_activity_events_user_time ON public.student_activity_events (user_id, occurred_at DESC)');
    await runner.query('CREATE INDEX idx_student_activity_events_time ON public.student_activity_events (occurred_at DESC)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE public.student_activity_events');
    await runner.query('DROP TABLE public.student_users');
    await runner.query('DROP TYPE public.student_activity_outcome');
    await runner.query('DROP TYPE public.student_activity_action');
  }
}
