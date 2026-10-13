import type { Rect } from '../../../shared/types.js';
import { parseLocationDocument, type FloorPoint, type LocationDocument, type TrustedLegacyLocationBaseline } from './location-document.js';
import type { LocationAssetProvenance } from './location-assets.js';

export interface LegacySpatialProvenance {
  /** The immutable published revision from which these exact values were inherited. */
  basePublishedRevision: number;
  outline?: FloorPoint[];
  zones: Array<{ id: string; polygon: FloorPoint[] }>;
  tables: Array<{
    id: string;
    rect?: Rect;
    seats: Array<{ id: string; x: number; y: number }>;
  }>;
}

export interface ValidatedLocationCandidate {
  document: LocationDocument;
  legacySpatial: LegacySpatialProvenance | null;
  assetProvenance?: LocationAssetProvenance;
}

export interface LocationCandidateBase {
  revision: number;
  document: LocationDocument | TrustedLegacyLocationBaseline;
  legacySpatial?: LegacySpatialProvenance | null;
}

export function parseLegacySpatialProvenance(value: unknown): LegacySpatialProvenance | null {
  if (value === undefined || value === null) return null;
  const root = object(value, 'legacySpatial');
  only(root, ['basePublishedRevision', 'outline', 'zones', 'tables']);
  const basePublishedRevision = safeInteger(root.basePublishedRevision, 'legacySpatial.basePublishedRevision');
  let outline: FloorPoint[] | undefined;
  if (root.outline !== undefined) outline = parsePoints(root.outline, 'legacySpatial.outline');
  if (!Array.isArray(root.zones) || !Array.isArray(root.tables)) throw new TypeError('Legacy spatial provenance collections are invalid.');
  const zones = root.zones.map((raw) => {
    const zone = object(raw, 'legacySpatial.zone');
    only(zone, ['id', 'polygon']);
    return { id: stableId(zone.id, 'legacySpatial.zone.id'), polygon: parsePoints(zone.polygon, 'legacySpatial.zone.polygon') };
  });
  const tables = root.tables.map((raw) => {
    const table = object(raw, 'legacySpatial.table');
    only(table, ['id', 'rect', 'seats']);
    if (!Array.isArray(table.seats)) throw new TypeError('Legacy spatial seats are invalid.');
    const seats = table.seats.map((rawSeat) => {
      const seat = object(rawSeat, 'legacySpatial.seat');
      only(seat, ['id', 'x', 'y']);
      return { id: stableId(seat.id, 'legacySpatial.seat.id'), x: finite(seat.x, 'legacySpatial.seat.x'), y: finite(seat.y, 'legacySpatial.seat.y') };
    });
    if (new Set(seats.map((seat) => seat.id)).size !== seats.length) throw new TypeError('Legacy spatial seat IDs are duplicated.');
    return {
      id: stableId(table.id, 'legacySpatial.table.id'),
      ...(table.rect === undefined ? {} : { rect: parseRect(table.rect) }),
      seats,
    };
  });
  if (new Set(zones.map((zone) => zone.id)).size !== zones.length || new Set(tables.map((table) => table.id)).size !== tables.length) {
    throw new TypeError('Legacy spatial identities are duplicated.');
  }
  return { basePublishedRevision, ...(outline ? { outline } : {}), zones, tables };
}

interface InheritableSpatial {
  outline?: FloorPoint[];
  zones: Map<string, FloorPoint[]>;
  tables: Map<string, { rect?: Rect; seats: Map<string, { x: number; y: number }> }>;
}

/**
 * Validates an authored candidate while allowing exact spatial values inherited
 * from the server-resolved immutable base revision. The request has no
 * provenance field; this function derives it from `base` after exact matching.
 */
