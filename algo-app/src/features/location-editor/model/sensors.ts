import { canonicalY } from './display-coordinates.ts';
import type { CoverageSuggestionResponse, EligibleSensor, LocationDocument, ProposedSensor, SensorAssignment, TableCoverageSuggestion } from '../../../entities/location-config/model/types.ts';

export type SeatCoverageState = 'none' | 'partial' | 'full' | 'unknown';
export type EditablePoseField = 'x' | 'y' | 'height' | 'yaw';

/** Convert one displayed sensor field without rewriting an untouched canonical value. */
export function changedPoseField(pose: SensorAssignment['pose'], field: EditablePoseField, value: number, roomHeightCm?: number): Partial<SensorAssignment['pose']> | null {
  if (field === 'x') return value === pose.x / 100 || value * 100 === pose.x ? null : { x: value * 100 };
  if (field === 'y' && roomHeightCm !== undefined) {
    const y = canonicalY(value, roomHeightCm, pose.y);
    return y === pose.y ? null : { y };
  }
  if (field === 'y') return value === pose.y / 100 || value * 100 === pose.y ? null : { y: value * 100 };
  if (field === 'height') return value === pose.heightCm / 100 || value * 100 === pose.heightCm ? null : { heightCm: value * 100 };
  return value === pose.yawDeg ? null : { yawDeg: value };
}

/** Build the complete, current eligible proposal set from assignments saved in this private document. */
export function proposedSensors(document: LocationDocument, eligible: readonly EligibleSensor[]): ProposedSensor[] {
  const current = new Set(eligible.map((sensor) => sensor.uid.toLowerCase()));
  return document.sensorAssignments
    .filter((assignment) => current.has(assignment.uid.toLowerCase()))
    .map(({ uid, pose }) => ({ uid, pose: { ...pose } }));
}

/** Add an explicitly completed pose for an eligible, currently unassigned sensor. */
export function addSensorAssignment(document: LocationDocument, uid: string, pose: SensorAssignment['pose']): LocationDocument {
  if (document.sensorAssignments.some((assignment) => assignment.uid.toLowerCase() === uid.toLowerCase())) return document;
  return { ...document, sensorAssignments: [...document.sensorAssignments, { uid: uid.toLowerCase(), pose: { ...pose }, owns: [] }] };
}

/** Update only the requested pose fields, retaining height/mirror and other untouched values. */
export function patchSensorPose(document: LocationDocument, uid: string, patch: Partial<SensorAssignment['pose']>): LocationDocument {
  return {
    ...document,
    sensorAssignments: document.sensorAssignments.map((assignment) => assignment.uid.toLowerCase() === uid.toLowerCase()
      ? { ...assignment, pose: { ...assignment.pose, ...patch } }
      : assignment),
  };
}

/** Remove an assignment and its table ownership from the private candidate only. */
export function removeSensorAssignment(document: LocationDocument, uid: string): LocationDocument {
  return { ...document, sensorAssignments: document.sensorAssignments.filter((assignment) => assignment.uid.toLowerCase() !== uid.toLowerCase()) };
}

/** Assign one primary owner per table; accepting a suggestion never changes another table. */
export function setTableOwner(document: LocationDocument, tableId: string, ownerUid: string | null): LocationDocument {
  if (ownerUid && !document.sensorAssignments.some((assignment) => assignment.uid.toLowerCase() === ownerUid.toLowerCase())) return document;
  return {
    ...document,
    sensorAssignments: document.sensorAssignments.map((assignment) => {
      const owns = assignment.owns.filter((id) => id !== tableId);
      if (ownerUid && assignment.uid.toLowerCase() === ownerUid.toLowerCase()) owns.push(tableId);
      return owns.length === assignment.owns.length && owns.every((id, index) => id === assignment.owns[index])
        ? assignment
        : { ...assignment, owns };
    }),
  };
}

export function coverageState(row: TableCoverageSuggestion | undefined): SeatCoverageState {
  if (!row || !Number.isFinite(row.seatCoverage.totalSeats) || !Number.isFinite(row.seatCoverage.coveredSeats)) return 'unknown';
  if (row.seatCoverage.totalSeats <= 0 || row.seatCoverage.coveredSeats <= 0) return 'none';
  if (row.seatCoverage.coveredSeats < row.seatCoverage.totalSeats) return 'partial';
  return 'full';
}

export function ownerSeatCount(row: TableCoverageSuggestion | undefined, uid: string | undefined): number | null {
  if (!row || !uid) return null;
  const sensor = row.seatCoverage.bySensor.find((item) => item.uid.toLowerCase() === uid.toLowerCase());
  return sensor && Number.isFinite(sensor.coveredSeats) ? sensor.coveredSeats : null;
}

export function tableCoverageMap(result: CoverageSuggestionResponse | null): Map<string, TableCoverageSuggestion> {
  return new Map((result?.suggestions ?? []).map((row) => [row.tableId, row]));
}
