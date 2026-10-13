import { generateSeats } from '../../../../../src/shared/seats.ts';
import { isValidSimpleBoundedPolygon } from '../../../../../src/shared/location-validation.ts';
import { tableBounds } from '../../../../../src/shared/table-geometry.ts';
import type { TableShape, Table, LocationDocument, Point, Zone } from '../../../entities/location-config/model/types.ts';

export type ShapeKind = TableShape['type'];

export function cmToMetres(value: number): number { return Number((value / 100).toFixed(2)); }
export function metresToCm(value: number): number { return Number((value * 100).toFixed(2)); }
export function newStableId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }

export function shapeOf(table: Table): TableShape {
  if (table.shape) return table.shape;
  if (table.rect) return { type: 'rect', ...table.rect };
  return { type: 'rect', x: 0, y: 0, width: 40, height: 40 };
}

export function addDefaultZone(document: LocationDocument): LocationDocument {
  if (document.zones.length) return document;
  const zone: Zone = { id: newStableId('ZONE'), name: 'Main area', polygon: structuredClone(document.outline) };
  return { ...document, zones: [zone] };
}

export function createTable(document: LocationDocument, kind: ShapeKind): Table | null {
  const zone = document.zones[0];
  if (!zone) return null;
  const width = document.widthCm, height = document.heightCm;
  const centerX = width / 2, centerY = height / 2;
  const id = newStableId('TABLE');
  let shape: TableShape;
  if (kind === 'circle') shape = { type: 'circle', cx: centerX, cy: centerY, radius: Math.max(10, Math.min(50, width / 8, height / 8)) };
  else if (kind === 'polygon') shape = { type: 'polygon', points: [[centerX - 10, centerY - 10], [centerX + 10, centerY - 10], [centerX + 10, centerY + 10], [centerX - 10, centerY + 10]] };
  else shape = { type: 'rect', x: centerX - 10, y: centerY - 10, width: 20, height: 20 };
  const table: Table = { id, name: `Table ${document.tables.length + 1}`, zoneId: zone.id, capacity: 4, shape, seats: [] };
  table.seats = generateSeats(table.id, shape, table.capacity);
  return table;
}

export function generateTableSeats(table: Table): Table {
  return { ...table, seats: generateSeats(table.id, shapeOf(table), table.capacity) };
}

export function setShape(table: Table, shape: TableShape): Table {
  const next = { ...table, shape };
  delete next.rect;
  return next;
}

export function changeShapeKind(table: Table, kind: ShapeKind, floorWidth: number, floorHeight: number): Table {
  const old = shapeOf(table), bounds = tableBounds(old);
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  let shape: TableShape;
  if (kind === 'circle') {
    const radius = Math.max(10, Math.min(40, floorWidth / 10, floorHeight / 10));
    shape = { type: 'circle', cx: clamp(cx, radius, floorWidth - radius), cy: clamp(cy, radius, floorHeight - radius), radius };
  } else if (kind === 'polygon') {
    const halfW = Math.max(10, Math.min(40, floorWidth / 10)), halfH = Math.max(10, Math.min(30, floorHeight / 10));
    const x = clamp(cx, halfW, floorWidth - halfW), y = clamp(cy, halfH, floorHeight - halfH);
    shape = { type: 'polygon', points: [[x - halfW, y - halfH], [x + halfW, y - halfH], [x + halfW, y + halfH], [x - halfW, y + halfH]] };
  } else {
    const w = Math.max(20, Math.min(80, floorWidth / 5)), h = Math.max(20, Math.min(60, floorHeight / 5));
    const x = clamp(cx - w / 2, 0, floorWidth - w), y = clamp(cy - h / 2, 0, floorHeight - h);
    shape = { type: 'rect', x, y, width: w, height: h };
  }
  const changed = setShape(table, shape);
  return generateTableSeats(changed);
}