export function parseLocationCandidate(
  value: unknown,
  base: LocationCandidateBase | null,
  expectedBaseRevision: number | null,
): ValidatedLocationCandidate {
  if ((base?.revision ?? null) !== expectedBaseRevision) throw new TypeError('The candidate base revision does not match the resolved published revision.');
  const input = object(value, 'location candidate');
  if ('legacySpatial' in input || 'provenance' in input) throw new TypeError('Location spatial provenance is server-managed.');

  const normalized = structuredClone(input) as Record<string, unknown>;
  const sameBaseDimensions = base !== null
    && input.widthCm === base.document.widthCm
    && input.heightCm === base.document.heightCm;
  const eligible: InheritableSpatial = sameBaseDimensions && base
    ? inheritableSpatial(base)
    : { zones: new Map(), tables: new Map() };
  const provenance: LegacySpatialProvenance = {
    basePublishedRevision: base?.revision ?? -1,
    zones: [],
    tables: [],
  };
  const width = finite(input.widthCm, 'location.widthCm');
  const height = finite(input.heightCm, 'location.heightCm');

  const outline = input.outline;
  if (eligible.outline && sameJson(outline, eligible.outline)) {
    provenance.outline = clonePoints(eligible.outline);
    normalized.outline = safePolygon(width, height);
  }

  if (Array.isArray(input.zones) && Array.isArray(normalized.zones)) {
    const normalizedZones = normalized.zones as unknown[];
    input.zones.forEach((rawZone, index) => {
      if (!isRecord(rawZone)) return;
      const zoneId = rawZone.id;
      const inherited = typeof zoneId === 'string' ? eligible.zones.get(zoneId) : undefined;
      if (!inherited || !sameJson(rawZone.polygon, inherited)) return;
      provenance.zones.push({ id: zoneId as string, polygon: clonePoints(inherited) });
      const changedZone = normalizedZones[index];
      if (isRecord(changedZone)) changedZone.polygon = safePolygon(width, height);
    });
  }

  if (Array.isArray(input.tables) && Array.isArray(normalized.tables)) {
    const normalizedTables = normalized.tables as unknown[];
    input.tables.forEach((rawTable, index) => {
      if (!isRecord(rawTable)) return;
      const tableId = rawTable.id;
      const inherited = typeof tableId === 'string' ? eligible.tables.get(tableId) : undefined;
      if (!inherited) return;
      const tableSpatial: LegacySpatialProvenance['tables'][number] = { id: tableId as string, seats: [] };
      const tableCandidate = normalizedTables[index];
      if (!isRecord(tableCandidate)) return;
      const inheritsLegacyRect = inherited.rect !== undefined && rawTable.shape === undefined && sameJson(rawTable.rect, inherited.rect);
      if (inheritsLegacyRect && inherited.rect) {
        tableSpatial.rect = { ...inherited.rect };
        delete tableCandidate.rect;
        tableCandidate.shape = safeRectShape(width, height);
      }
      if (inheritsLegacyRect && Array.isArray(rawTable.seats) && Array.isArray(tableCandidate.seats)) {
        const normalizedSeats = tableCandidate.seats as unknown[];
        rawTable.seats.forEach((rawSeat, seatIndex) => {
          if (!isRecord(rawSeat) || !isRecord(normalizedSeats[seatIndex])) return;
          const seatBase = inherited.seats.get(String(rawSeat.id));
          if (!seatBase || rawSeat.x !== seatBase.x || rawSeat.y !== seatBase.y) return;
          tableSpatial.seats.push({ id: String(rawSeat.id), ...seatBase });
          (normalizedSeats[seatIndex] as Record<string, unknown>).x = 0;
          (normalizedSeats[seatIndex] as Record<string, unknown>).y = 0;
        });
      }
      if (tableSpatial.rect || tableSpatial.seats.length > 0) provenance.tables.push(tableSpatial);
    });
  }

  const document = parseLocationDocument(normalized);
  const spatial = provenance.outline || provenance.zones.length || provenance.tables.length
    ? provenance : null;
  if (spatial && base) spatial.basePublishedRevision = base.revision;
  return { document, legacySpatial: spatial };
}

/** Reconstructs the shape-less representation used to edit a trusted revision. */
export function exposeLocationCandidate(document: LocationDocument, legacySpatial: LegacySpatialProvenance | null | undefined): Record<string, unknown> {
  const result = structuredClone(document) as unknown as Record<string, unknown>;
  if (!legacySpatial) return result;
  if (legacySpatial.outline) result.outline = clonePoints(legacySpatial.outline);
  const zones = result.zones as Array<Record<string, unknown>>;
  for (const inherited of legacySpatial.zones) {
    const zone = zones.find((item) => item.id === inherited.id);
    if (zone) zone.polygon = clonePoints(inherited.polygon);
  }
  const tables = result.tables as Array<Record<string, unknown>>;
  for (const inherited of legacySpatial.tables) {
    const table = tables.find((item) => item.id === inherited.id);
    if (!table) continue;
    if (inherited.rect) {
      delete table.shape;
      table.rect = { ...inherited.rect };
    }
    const seats = table.seats as Array<Record<string, unknown>>;
    for (const position of inherited.seats) {
      const seat = seats.find((item) => item.id === position.id);
      if (seat) { seat.x = position.x; seat.y = position.y; }
    }
  }
  return result;
}

