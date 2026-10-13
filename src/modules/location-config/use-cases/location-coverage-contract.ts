import type { LocationDocument, LocationSensorAssignment } from '../domain/location-document.js';
import type { LegacySpatialProvenance } from '../domain/location-candidate.js';
import type { LocationRegistrySnapshot } from '../repositories/location-storage.js';

export interface SensorSeatCoverageCount {
  uid: string;
  coveredSeats: number;
}

export interface LocationTableCoverageSuggestion {
  tableId: string;
  coveredBy: string[];
  suggestedOwner: string | null;
  seatCoverage: {
    totalSeats: number;
    coveredSeats: number;
    bySensor: SensorSeatCoverageCount[];
  };
}

export type SuggestLocationCoverage = (
  siteSeed: unknown,
  snapshot: LocationRegistrySnapshot,
  document: LocationDocument,
  proposedSensors: readonly LocationSensorAssignment[],
  legacySpatial: LegacySpatialProvenance | null,
) => LocationTableCoverageSuggestion[];
