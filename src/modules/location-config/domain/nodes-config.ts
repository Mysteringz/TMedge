import type { LocationRemoval } from './location-records.js';
import { parseLocationDocument, type LocationDocument } from './location-document.js';
import { parseLegacySpatialProvenance, type LegacySpatialProvenance } from './location-candidate.js';
import { parseLocationAssetProvenance, type LocationAssetProvenance } from './location-assets.js';
import { parsePublicationSource, type SourceDraftPublication } from './publication-source.js';

export interface PublishedLocationRecord {
  locationId: string;
  activeRevision: number;
  revisions: Array<{
    locationId: string;
    revision: number;
    createdBy: string;
    createdAt: number;
    document: LocationDocument;
    legacySpatial: LegacySpatialProvenance | null;
    assetProvenance?: LocationAssetProvenance;
    sourceDraft?: SourceDraftPublication;
  }>;
}

export interface NodesConfigV2 {
  schemaVersion: 2;
  revision: number;
  nodes: unknown[];
  publishedLocations: PublishedLocationRecord[];
  locationRemovals?: Array<LocationRemoval & { locationId: string }>;
}

export type ParsedNodesConfig =
  | { kind: 'legacy'; nodes: unknown[] }
  | { kind: 'v2'; document: NodesConfigV2 };

export class InvalidNodesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNodesConfigError';
  }
}

/** Accepts the current legacy file or the strict v2 registry extension. */
export function parseNodesConfig(value: unknown): ParsedNodesConfig {
  const root = object(value, 'nodes.json');
  if (root.schemaVersion === undefined) {
    only(root, 'nodes.json', ['nodes']);
    if (!Array.isArray(root.nodes)) invalid('nodes.json.nodes: expected an array');
    return { kind: 'legacy', nodes: root.nodes };
  }

  only(root, 'nodes.json', ['schemaVersion', 'revision', 'nodes', 'publishedLocations', 'locationRemovals']);
  if (root.schemaVersion !== 2) invalid('nodes.json.schemaVersion: expected 2');
  const revision = integer(root.revision, 'nodes.json.revision', 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(root.nodes) || !Array.isArray(root.publishedLocations)) invalid('nodes.json.nodes and publishedLocations must be arrays');
  const publishedLocations = root.publishedLocations.map((item, index) => parsePublishedLocation(item, index));
  unique(publishedLocations.map((item) => item.locationId), 'published location IDs');

  if (root.locationRemovals !== undefined && !Array.isArray(root.locationRemovals)) invalid('nodes.json.locationRemovals: expected an array');
  const locationRemovals = (root.locationRemovals as unknown[] | undefined)?.map((value, index) => {
    const where = `nodes.json.locationRemovals[${index}]`;
    const row = object(value, where);
    only(row, where, ['locationId', 'removedAt', 'removedBy']);
    if (typeof row.removedBy !== 'string' || !row.removedBy.trim() || row.removedBy.length > 256) invalid(`${where}.removedBy: invalid identity`);
    return { locationId: safeId(row.locationId, where), removedAt: integer(row.removedAt, where, 0, Number.MAX_SAFE_INTEGER), removedBy: row.removedBy };
  });
  unique(locationRemovals?.map(row => row.locationId) ?? [], 'removed location IDs');
  const removedIds = new Set(locationRemovals?.map(row => row.locationId));
  const seenTableIds = new Set<string>();
  const seenSeatIds = new Set<string>();
  for (const location of publishedLocations) {
    if (removedIds.has(location.locationId)) continue;
    const active = location.revisions.find((history) => history.revision === location.activeRevision)!;
    for (const table of active.document.tables) {
      if (seenTableIds.has(table.id)) invalid(`nodes.json: duplicate table ID "${table.id}" across published locations`);
      seenTableIds.add(table.id);
      for (const seat of table.seats) {
        if (seenSeatIds.has(seat.id)) invalid(`nodes.json: duplicate seat ID "${seat.id}" across published locations`);
        seenSeatIds.add(seat.id);
      }
    }
  }
  return { kind: 'v2', document: { schemaVersion: 2, revision, nodes: root.nodes, publishedLocations, ...(locationRemovals ? { locationRemovals } : {}) } };
}