export function exposePublishedLocationCandidate(base: LocationCandidateBase): Record<string, unknown> {
  if (base.revision === 0) {
    const result = structuredClone(base.document) as unknown as Record<string, unknown>;
    const tables = result.tables as Array<Record<string, unknown>>;
    // Revision-zero compatibility rows carry a derived rectangle even when
    // their authored shape is present. The strict draft schema accepts the
    // authored shape only; the extra rectangle is not part of the edit DTO.
    for (const table of tables) if (table.shape !== undefined) delete table.rect;
    return result;
  }
  return exposeLocationCandidate(base.document as LocationDocument, base.legacySpatial);
}

/** Checks persisted provenance against a candidate and its exact immutable base. */
export function revalidateLocationCandidate(
  document: LocationDocument,
  legacySpatial: LegacySpatialProvenance | null | undefined,
  base: LocationCandidateBase | null,
  expectedBaseRevision: number | null,
): ValidatedLocationCandidate {
  const exposed = exposeLocationCandidate(document, legacySpatial);
  const parsed = parseLocationCandidate(exposed, base, expectedBaseRevision);
  if (!sameJson(parsed.document, document)) throw new TypeError('Persisted candidate document does not match its canonical representation.');
  if (!sameJson(parsed.legacySpatial, legacySpatial ?? null)) throw new TypeError('Persisted legacy spatial provenance does not match its exact base revision.');
  return parsed;
}

function inheritableSpatial(base: LocationCandidateBase): InheritableSpatial {
  const result: InheritableSpatial = { zones: new Map(), tables: new Map() };
  if (base.revision === 0) {
    const document = base.document as TrustedLegacyLocationBaseline;
    result.outline = clonePoints(document.outline);
    for (const zone of document.zones) result.zones.set(zone.id, clonePoints(zone.polygon));
    for (const table of document.tables) {
      if (table.shape === undefined) {
        result.tables.set(table.id, {
          rect: { ...table.rect },
          seats: new Map(table.seats.map((seat) => [seat.id, { x: seat.x, y: seat.y }])),
        });
      }
    }
    return result;
  }
  const prior = base.legacySpatial;
  if (!prior) return result;
  if (prior.outline) result.outline = clonePoints(prior.outline);
  for (const zone of prior.zones) result.zones.set(zone.id, clonePoints(zone.polygon));
  for (const table of prior.tables) {
    result.tables.set(table.id, {
      ...(table.rect ? { rect: { ...table.rect } } : {}),
      seats: new Map(table.seats.map((seat) => [seat.id, { x: seat.x, y: seat.y }])),
    });
  }
  return result;
}

function safePolygon(width: number, height: number): FloorPoint[] {
  return [[0, 0], [width, 0], [width, height], [0, height]];
}
function parsePoints(value: unknown, label: string): FloorPoint[] {
  // The old registry accepts legacy floor outlines and zone polygons without
  // an upper vertex limit. Keep this parser compatible for server-derived
  // provenance; authored candidates still pass through parseLocationDocument,
  // which enforces the 256-point shape limit.
  if (!Array.isArray(value) || value.length < 3) throw new TypeError(`${label} is invalid.`);
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length !== 2) throw new TypeError(`${label}[${index}] is invalid.`);
    return [finite(raw[0], `${label}[${index}].x`), finite(raw[1], `${label}[${index}].y`)];
  });
}
function parseRect(value: unknown): Rect {
  const rect = object(value, 'legacySpatial.rect');
  only(rect, ['x', 'y', 'width', 'height']);
  const parsed = { x: finite(rect.x, 'legacySpatial.rect.x'), y: finite(rect.y, 'legacySpatial.rect.y'), width: finite(rect.width, 'legacySpatial.rect.width'), height: finite(rect.height, 'legacySpatial.rect.height') };
  if (parsed.width <= 0 || parsed.height <= 0) throw new TypeError('Legacy spatial rectangle dimensions must be positive.');
  return parsed;
}
function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid.`);
  return value;
}
function stableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
function safeRectShape(width: number, height: number): Record<string, unknown> {
  return { type: 'rect', x: 0, y: 0, width: Math.min(20, width), height: Math.min(20, height) };
}
function clonePoints(points: readonly FloorPoint[]): FloorPoint[] { return points.map(([x, y]) => [x, y]); }
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b)); }
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError('Legacy spatial provenance has an unknown field.');
}
