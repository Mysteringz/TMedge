import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { hasUniquePolygonVertices, LOCATION_GEOMETRY_EPSILON, LOCATION_MODEL_TRANSFORM_LIMITS, MAX_LOCATION_POLYGON_POINTS, polygonHasNonzeroArea, polygonHasSelfIntersection } from '../../../shared/location-validation.js';
import type { Rect, TableShape as SharedTableShape } from '../../../shared/types.js';

export type FloorPoint = [number, number];
export type SeatSide = 'L' | 'R' | 'T' | 'B';

export type TableShape = SharedTableShape;

export interface LocationZone {
  id: string;
  name: string;
  /** Zone-counting boundary in cm, with the floor's top-left as origin. */
  polygon: FloorPoint[];
}

export interface LocationSeat {
  id: string;
  x: number;
  y: number;
  neighbors: string[];
  side?: SeatSide;
  index?: number;
}

export interface LocationTable {
  id: string;
  name: string;
  zoneId: string;
  capacity: number;
  shape: TableShape;
  seats: LocationSeat[];
  seatRadiusCm?: number;
}

export interface LocationSensorAssignment {
  uid: string;
  pose: { x: number; y: number; heightCm: number; yawDeg: number; mirror: boolean };
  owns: string[];
}

export interface LocationModelTransform {
  scale: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  positionM: { x: number; y: number; z: number };
}

export interface LocationDocument {
  schemaVersion: 1;
  locationId: string;
  name: string;
  building: string;
  /** Server-managed privacy inherited from a legacy location; new locations are public. */
  visibility: 'public' | 'console';
  widthCm: number;
  heightCm: number;
  outline: FloorPoint[];
  zones: LocationZone[];
  tables: LocationTable[];
  sensorAssignments: LocationSensorAssignment[];
  planAssetId?: string;
  modelAssetId?: string;
  modelTransform?: LocationModelTransform;
}

/**
 * Trusted revision-0 seed data only. Never accept this shape at an authored
 * draft/request boundary; parseLocationDocument remains strict.
 */
export interface TrustedLegacyLocationBaseline extends Omit<LocationDocument, 'tables'> {
  tables: TrustedLegacyLocationTable[];
}

/** Shape is absent for synthesized legacy rectangles; rect preserves their bounds. */
export interface TrustedLegacyLocationTable extends Omit<LocationTable, 'shape'> {
  rect: Rect;
  shape?: TableShape;
}

export class InvalidLocationDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLocationDocumentError';
  }
}

const UID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/;
const EPSILON = LOCATION_GEOMETRY_EPSILON;
export const MAX_LOCATION_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_POLYGON_POINTS = MAX_LOCATION_POLYGON_POINTS;

