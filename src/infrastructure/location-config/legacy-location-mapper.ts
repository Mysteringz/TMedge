import type { FloorDef, NodeDef } from '../../edge/registry.js';
import type {
  FloorPoint, LocationModelTransform, LocationSensorAssignment, LocationSeat, LocationZone, TableShape,
  TrustedLegacyLocationBaseline, TrustedLegacyLocationTable,
} from '../../modules/location-config/domain/location-document.js';
import type { Rect } from '../../shared/types.js';
import { tableBounds } from '../../shared/table-geometry.js';

/** Converts a registry-validated seed to trusted revision-0 data without authored-document bounds. */
export function legacyFloorToBaseline(floor: FloorDef, nodes: Iterable<NodeDef>): TrustedLegacyLocationBaseline {
  const sensorAssignments = [...nodes]
    .filter((node): node is NodeDef & { pose: NonNullable<NodeDef['pose']> } => node.floorId === floor.id && node.pose !== null)
    .map((node): LocationSensorAssignment => ({ uid: node.uid, pose: { ...node.pose }, owns: [...node.owns] }));
  return {
    schemaVersion: 1,
    locationId: floor.id,
    name: floor.name,
    building: floor.building,
    visibility: floor.visibility,
    widthCm: floor.width,
    heightCm: floor.height,
    outline: clonePoints(floor.outline),
    zones: floor.zones.map((zone): LocationZone => ({ id: zone.id, name: zone.name, polygon: clonePoints(zone.polygon) })),
    tables: floor.tables.map(toLegacyTable),
    sensorAssignments,
    ...(floor.model ? { modelAssetId: floor.model.assetId, modelTransform: floor.model.transform } : {}),
  };
}

