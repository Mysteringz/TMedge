import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FoundationProbe1760000000000 implements MigrationInterface {
  name = 'FoundationProbe1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE public.tmedge_foundation_probe (id integer PRIMARY KEY)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.tmedge_foundation_probe');
  }
}
