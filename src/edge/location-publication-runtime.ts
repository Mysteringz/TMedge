import { parseLocationDocument, type LocationDocument } from '../modules/location-config/domain/location-document.js';
import type { LegacySpatialProvenance } from '../modules/location-config/domain/location-candidate.js';
import { activeLocationModelDispositions, type LocationModelPresentationDisposition } from '../modules/location-config/domain/location-assets.js';
import type {
  LocationRegistrySnapshot,
  PreparedLocationRuntime,
} from '../modules/location-config/repositories/location-storage.js';
import { buildRegistryFromLocationDocuments, type Registry } from './registry.js';
import type { EdgeRuntime, PreparedRuntimeGeneration } from './runtime.js';

/** Adapts a complete durable candidate to the edge's prepared generation port. */
export class EdgeLocationPublicationRuntime implements PreparedLocationRuntime<PreparedRuntimeGeneration> {
  constructor(private readonly runtime: EdgeRuntime, private readonly siteSeed: unknown) {}

  prepare(snapshot: LocationRegistrySnapshot, candidate: LocationDocument, legacySpatial?: LegacySpatialProvenance | null, candidateDisposition?: LocationModelPresentationDisposition): PreparedRuntimeGeneration {
    const nodes = snapshot.nodes.map((node) => ({
      ...node,
      pose: node.pose ? { ...node.pose } : null,
      owns: [...node.owns],
    }));
    const assignments = new Map(candidate.sensorAssignments.map((assignment) => [assignment.uid.toLowerCase(), assignment]));

    for (const node of nodes) {
      if (node.floorId === candidate.locationId) {
        const assignment = assignments.get(node.uid.toLowerCase());
        node.floorId = assignment ? candidate.locationId : null;
        node.pose = assignment ? { ...assignment.pose } : null;
        node.owns = assignment ? [...assignment.owns] : [];
      }
    }
    for (const assignment of candidate.sensorAssignments) {
      const node = nodes.find((item) => item.uid.toLowerCase() === assignment.uid.toLowerCase());
      if (!node) throw new Error(`Candidate sensor ${assignment.uid} is missing from the registry snapshot.`);
      node.floorId = candidate.locationId;
      node.pose = { ...assignment.pose };
      node.owns = [...assignment.owns];
    }

    const { documents, legacySpatialByLocation, modelDispositionByLocation } = activeDocuments(snapshot.locations, candidate, legacySpatial ?? null);
    if (candidateDisposition) modelDispositionByLocation.set(candidate.locationId, candidateDisposition);
    else modelDispositionByLocation.delete(candidate.locationId);
    const registry: Registry = buildRegistryFromLocationDocuments(this.siteSeed, {
      nodes: nodes.map((node) => ({
        uid: node.uid, label: node.label,
        ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
        owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
      })),
    }, documents, legacySpatialByLocation, modelDispositionByLocation);
    return this.runtime.prepareGeneration(registry);
  }

  refresh(prepared: PreparedRuntimeGeneration): PreparedRuntimeGeneration {
    return this.runtime.refreshPreparedGeneration(prepared);
  }

  activate(prepared: PreparedRuntimeGeneration): void {
    this.runtime.activatePreparedGeneration(prepared);
  }

  quarantine(reason: unknown): void {
    this.runtime.quarantine(reason);
  }
}

function activeDocuments(
  locations: LocationRegistrySnapshot['locations'],
  candidate: LocationDocument,
  candidateSpatial: LegacySpatialProvenance | null,
): {
  documents: LocationDocument[];
  legacySpatialByLocation: Map<string, LegacySpatialProvenance>;
  modelDispositionByLocation: Map<string, LocationModelPresentationDisposition>;
} {
  const legacySpatialByLocation = new Map<string, LegacySpatialProvenance>();
  const modelDispositionByLocation = activeLocationModelDispositions(locations);
  const documents = locations.flatMap((state) => {
    const revision = state.history.find((item) => item.revision === state.activeRevision);
    if (!revision) return [];
    if (state.activeRevision !== 0 && revision.legacySpatial) legacySpatialByLocation.set(revision.locationId, revision.legacySpatial);
    if (state.activeRevision === 0) return [];
    return [parseLocationDocument(revision.document)];
  });
  if (candidateSpatial) legacySpatialByLocation.set(candidate.locationId, candidateSpatial);
  else legacySpatialByLocation.delete(candidate.locationId);
  // Candidate disposition is supplied by the publishing use case after it
  // validates the exact asset provenance. The active value is replaced there.
  const index = documents.findIndex((document) => document.locationId === candidate.locationId);
  if (index < 0) documents.push(candidate);
  else documents[index] = candidate;
  return { documents, legacySpatialByLocation, modelDispositionByLocation };
}