export function moveShape(shape: TableShape, dx: number, dy: number, width: number, height: number): TableShape {
  const bounds = tableBounds(shape);
  const x = clamp(bounds.x + dx, 0, width - bounds.width) - bounds.x;
  const y = clamp(bounds.y + dy, 0, height - bounds.height) - bounds.y;
  if (shape.type === 'rect') return { ...shape, x: shape.x + x, y: shape.y + y };
  if (shape.type === 'circle') return { ...shape, cx: shape.cx + x, cy: shape.cy + y };
  return { ...shape, points: shape.points.map(([px, py]) => [px + x, py + y]) };
}

export interface EditorValidationIssue { field: string; message: string }

/** Client hints match strict server geometry and preserve only untouched values from the displayed base. */
export function validateEditorDocument(document: LocationDocument, base: LocationDocument | null): EditorValidationIssue[] {
  const errors: EditorValidationIssue[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const width = document.widthCm, height = document.heightCm;
  if (!finiteRange(width, 100, 100000)) add('floor.width', 'Floor width must be between 1 and 1000 metres.');
  if (!finiteRange(height, 100, 100000)) add('floor.height', 'Floor height must be between 1 and 1000 metres.');
  const sameDimensions = !!base && base.widthCm === width && base.heightCm === height;
  const oldZones = new Map(base?.zones.map((zone) => [zone.id, zone]) ?? []);
  const oldTables = new Map(base?.tables.map((table) => [table.id, table]) ?? []);
  if (!(sameDimensions && base && sameJson(document.outline, base.outline)) && !isValidSimpleBoundedPolygon(document.outline, width, height)) {
    add('floor.outline', 'The room outline must be a simple polygon inside the floor.');
  }
  const zoneIds = document.zones.map((zone) => zone.id);
  if (new Set(zoneIds).size !== zoneIds.length) add('zones.list', 'Zone IDs must be unique.');
  for (const zone of document.zones) {
    const inherited = oldZones.get(zone.id);
    const unchangedLegacy = sameDimensions && inherited && sameJson(zone.polygon, inherited.polygon);
    if (!zone.name.trim()) add(`zone.${zone.id}.name`, 'Enter a name for this zone.');
    if (!unchangedLegacy) {
      const issues = polygonIssues(`zone.${zone.id}`, zone.polygon, width, height, `Zone “${zone.name || 'unnamed'}”`);
      for (const issue of issues) add(issue.field, issue.message);
    }
  }
  const tableIds = document.tables.map((table) => table.id);
  const seatIds = document.tables.flatMap((table) => table.seats.map((seat) => seat.id));
  if (new Set(tableIds).size !== tableIds.length) add('tables.list', 'Table IDs must be unique.');
  if (new Set(seatIds).size !== seatIds.length) add('seats.list', 'Seat IDs must be unique.');
  for (const table of document.tables) {
    if (!table.name.trim()) add(`table.${table.id}.name`, 'Enter a name for this table.');
    if (!zoneIds.includes(table.zoneId)) add(`table.${table.id}.zone`, `Table “${table.name || 'unnamed'}” must belong to a zone.`);
    if (!Number.isInteger(table.capacity) || table.capacity < 1 || table.capacity > 20 || table.seats.length !== table.capacity) {
      add(`table.${table.id}.capacity`, `Table “${table.name || 'unnamed'}” needs exactly one seat per capacity.`);
    }
    const inherited = oldTables.get(table.id);
    const shape = table.shape;
    const unchangedLegacyRect = sameDimensions && inherited && !inherited.shape && !shape
      && sameJson(table.rect, inherited.rect);
    if (!unchangedLegacyRect) {
      const issues = shapeIssues(`table.${table.id}.shape`, shape, width, height, `Table “${table.name || 'unnamed'}”`);
      for (const issue of issues) add(issue.field, issue.message);
    }
    const previousSeats = new Map(inherited?.seats.map((seat) => [seat.id, seat]) ?? []);
    const adjacency = new Map(table.seats.map((seat) => [seat.id, seat.neighbors]));
    for (const seat of table.seats) {
      const prior = previousSeats.get(seat.id);
      const unchangedLegacySeat = unchangedLegacyRect && prior && seat.x === prior.x && seat.y === prior.y;
      if (!unchangedLegacySeat) {
        if (!finiteRange(seat.x, 0, width)) add(`seat.${seat.id}.x`, 'Seat X must be inside the floor.');
        if (!finiteRange(seat.y, 0, height)) add(`seat.${seat.id}.y`, 'Seat Y must be inside the floor.');
      }
      if (new Set(seat.neighbors).size !== seat.neighbors.length || seat.neighbors.includes(seat.id)
        || seat.neighbors.some((id) => !adjacency.has(id) || !adjacency.get(id)?.includes(seat.id))) {
        add(`seat.${seat.id}.neighbors`, 'This seat has invalid neighbouring seats.');
      }
    }
  }
  return errors.filter((issue, index) => errors.findIndex((candidate) => candidate.field === issue.field && candidate.message === issue.message) === index);
}

export function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function shapeIssues(field: string, shape: TableShape | undefined, width: number, height: number, label: string): EditorValidationIssue[] {
  if (!shape) return [{ field, message: `${label} needs a valid shape inside the floor.` }];
  if (shape.type === 'polygon') return polygonIssues(field, shape.points, width, height, label);
  const issues: EditorValidationIssue[] = [];
  if (shape.type === 'rect') {
    if (!Number.isFinite(shape.x) || shape.x < 0) issues.push({ field: `${field}.x`, message: `${label} X must be inside the floor.` });
    if (!Number.isFinite(shape.y) || shape.y < 0) issues.push({ field: `${field}.y`, message: `${label} Y must be inside the floor.` });
    if (!Number.isFinite(shape.width) || shape.width <= 0 || Number.isFinite(shape.x) && shape.x + shape.width > width) issues.push({ field: `${field}.width`, message: `${label} width must fit inside the floor.` });
    if (!Number.isFinite(shape.height) || shape.height <= 0 || Number.isFinite(shape.y) && shape.y + shape.height > height) issues.push({ field: `${field}.height`, message: `${label} height must fit inside the floor.` });
  } else {
    if (!Number.isFinite(shape.cx) || shape.cx < 0 || shape.cx > width) issues.push({ field: `${field}.cx`, message: `${label} center X must be inside the floor.` });
    if (!Number.isFinite(shape.cy) || shape.cy < 0 || shape.cy > height) issues.push({ field: `${field}.cy`, message: `${label} center Y must be inside the floor.` });
    if (!Number.isFinite(shape.radius) || shape.radius <= 0 || Number.isFinite(shape.cx) && (shape.cx - shape.radius < 0 || shape.cx + shape.radius > width)
      || Number.isFinite(shape.cy) && (shape.cy - shape.radius < 0 || shape.cy + shape.radius > height)) {
      issues.push({ field: `${field}.radius`, message: `${label} radius must fit inside the floor.` });
    }
  }
  return issues;
}
function polygonIssues(field: string, points: Point[], width: number, height: number, label: string): EditorValidationIssue[] {
  const issues: EditorValidationIssue[] = [];
  points.forEach(([x, y], index) => {
    if (!finiteRange(x, 0, width)) issues.push({ field: `${field}.vertex.${index}.x`, message: `${label} vertex ${index + 1} X must be inside the floor.` });
    if (!finiteRange(y, 0, height)) issues.push({ field: `${field}.vertex.${index}.y`, message: `${label} vertex ${index + 1} Y must be inside the floor.` });
  });
  if (!issues.length && !isValidSimpleBoundedPolygon(points, width, height)) {
    issues.push({ field: field.endsWith('.shape') ? field : `${field}.polygon`, message: `${label} needs a simple, non-degenerate polygon inside the floor.` });
  }
  return issues;
}
function finiteRange(value: number, min: number, max: number): boolean { return Number.isFinite(value) && value >= min && value <= max; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