/** Parses and validates persisted location JSON, rejecting unknown fields. */
export function parseLocationDocument(value: unknown): LocationDocument {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { fail('location: expected serializable JSON'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_LOCATION_DOCUMENT_BYTES) {
    fail(`location: document exceeds the ${MAX_LOCATION_DOCUMENT_BYTES}-byte limit`);
  }
  const root = record(value, 'location');
  only(root, 'location', ['schemaVersion', 'locationId', 'name', 'building', 'visibility', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments', 'planAssetId', 'modelAssetId', 'modelTransform']);
  if (root.schemaVersion !== 1) fail('location.schemaVersion: expected 1');
  const visibility = root.visibility === undefined ? 'public' : root.visibility;
  if (visibility !== 'public' && visibility !== 'console') fail('location.visibility: expected public or console');
  const widthCm = number(root.widthCm, 'location.widthCm', 100, 100000);
  const heightCm = number(root.heightCm, 'location.heightCm', 100, 100000);
  const outline = polygon(root.outline, 'location.outline', widthCm, heightCm, true);
  if (!Array.isArray(root.zones) || !Array.isArray(root.tables) || !Array.isArray(root.sensorAssignments)) fail('location.zones, tables and sensorAssignments must be arrays');
  const zones = root.zones.map((zone, index) => parseZone(zone, index, widthCm, heightCm));
  validateUnique(zones.map((item) => item.id), 'zone IDs');
  const tables = root.tables.map((table, index) => parseTable(table, index, zones, widthCm, heightCm));
  validateUnique(tables.map((item) => item.id), 'table IDs');
  validateUnique(tables.flatMap((item) => item.seats.map((seat) => seat.id)), 'seat IDs');
  const sensorAssignments = root.sensorAssignments.map((item, index) => parseAssignment(item, index, tables, widthCm, heightCm));
  validateUnique(sensorAssignments.map((item) => item.uid), 'sensor assignments');
  const result: LocationDocument = {
    schemaVersion: 1,
    locationId: locationId(root.locationId),
    name: nonEmpty(root.name, 'location.name'),
    building: nonEmpty(root.building, 'location.building'),
    visibility,
    widthCm, heightCm, outline, zones, tables, sensorAssignments,
  };
  addAssetFields(root, result);
  return result;
}

/** Makes a collision-resistant server-side location ID in the edge namespace. */
export function createLocationId(edgeId: string, uuid = randomUUID()): string {
  if (!EDGE_ID_RE.test(edgeId) || !UUID_RE.test(uuid)) fail('edgeId or UUID is invalid');
  return `location_${edgeId}_${uuid.toLowerCase()}`;
}

/** Accepts legacy seed IDs and the generated namespaced IDs, never path-like IDs. */
export function isLocationId(value: string): boolean {
  return ID_RE.test(value) && value.length <= 160;
}

function parseZone(value: unknown, index: number, width: number, height: number): LocationZone {
  const where = `location.zones[${index}]`;
  const input = record(value, where);
  only(input, where, ['id', 'name', 'polygon']);
  return {
    id: safeId(input.id, `${where}.id`),
    name: nonEmpty(input.name, `${where}.name`),
    polygon: polygon(input.polygon, `${where}.polygon`, width, height, true),
  };
}

function parseTable(value: unknown, index: number, zones: LocationZone[], width: number, height: number): LocationTable {
  const where = `location.tables[${index}]`;
  const input = record(value, where);
  only(input, where, ['id', 'name', 'zoneId', 'capacity', 'shape', 'seats', 'seatRadiusCm']);
  const capacity = integer(input.capacity, `${where}.capacity`, 1, 20);
  const zoneId = safeId(input.zoneId, `${where}.zoneId`);
  if (!zones.some((zone) => zone.id === zoneId)) fail(`${where}.zoneId: no zone ${zoneId}`);
  const shape = parseShape(input.shape, `${where}.shape`, width, height);
  if (!Array.isArray(input.seats) || input.seats.length !== capacity) fail(`${where}.seats: expected exactly ${capacity} seats`);
  const seats = input.seats.map((seat, seatIndex) => parseSeat(seat, `${where}.seats[${seatIndex}]`, width, height));
  const ids = new Set(seats.map((seat) => seat.id));
  for (const seat of seats) {
    validateUnique(seat.neighbors, `${where}.seats.${seat.id}.neighbors`);
    if (seat.neighbors.some((id) => id === seat.id || !ids.has(id))) fail(`${where}.seats.${seat.id}.neighbors: every neighbor must be another seat on this table`);
    if (seat.neighbors.some((id) => !seats.find((candidate) => candidate.id === id)?.neighbors.includes(seat.id))) fail(`${where}.seats.${seat.id}.neighbors: adjacency must be symmetric`);
  }
  const result: LocationTable = { id: safeId(input.id, `${where}.id`), name: nonEmpty(input.name, `${where}.name`), zoneId, capacity, shape, seats };
  if (input.seatRadiusCm !== undefined) result.seatRadiusCm = number(input.seatRadiusCm, `${where}.seatRadiusCm`, 20, 150);
  return result;
}

function parseShape(value: unknown, where: string, width: number, height: number): TableShape {
  const input = record(value, where);
  if (input.type === 'rect') {
    only(input, where, ['type', 'x', 'y', 'width', 'height']);
    const shape = { type: 'rect' as const, x: number(input.x, `${where}.x`, 0, width), y: number(input.y, `${where}.y`, 0, height), width: number(input.width, `${where}.width`, EPSILON, width), height: number(input.height, `${where}.height`, EPSILON, height) };
    if (shape.x + shape.width > width || shape.y + shape.height > height) fail(`${where}: rectangle extends past the floor`);
    return shape;
  }
  if (input.type === 'circle') {
    only(input, where, ['type', 'cx', 'cy', 'radius']);
    const shape = { type: 'circle' as const, cx: number(input.cx, `${where}.cx`, 0, width), cy: number(input.cy, `${where}.cy`, 0, height), radius: number(input.radius, `${where}.radius`, EPSILON, Math.min(width, height)) };
    if (shape.cx - shape.radius < 0 || shape.cy - shape.radius < 0 || shape.cx + shape.radius > width || shape.cy + shape.radius > height) fail(`${where}: circle extends past the floor`);
    return shape;
  }
  if (input.type === 'polygon') {
    only(input, where, ['type', 'points']);
    return { type: 'polygon', points: polygon(input.points, `${where}.points`, width, height, true) };
  }
  fail(`${where}.type: expected rect, circle or polygon`);
}

function parseSeat(value: unknown, where: string, width: number, height: number): LocationSeat {
  const input = record(value, where);
  only(input, where, ['id', 'x', 'y', 'neighbors', 'side', 'index']);
  if (!Array.isArray(input.neighbors) || !input.neighbors.every((id) => typeof id === 'string')) fail(`${where}.neighbors: expected an array of seat IDs`);
  const seat: LocationSeat = { id: safeId(input.id, `${where}.id`), x: number(input.x, `${where}.x`, 0, width), y: number(input.y, `${where}.y`, 0, height), neighbors: [...input.neighbors] as string[] };
  if (input.side !== undefined) {
    if (input.side !== 'L' && input.side !== 'R' && input.side !== 'T' && input.side !== 'B') fail(`${where}.side: expected L, R, T or B`);
    seat.side = input.side;
  }
  if (input.index !== undefined) seat.index = integer(input.index, `${where}.index`, 0, 10000);
  return seat;
}

function parseAssignment(value: unknown, index: number, tables: LocationTable[], width: number, height: number): LocationSensorAssignment {
  const where = `location.sensorAssignments[${index}]`;
  const input = record(value, where);
  only(input, where, ['uid', 'pose', 'owns']);
  if (typeof input.uid !== 'string' || !UID_RE.test(input.uid)) fail(`${where}.uid: expected a sensor MAC address`);
  if (!Array.isArray(input.owns) || !input.owns.every((id) => typeof id === 'string')) fail(`${where}.owns: expected table IDs`);
  const owns = [...input.owns] as string[];
  validateUnique(owns, `${where}.owns`);
  const knownTables = new Set(tables.map((table) => table.id));
  if (owns.some((id) => !knownTables.has(id))) fail(`${where}.owns: references a table outside this location`);
  const poseInput = record(input.pose, `${where}.pose`);
  only(poseInput, `${where}.pose`, ['x', 'y', 'heightCm', 'yawDeg', 'mirror']);
  if (typeof poseInput.mirror !== 'boolean') fail(`${where}.pose.mirror: expected true or false`);
  return {
    uid: input.uid.toLowerCase(),
    pose: { x: number(poseInput.x, `${where}.pose.x`, -1000, width + 1000), y: number(poseInput.y, `${where}.pose.y`, -1000, height + 1000), heightCm: number(poseInput.heightCm, `${where}.pose.heightCm`, 150, 1500), yawDeg: number(poseInput.yawDeg, `${where}.pose.yawDeg`, -360, 360), mirror: poseInput.mirror },
    owns,
  };
}

function addAssetFields(input: Record<string, unknown>, result: LocationDocument): void {
  for (const field of ['planAssetId', 'modelAssetId'] as const) {
    const value = input[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || !UUID_RE.test(value)) fail(`location.${field}: expected an opaque UUID`);
      result[field] = value.toLowerCase();
    }
  }
  if (input.modelTransform !== undefined) result.modelTransform = parseModelTransform(input.modelTransform);
  if ((result.modelAssetId === undefined) !== (result.modelTransform === undefined)) fail('location.modelAssetId and modelTransform must be supplied together');
}

function parseModelTransform(value: unknown): LocationModelTransform {
  const root = record(value, 'location.modelTransform');
  only(root, 'location.modelTransform', ['scale', 'rotationDeg', 'positionM']);
  const scale = vector(root.scale, 'location.modelTransform.scale', LOCATION_MODEL_TRANSFORM_LIMITS.scale.min, LOCATION_MODEL_TRANSFORM_LIMITS.scale.max);
  const rotationDeg = vector(root.rotationDeg, 'location.modelTransform.rotationDeg', LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.min, LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg.max);
  const positionM = vector(root.positionM, 'location.modelTransform.positionM', LOCATION_MODEL_TRANSFORM_LIMITS.positionM.min, LOCATION_MODEL_TRANSFORM_LIMITS.positionM.max);
  return { scale, rotationDeg, positionM };
}

function vector(value: unknown, where: string, min: number, max: number): { x: number; y: number; z: number } {
  const input = record(value, where);
  only(input, where, ['x', 'y', 'z']);
  return { x: number(input.x, `${where}.x`, min, max), y: number(input.y, `${where}.y`, min, max), z: number(input.z, `${where}.z`, min, max) };
}

function polygon(value: unknown, where: string, width: number, height: number, mustBeSimple: boolean): FloorPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_POLYGON_POINTS) {
    fail(`${where}: expected 3..${MAX_POLYGON_POINTS} points`);
  }
  const points = value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) fail(`${where}[${index}]: expected [x, y]`);
    return [number(point[0], `${where}[${index}].x`, 0, width), number(point[1], `${where}[${index}].y`, 0, height)] as FloorPoint;
  });
  if (!hasUniquePolygonVertices(points)) fail(`${where} points: duplicate value`);
  if (!polygonHasNonzeroArea(points)) fail(`${where}: polygon area must be non-zero`);
  if (mustBeSimple && polygonHasSelfIntersection(points)) fail(`${where}: polygon must not self-intersect`);
  return points;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where}: expected an object`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, where: string, allowed: string[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unknown field "${key}"`); }
function safeId(value: unknown, where: string): string { if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${where}: invalid stable ID`); return value; }
function locationId(value: unknown): string { if (typeof value !== 'string' || !isLocationId(value)) fail('location.locationId: invalid location ID'); return value; }
function nonEmpty(value: unknown, where: string): string { if (typeof value !== 'string' || value.trim() === '' || value.length > 160) fail(`${where}: expected a non-empty string up to 160 characters`); return value.trim(); }
function number(value: unknown, where: string, min: number, max: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${where}: expected a finite number in ${min}..${max}`); return value; }
function integer(value: unknown, where: string, min: number, max: number): number { const parsed = number(value, where, min, max); if (!Number.isInteger(parsed)) fail(`${where}: expected a whole number`); return parsed; }
function validateUnique(values: string[], where: string): void { if (new Set(values).size !== values.length) fail(`${where}: duplicate value`); }
function fail(message: string): never { throw new InvalidLocationDocumentError(message); }
