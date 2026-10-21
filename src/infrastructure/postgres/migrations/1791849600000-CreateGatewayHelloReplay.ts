import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGatewayHelloReplay1791849600000 implements MigrationInterface {
  name = 'CreateGatewayHelloReplay1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.gateway_hello_replays (
        gateway_id text NOT NULL CHECK (gateway_id ~ '^[A-Za-z0-9._-]{1,64}$'),
        nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9._-]{1,128}$'),
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        PRIMARY KEY (gateway_id, nonce),
        CHECK (expires_at > accepted_at)
      )
    `);
    await queryRunner.query('CREATE INDEX gateway_hello_replays_expiry_idx ON public.gateway_hello_replays (expires_at)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.gateway_hello_replays');
  }
}
