import type { LocationDocument } from '../../../entities/location-config/model/types.ts';

/** Remove one private table with its seats and ownership; preserve sensors, zones and shared assets. */
export function removeTable(document: LocationDocument, tableId: string): LocationDocument {
  if (!document.tables.some(table => table.id === tableId)) return document;
  return {
    ...document,
    tables: document.tables.filter(table => table.id !== tableId),
    sensorAssignments: document.sensorAssignments.map(assignment => assignment.owns.includes(tableId)
      ? { ...assignment, owns: assignment.owns.filter(id => id !== tableId) }
      : assignment),
  };
}
