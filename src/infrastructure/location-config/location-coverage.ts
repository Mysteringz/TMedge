import { buildRegistryFromLocationDocuments, sensorSeesFloorPoint } from '../../edge/registry.js';
import type { LegacySpatialProvenance } from '../../modules/location-config/domain/location-candidate.js';
import { parseLocationDocument, type LocationDocument, type LocationSensorAssignment } from '../../modules/location-config/domain/location-document.js';
import type { LocationRegistrySnapshot } from '../../modules/location-config/repositories/location-storage.js';
import type { LocationTableCoverageSuggestion } from '../../modules/location-config/use-cases/location-coverage-contract.js';

/** Computes suggestions with the exact registry seat/coverage rules, without mutating the live registry. */
export function computeLocationCoverageSuggestions(
  siteSeed: unknown,
  snapshot: LocationRegistrySnapshot,
  inputDocument: unknown,
  proposed: readonly LocationSensorAssignment[],
  candidateLegacySpatial: LegacySpatialProvenance | null = null,
): LocationTableCoverageSuggestion[] {
  const parsed = parseLocationDocument({ ...(inputDocument as Record<string, unknown>), sensorAssignments: proposed.map((item) => ({ ...item, owns: [] })) });
  const eligible = new Map(snapshot.nodes.map((node) => [node.uid.toLowerCase(), node]));
  for (const assignment of proposed) {
    const node = eligible.get(assignment.uid.toLowerCase());
    if (!node || (node.floorId !== null && node.floorId !== parsed.locationId)
      || (node.floorId === null && (node.pose !== null || node.owns.length > 0))
      || (node.rgb && parsed.visibility !== 'console')) throw new TypeError('A proposed sensor is not eligible for this location.');
  }
  const proposedByUid = new Map(proposed.map((item) => [item.uid.toLowerCase(), item]));
  const nodes = snapshot.nodes.map((node) => {
    const assignment = proposedByUid.get(node.uid.toLowerCase());
    if (node.floorId === parsed.locationId || assignment) {
      return assignment
        ? { uid: node.uid, label: node.label, floor: parsed.locationId, pose: assignment.pose, owns: [], simulated: node.simulated, rgb: node.rgb, detector: node.detector }
        : { uid: node.uid, label: node.label, owns: [], simulated: node.simulated, rgb: node.rgb, detector: node.detector };
    }
    return {
      uid: node.uid, label: node.label,
      ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
      owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
    };
  });
  const documents = snapshot.locations.flatMap((state) => {
    if (state.locationId === parsed.locationId || state.activeRevision === 0) return [];
    const active = state.history.find((item) => item.revision === state.activeRevision);
    return active ? [parseLocationDocument(active.document)] : [];
  });
  documents.push(parsed);
  const legacySpatial = new Map(snapshot.locations.flatMap((state) => {
    if (state.locationId === parsed.locationId) return [];
    const active = state.history.find((item) => item.revision === state.activeRevision);
    return state.activeRevision !== 0 && active?.legacySpatial ? [[state.locationId, active.legacySpatial] as const] : [];
  }));
  if (candidateLegacySpatial) legacySpatial.set(parsed.locationId, candidateLegacySpatial);
  const registry = buildRegistryFromLocationDocuments(siteSeed, { nodes }, documents, legacySpatial);
  const floor = registry.floors.find((item) => item.id === parsed.locationId);
  if (!floor) throw new Error('The candidate location could not be assembled.');
  const proposedIds = new Set(proposed.map((item) => item.uid.toLowerCase()));
  const candidateNodes = new Map([...registry.nodes].map(([uid, node]) => [uid.toLowerCase(), node]));
  return floor.tables.map((table) => {
    const coveredBy = table.coveredBy.filter((uid) => proposedIds.has(uid.toLowerCase()));
    const counts = new Map(proposed.map((item) => [item.uid.toLowerCase(), 0]));
    let coveredSeats = 0;
    for (const seat of table.seats) {
      let seatCovered = false;
      for (const [uid, node] of candidateNodes) {
        if (!proposedIds.has(uid) || node.floorId !== parsed.locationId || !node.pose
          || !sensorSeesFloorPoint(node.pose, seat.x, seat.y)) continue;
        counts.set(uid, (counts.get(uid) ?? 0) + 1);
        seatCovered = true;
      }
      if (seatCovered) coveredSeats += 1;
    }
    const bySensor = proposed.map((item) => ({
      uid: candidateNodes.get(item.uid.toLowerCase())?.uid ?? item.uid,
      coveredSeats: counts.get(item.uid.toLowerCase()) ?? 0,
    }));
    return {
      tableId: table.id, coveredBy, suggestedOwner: coveredBy[0] ?? null,
      seatCoverage: { totalSeats: table.seats.length, coveredSeats, bySensor },
    };
  });
}

export function activeLocationDocuments(snapshot: LocationRegistrySnapshot): {
  documents: LocationDocument[];
  legacySpatialByLocation: Map<string, NonNullable<LocationRegistrySnapshot['locations'][number]['history'][number]['legacySpatial']>>;
} {
  const legacySpatialByLocation = new Map<string, NonNullable<LocationRegistrySnapshot['locations'][number]['history'][number]['legacySpatial']>>();
  const documents = snapshot.locations.flatMap((state) => {
    if (state.activeRevision === 0) return [];
    const active = state.history.find((item) => item.revision === state.activeRevision);
    return active ? [parseLocationDocument(active.document)] : [];
  });
  for (const state of snapshot.locations) {
    const active = state.history.find((item) => item.revision === state.activeRevision);
    if (state.activeRevision !== 0 && active?.legacySpatial) legacySpatialByLocation.set(state.locationId, active.legacySpatial);
  }
  return { documents, legacySpatialByLocation };
}
