import type { DataSource, QueryRunner } from 'typeorm';
import type { RegistryMutationCoordinator } from '../../modules/location-config/repositories/location-storage.js';
import { RegistryMutationQuarantinedError } from '../../modules/location-config/domain/location-records.js';

const REGISTRY_MUTATION_LOCK_ID = 1414352207;

/** Holds one PostgreSQL session advisory lock for the complete prepared mutation. */
export class PostgresRegistryMutationCoordinator implements RegistryMutationCoordinator {
  private quarantined = false;

  constructor(private readonly source: DataSource) {}

  async withMutationLock<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertHealthy();
    const runner: QueryRunner = this.source.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      await runner.query('SELECT pg_advisory_lock($1)', [REGISTRY_MUTATION_LOCK_ID]);
      locked = true;
      return await operation();
    } finally {
      if (locked) await runner.query('SELECT pg_advisory_unlock($1)', [REGISTRY_MUTATION_LOCK_ID]).catch(() => undefined);
      await runner.release();
    }
  }

  assertHealthy(): void {
    if (this.quarantined) throw new RegistryMutationQuarantinedError();
  }

  quarantine(_reason: unknown): void {
    this.quarantined = true;
  }
}