export function nodesArrayForRegistry(value: unknown): unknown[] {
  const parsed = parseNodesConfig(value);
  return parsed.kind === 'legacy' ? parsed.nodes : parsed.document.nodes;
}

export function emptyNodesConfigV2(nodes: unknown[]): NodesConfigV2 {
  return { schemaVersion: 2, revision: 0, nodes: structuredClone(nodes), publishedLocations: [] };
}

function parsePublishedLocation(value: unknown, index: number): PublishedLocationRecord {
  const where = `nodes.json.publishedLocations[${index}]`;
  const input = object(value, where);
  only(input, where, ['locationId', 'activeRevision', 'revisions']);
  const locationId = safeId(input.locationId, `${where}.locationId`);
  const activeRevision = integer(input.activeRevision, `${where}.activeRevision`, 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(input.revisions) || input.revisions.length === 0) invalid(`${where}.revisions: expected a non-empty array`);
  const revisions = input.revisions.map((item, revisionIndex) => {
    const revisionWhere = `${where}.revisions[${revisionIndex}]`;
    const row = object(item, revisionWhere);
    only(row, revisionWhere, ['locationId', 'revision', 'createdBy', 'createdAt', 'document', 'legacySpatial', 'assetProvenance', 'sourceDraft']);
    const revisionLocationId = safeId(row.locationId, `${revisionWhere}.locationId`);
    if (revisionLocationId !== locationId) invalid(`${revisionWhere}.locationId: must match its published location`);
    const revision = integer(row.revision, `${revisionWhere}.revision`, 1, Number.MAX_SAFE_INTEGER);
    const createdAt = integer(row.createdAt, `${revisionWhere}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
    const createdBy = string(row.createdBy, `${revisionWhere}.createdBy`);
    const document = parseLocationDocument(row.document);
    const legacySpatial = parseLegacySpatialProvenance(row.legacySpatial);
    const assetProvenance = row.assetProvenance === undefined ? undefined : parseLocationAssetProvenance(row.assetProvenance, document);
    const sourceDraft = parsePublicationSource(row.sourceDraft, revision);
    if (legacySpatial && legacySpatial.basePublishedRevision !== (sourceDraft ? sourceDraft.basePublishedRevision : revision - 1)) invalid(`${revisionWhere}.legacySpatial: must derive from the pinned published revision`);
    if (document.locationId !== locationId) invalid(`${revisionWhere}.document.locationId: must match its published location`);
    return { locationId, revision, createdBy, createdAt, document, legacySpatial, ...(assetProvenance ? { assetProvenance } : {}), ...(sourceDraft ? { sourceDraft } : {}) };
  });
  unique(revisions.map((item) => String(item.revision)), `${where}.revisions`);
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  if (ordered.some((item, i) => item.revision !== i + 1)) invalid(`${where}.revisions: authored revisions must be contiguous from 1`);
  if (!revisions.some((item) => item.revision === activeRevision)) invalid(`${where}.activeRevision: no matching revision`);
  return { locationId, activeRevision, revisions: ordered };
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${where}: expected an object`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, where: string, fields: string[]): void {
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${where}: unknown field "${key}"`);
}
function safeId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) invalid(`${where}: invalid stable ID`);
  return value;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 160) invalid(`${where}: expected a non-empty string up to 160 characters`);
  return value;
}
function integer(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${where}: expected an integer in ${min}..${max}`);
  return value;
}
function unique(values: string[], where: string): void {
  if (new Set(values).size !== values.length) invalid(`${where}: duplicate value`);
}
function invalid(message: string): never { throw new InvalidNodesConfigError(message); }
