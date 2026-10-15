import type { Registry } from '../../edge/registry.js';
import { buildRegistryFromLocationDocuments } from '../../edge/registry.js';
import { legacyFloorToBaseline } from '../location-config/legacy-location-mapper.js';
import { parseLocationDocument } from '../../modules/location-config/domain/location-document.js';
import { activeLocationModelDispositions } from '../../modules/location-config/domain/location-assets.js';
import type { LocationRegistrySnapshot, LocationRegistrySnapshotRepository, PublishedLocationRepository } from '../../modules/location-config/repositories/location-storage.js';
import type { RegistryRepository } from '../../modules/registration/repositories/registry-repository.js';

/** Builds an application-owned snapshot from the latest PostgreSQL nodes and active location revisions. */
export class PostgresLocationRegistrySnapshotRepository implements LocationRegistrySnapshotRepository {
  constructor(
    private readonly siteSeed: unknown,
    private readonly nodesRepository: RegistryRepository,
    private readonly publishedRepository: PublishedLocationRepository,
  ) {}

  async readSnapshot(): Promise<LocationRegistrySnapshot> {
    const nodeRecords = await this.nodesRepository.listNodes();
    const locations = await this.publishedRepository.listActive();
    const nodes = nodeRecords.map((node) => ({
      uid: node.uid, label: node.label, floorId: node.floorId, pose: node.pose ? { ...node.pose } : null,
      owns: [...node.owns], simulated: node.simulated, rgb: node.rgb, detector: node.detector,
    }));
    const nodeInput = { nodes: nodes.map((node) => ({
      uid: node.uid, label: node.label,
      ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
      owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
    })) };
    const authoredDocuments = locations.flatMap((state) => {
      if (state.removal || state.activeRevision === 0) return [];
      const active = state.history.find((item) => item.revision === state.activeRevision);
      return active ? [parseLocationDocument(active.document)] : [];
    });
    const legacySpatialByLocation = new Map(locations.flatMap((state) => {
      const active = state.history.find((item) => item.revision === state.activeRevision);
      return state.activeRevision !== 0 && active?.legacySpatial ? [[state.locationId, active.legacySpatial] as const] : [];
    }));
    const modelDispositionByLocation = activeLocationModelDispositions(locations);
    const currentRegistry: Registry = buildRegistryFromLocationDocuments(this.siteSeed, nodeInput, authoredDocuments, legacySpatialByLocation, modelDispositionByLocation, new Set(locations.filter(row => row.removal).map(row => row.locationId)));
    const withCurrentLegacyAssignments = locations.map((state) => {
      if (state.activeRevision !== 0) return state;
      const floor = currentRegistry.floors.find((item) => item.id === state.locationId);
      if (!floor) return state;
      const document = legacyFloorToBaseline(floor, currentRegistry.nodes.values());
      return {
        ...state,
        history: state.history.map((revision) => revision.revision === 0 ? { ...revision, document } : revision),
      };
    });
    return {
      registryRevision: await this.publishedRepository.registryRevision(),
      nodes: [...currentRegistry.nodes.values()].map((node) => ({ ...node, owns: [...node.owns], pose: node.pose ? { ...node.pose } : null, detector: node.detector ?? 'node' })),
      locations: withCurrentLegacyAssignments,
    };
  }
}
