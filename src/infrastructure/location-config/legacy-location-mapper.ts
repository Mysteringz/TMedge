import type { FloorDef, NodeDef } from '../../edge/registry.js';
import { parseLocationDocument, type LocationDocument, type LocationSensorAssignment } from '../../modules/location-config/domain/location-document.js';

/** Converts the current runtime floor shape without losing legacy zone or seat identity. */
export function legacyFloorToLocationDocument(floor: FloorDef, nodes: Iterable<NodeDef>): LocationDocument {
  const tables = floor.tables.map((table) => ({
    id: table.id,
    name: table.name,
    zoneId: table.zoneId,
    capacity: table.capacity,
    shape: { type: 'rect' as const, ...table.rect },
    seats: table.seats.map((seat) => ({
      id: seat.id,
      x: seat.x,
      y: seat.y,
      neighbors: [...seat.neighbors],
      side: seat.side,
      index: seat.index,
    })),
    ...(table.seatRadiusCm === null ? {} : { seatRadiusCm: table.seatRadiusCm }),
  }));
  const sensorAssignments: LocationSensorAssignment[] = [...nodes]
    .filter((node) => node.floorId === floor.id && node.pose !== null)
    .map((node) => ({
      uid: node.uid,
      pose: { ...node.pose! },
      owns: [...node.owns],
    }));
  return parseLocationDocument({
    schemaVersion: 1,
    locationId: floor.id,
    name: floor.name,
    building: floor.building,
    visibility: floor.visibility,
    widthCm: floor.width,
    heightCm: floor.height,
    outline: floor.outline,
    zones: floor.zones.map((zone) => ({ id: zone.id, name: zone.name, polygon: zone.polygon })),
    tables,
    sensorAssignments,
  });
}