/** Revalidates a persisted system-created revision-0 row without authored geometry restrictions. */
export function parseTrustedLegacyBaseline(value: unknown): TrustedLegacyLocationBaseline {
  const root = object(value, 'legacy baseline');
  only(root, ['schemaVersion', 'locationId', 'name', 'building', 'visibility', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments', 'modelAssetId', 'modelTransform']);
  if (root.schemaVersion !== 1 || root.visibility !== 'public' && root.visibility !== 'console') throw new TypeError('Legacy baseline metadata is invalid.');
  const widthCm = finiteRange(root.widthCm, 100, 100000, 'legacy width');
  const heightCm = finiteRange(root.heightCm, 100, 100000, 'legacy height');
  const zones = array(root.zones, 'legacy zones').map(parseLegacyZone);
  const zoneIds = new Set(zones.map((zone) => zone.id));
  if (!zones.length || zoneIds.size !== zones.length) throw new TypeError('Legacy baseline zones are invalid.');
  const tables = array(root.tables, 'legacy tables').map((item) => parseLegacyTable(item, zoneIds));
  if (new Set(tables.map((table) => table.id)).size !== tables.length
    || new Set(tables.flatMap((table) => table.seats.map((seat) => seat.id))).size !== tables.reduce((sum, table) => sum + table.seats.length, 0)) {
    throw new TypeError('Legacy baseline table and seat IDs must be unique.');
  }
  return {
    schemaVersion: 1,
    locationId: nonEmpty(root.locationId, 'legacy location ID'),
    name: nonEmpty(root.name, 'legacy location name'),
    building: nonEmpty(root.building, 'legacy building name'),
    visibility: root.visibility,
    widthCm,
    heightCm,
    outline: points(root.outline, 'legacy outline'),
    zones,
    tables,
    sensorAssignments: array(root.sensorAssignments, 'legacy sensor assignments').map(parseLegacyAssignment),
    ...parseModel(root.modelAssetId, root.modelTransform),
  };
}

function toLegacyTable(table: FloorDef['tables'][number]): TrustedLegacyLocationTable {
  return {
    id: table.id,
    name: table.name,
    zoneId: table.zoneId,
    capacity: table.capacity,
    rect: { ...table.rect },
    ...(table.shapeAuthored ? { shape: structuredClone(table.shape) } : {}),
    seats: table.seats.map((seat): LocationSeat => ({
      id: seat.id, x: seat.x, y: seat.y, neighbors: [...seat.neighbors], side: seat.side, index: seat.index,
    })),
    ...(table.seatRadiusCm === null ? {} : { seatRadiusCm: table.seatRadiusCm }),
  };
}

function parseLegacyZone(value: unknown): LocationZone {
  const input = object(value, 'legacy zone');
  only(input, ['id', 'name', 'polygon']);
  return { id: nonEmpty(input.id, 'legacy zone ID'), name: nonEmpty(input.name, 'legacy zone name'), polygon: points(input.polygon, 'legacy zone polygon') };
}

function parseLegacyTable(value: unknown, zoneIds: ReadonlySet<string>): TrustedLegacyLocationTable {
  const input = object(value, 'legacy table');
  only(input, ['id', 'name', 'zoneId', 'capacity', 'rect', 'shape', 'seats', 'seatRadiusCm']);
  const id = nonEmpty(input.id, 'legacy table ID');
  const capacity = integerRange(input.capacity, 1, 20, 'legacy table capacity');
  const rect = parseRect(input.rect);
  const shape = input.shape === undefined ? undefined : parseShape(input.shape);
  const zoneId = nonEmpty(input.zoneId, 'legacy table zone ID');
  if (!zoneIds.has(zoneId) || !Array.isArray(input.seats) || input.seats.length !== capacity) {
    throw new TypeError('Legacy table zone or seat count is invalid.');
  }
  if (shape && !sameRect(rect, tableBounds(shape))) throw new TypeError('Legacy table shape and rectangle disagree.');
  const table: TrustedLegacyLocationTable = {
    id, name: nonEmpty(input.name, 'legacy table name'), zoneId, capacity, rect,
    ...(shape ? { shape } : {}), seats: input.seats.map(parseLegacySeat),
  };
  if (input.seatRadiusCm !== undefined) table.seatRadiusCm = finiteRange(input.seatRadiusCm, 20, 150, 'legacy seat radius');
  return table;
}

function parseLegacySeat(value: unknown): LocationSeat {
  const input = object(value, 'legacy seat');
  only(input, ['id', 'x', 'y', 'neighbors', 'side', 'index']);
  if (!Array.isArray(input.neighbors) || !input.neighbors.every((item) => typeof item === 'string')) throw new TypeError('Legacy seat neighbors are invalid.');
  const seat: LocationSeat = {
    id: nonEmpty(input.id, 'legacy seat ID'),
    x: finite(input.x, 'legacy seat x'),
    y: finite(input.y, 'legacy seat y'),
    neighbors: [...input.neighbors] as string[],
  };
  if (input.side !== undefined) {
    if (input.side !== 'L' && input.side !== 'R' && input.side !== 'T' && input.side !== 'B') throw new TypeError('Legacy seat side is invalid.');
    seat.side = input.side;
  }
  if (input.index !== undefined) seat.index = integerRange(input.index, 0, 10000, 'legacy seat index');
  return seat;
}

function parseLegacyAssignment(value: unknown): LocationSensorAssignment {
  const input = object(value, 'legacy sensor assignment');
  only(input, ['uid', 'pose', 'owns']);
  const pose = object(input.pose, 'legacy sensor pose');
  only(pose, ['x', 'y', 'heightCm', 'yawDeg', 'mirror']);
  if (typeof pose.mirror !== 'boolean' || !Array.isArray(input.owns) || !input.owns.every((id) => typeof id === 'string')) {
    throw new TypeError('Legacy sensor assignment is invalid.');
  }
  return {
    uid: nonEmpty(input.uid, 'legacy sensor UID'),
    pose: {
      x: finite(pose.x, 'legacy sensor x'), y: finite(pose.y, 'legacy sensor y'),
      heightCm: finite(pose.heightCm, 'legacy sensor height'), yawDeg: finite(pose.yawDeg, 'legacy sensor yaw'), mirror: pose.mirror,
    },
    owns: [...input.owns] as string[],
  };
}

function parseShape(value: unknown): TableShape {
  const input = object(value, 'legacy table shape');
  if (input.type === 'rect') {
    only(input, ['type', 'x', 'y', 'width', 'height']);
    return { type: 'rect', x: finite(input.x, 'shape x'), y: finite(input.y, 'shape y'), width: finitePositive(input.width, 'shape width'), height: finitePositive(input.height, 'shape height') };
  }
  if (input.type === 'circle') {
    only(input, ['type', 'cx', 'cy', 'radius']);
    return { type: 'circle', cx: finite(input.cx, 'shape center x'), cy: finite(input.cy, 'shape center y'), radius: finitePositive(input.radius, 'shape radius') };
  }
  if (input.type === 'polygon') {
    only(input, ['type', 'points']);
    return { type: 'polygon', points: points(input.points, 'legacy table shape points') };
  }
  throw new TypeError('Legacy table shape is invalid.');
}

function parseRect(value: unknown): Rect {
  const input = object(value, 'legacy table rect');
  only(input, ['x', 'y', 'width', 'height']);
  return { x: finite(input.x, 'legacy rect x'), y: finite(input.y, 'legacy rect y'), width: finitePositive(input.width, 'legacy rect width'), height: finitePositive(input.height, 'legacy rect height') };
}

function parseModel(assetId: unknown, transform: unknown): Pick<TrustedLegacyLocationBaseline, 'modelAssetId' | 'modelTransform'> {
  if (assetId === undefined && transform === undefined) return {};
  const root = object(transform, 'legacy model transform');
  only(root, ['scale', 'rotationDeg', 'positionM']);
  return { modelAssetId: nonEmpty(assetId, 'legacy model asset ID'), modelTransform: {
    scale: vector(root.scale), rotationDeg: vector(root.rotationDeg), positionM: vector(root.positionM),
  } };
}

function vector(value: unknown): LocationModelTransform['scale'] {
  const input = object(value, 'legacy model vector');
  only(input, ['x', 'y', 'z']);
  return { x: finite(input.x, 'model x'), y: finite(input.y, 'model y'), z: finite(input.z, 'model z') };
}

function points(value: unknown, label: string): FloorPoint[] {
  if (!Array.isArray(value) || value.length < 3) throw new TypeError(`${label} is invalid.`);
  return value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) throw new TypeError(`${label} point is invalid.`);
    return [finite(item[0], `${label} x`), finite(item[1], `${label} y`)];
  });
}

function clonePoints(value: readonly FloorPoint[]): FloorPoint[] { return value.map(([x, y]) => [x, y]); }
function sameRect(a: Rect, b: Rect): boolean { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`); return value; }
function only(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError('Legacy baseline has an unknown field.'); }
function nonEmpty(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is invalid.`); return value; }
function finite(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} is invalid.`); return value; }
function finitePositive(value: unknown, label: string): number { const number = finite(value, label); if (number <= 0) throw new TypeError(`${label} must be positive.`); return number; }
function finiteRange(value: unknown, min: number, max: number, label: string): number { const number = finite(value, label); if (number < min || number > max) throw new TypeError(`${label} is out of range.`); return number; }
function integerRange(value: unknown, min: number, max: number, label: string): number { const number = finiteRange(value, min, max, label); if (!Number.isInteger(number)) throw new TypeError(`${label} must be an integer.`); return number; }
