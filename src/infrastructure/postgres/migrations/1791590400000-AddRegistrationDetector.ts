import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRegistrationDetector1791590400000 implements MigrationInterface {
  name = 'AddRegistrationDetector1791590400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.registered_nodes
      ADD COLUMN detector text NOT NULL DEFAULT 'node'
      CHECK (detector IN ('node', 'edge'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE public.registered_nodes DROP COLUMN detector');
  }
}
