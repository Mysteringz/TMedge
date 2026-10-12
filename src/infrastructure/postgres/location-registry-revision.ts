import type { EntityManager } from 'typeorm';
import { queryRows } from './query-rows.js';

export async function readLocationRegistryRevision(manager: EntityManager): Promise<number> {
  const rows = await manager.query('SELECT revision FROM public.location_registry_revision WHERE id = 1') as Array<{ revision: number | string }>;
  if (!rows[0]) throw new Error('Location registry revision row is missing; apply the database migrations.');
  const revision = Number(rows[0].revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Location registry revision row is invalid.');
  return revision;
}

export async function incrementLocationRegistryRevision(manager: EntityManager): Promise<number> {
  const result: unknown = await manager.query(
    'UPDATE public.location_registry_revision SET revision = revision + 1 WHERE id = 1 RETURNING revision',
  );
  const rows = queryRows<{ revision: number | string }>(result);
  if (!rows[0]) throw new Error('Location registry revision row is missing; apply the database migrations.');
  const revision = Number(rows[0].revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Location registry revision row is invalid.');
  return revision;
}
