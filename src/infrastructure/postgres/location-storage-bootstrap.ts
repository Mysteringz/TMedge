import type { DataSource } from 'typeorm';
import type { Registry } from '../../edge/registry.js';
import { legacyFloorToBaseline } from '../location-config/legacy-location-mapper.js';
import type { RegistryMutationCoordinator } from '../../modules/location-config/repositories/location-storage.js';
import { LocationStorageUnavailableError } from '../../modules/location-config/domain/location-records.js';
import { legacyStaticModelProvenance } from '../../modules/location-config/domain/location-assets.js';
import { readLocationRegistryRevision } from './location-registry-revision.js';

/** Seeds editable revision-0 location documents without modifying DB registrations or placements. */
export async function bootstrapPostgresLegacyLocations(
  source: DataSource,
  registrySource: Registry | (() => Promise<Registry>),
  coordinator: RegistryMutationCoordinator,
): Promise<Registry> {
  return coordinator.withMutationLock(async () => {
    const registry = typeof registrySource === 'function' ? await registrySource() : registrySource;
    await source.transaction(async (manager) => {
      await readLocationRegistryRevision(manager);
      for (const floor of registry.floors) {
        const history = await manager.query(
          'SELECT revision FROM public.location_published_revisions WHERE location_id = $1 ORDER BY revision', [floor.id],
        ) as Array<{ revision: number | string }>;
        const active = await manager.query(
          'SELECT revision FROM public.location_active_revisions WHERE location_id = $1', [floor.id],
        ) as Array<{ revision: number | string }>;
        if (active[0]) continue;
        if (history.length > 0) throw new LocationStorageUnavailableError();

        const document = legacyFloorToBaseline(floor, registry.nodes.values());
        const assetProvenance = legacyStaticModelProvenance(document);
        await manager.query(
          `INSERT INTO public.location_published_revisions (location_id, revision, created_by, created_at, document, asset_provenance)
           VALUES ($1, 0, 'system-bootstrap', 0, $2::jsonb, $3::jsonb)`, [floor.id, JSON.stringify(document), JSON.stringify(assetProvenance)],
        );
        await manager.query(
          'INSERT INTO public.location_active_revisions (location_id, revision) VALUES ($1, 0)', [floor.id],
        );
      }
    });
    return registry;
  });
}
