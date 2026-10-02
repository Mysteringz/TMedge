import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOccupancyHistory1791244800000 implements MigrationInterface {
  name = 'CreateOccupancyHistory1791244800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE public.occupancy_history (
        minute_at timestamptz NOT NULL,
        sampled_at timestamptz NOT NULL,
        edge_id text NOT NULL CHECK (length(btrim(edge_id)) > 0),
        floor_id text NOT NULL CHECK (length(btrim(floor_id)) > 0),
        table_id text NOT NULL CHECK (length(btrim(table_id)) > 0),
        capacity integer NOT NULL CHECK (capacity > 0),
        occupied integer CHECK (occupied IS NULL OR occupied BETWEEN 0 AND capacity),
        free integer CHECK (free IS NULL OR free BETWEEN 0 AND capacity),
        coverage text NOT NULL CHECK (coverage IN ('ok', 'fallback', 'unknown')),
        PRIMARY KEY (minute_at, edge_id, floor_id, table_id),
        CONSTRAINT occupancy_history_sample_within_minute CHECK (
          sampled_at >= minute_at AND sampled_at < minute_at + interval '1 minute'
        ),
        CONSTRAINT occupancy_history_counts_consistent CHECK (
          (coverage = 'unknown' AND occupied IS NULL AND free IS NULL)
          OR (coverage <> 'unknown' AND occupied IS NOT NULL AND free IS NOT NULL AND occupied + free = capacity)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX occupancy_history_edge_table_time_idx ON public.occupancy_history (edge_id, table_id, minute_at DESC)');
    await queryRunner.query('CREATE INDEX occupancy_history_edge_floor_time_idx ON public.occupancy_history (edge_id, floor_id, minute_at DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.occupancy_history');
  }
}
