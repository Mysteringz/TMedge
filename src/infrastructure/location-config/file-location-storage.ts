import { mkdirSync, readFileSync } from 'node:fs';
import { isLocationId, parseLocationDocument, type LocationDocument, type LocationSensorAssignment } from '../../modules/location-config/domain/location-document.js';
import { revalidateLocationCandidate, type LegacySpatialProvenance } from '../../modules/location-config/domain/location-candidate.js';
import { activeLocationModelDispositions, legacyStaticModelProvenance, locationModelPresentationDisposition, validateLocationAssetProvenanceTransition, type LocationModelPresentationDisposition } from '../../modules/location-config/domain/location-assets.js';
import { legacyFloorToBaseline } from './legacy-location-mapper.js';
import { parseNodesConfig, type NodesConfigV2 } from '../../modules/location-config/domain/nodes-config.js';
import { LocationConflictError, type PublishedLocationRevision, type PublishedLocationState } from '../../modules/location-config/domain/location-records.js';
import type { FurnitureLibraryStore, LocationAssetMetadataRepository, LocationAssetStore, LocationDraftRepository, LocationRegistrySnapshot, LocationRegistrySnapshotRepository, PublishedLocationRepository, RegistryMutationCoordinator } from '../../modules/location-config/repositories/location-storage.js';
import { buildRegistry, buildRegistryFromLocationDocuments, type FloorDef, type Registry } from '../../edge/registry.js';
import { FileLocationAssetStore } from './file-location-asset-store.js';
import { FileLocationDraftRepository } from './file-location-draft-repository.js';
import { FileRegistryMutationCoordinator } from './file-registry-mutation-coordinator.js';
import { atomicWriteNodesConfig, readNodesConfig, recoverNodesConfig } from './file-nodes-config.js';
import { fileSha256, type AtomicFileOperations } from './atomic-file-write.js';

export interface FileLocationPersistence {
  siteSeed: unknown;
  registry: Registry;
  coordinator: FileRegistryMutationCoordinator;
  drafts: LocationDraftRepository;
  published: PublishedLocationRepository;
  snapshots: LocationRegistrySnapshotRepository;
  assets: LocationAssetStore & FurnitureLibraryStore;
  furnitureLibrary: FurnitureLibraryStore;
  assetMetadata: LocationAssetMetadataRepository;
  close(): void;
}

/** Validates both legacy inputs before upgrading NODES_CONFIG and opening durable stores. */
export function initializeFileLocationPersistence(sitePath: string, nodesPath: string, dataDir: string, writeOperations: AtomicFileOperations = {}): FileLocationPersistence {
  const siteJson: unknown = JSON.parse(readFileSync(sitePath, 'utf8'));
  const seedRegistry = buildRegistry(siteJson, { nodes: [] });
  const rawNodes: unknown = JSON.parse(readFileSync(nodesPath, 'utf8'));
  const parsed = parseNodesConfig(rawNodes);
  if (parsed.kind === 'v2') validatePublishedAgainstSeed(seedRegistry, parsed.document);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const coordinator = new FileRegistryMutationCoordinator(nodesPath);
  coordinator.acquireProcessOwnership();
  try {
    if (parsed.kind === 'legacy') {
      const upgraded = {
        schemaVersion: 2 as const,
        revision: 0,
        nodes: structuredClone(parsed.nodes),
        publishedLocations: [],
      };
      const outcome = atomicWriteNodesConfig(nodesPath, upgraded, writeOperations);
      recoverNodesConfig(nodesPath, outcome.revision, outcome.contentSha256, writeOperations);
    }
    if (parsed.kind === 'v2') {
      const bytes = readFileSync(nodesPath);
      recoverNodesConfig(nodesPath, parsed.document.revision, fileSha256(bytes), writeOperations);
    }
  } catch (error) {
    coordinator.close();
    throw error;
  }
  const drafts = new FileLocationDraftRepository(dataDir, coordinator, writeOperations);
  const assetStore = new FileLocationAssetStore(dataDir);
  const published = new FilePublishedLocationRepository(seedRegistry, nodesPath, coordinator, writeOperations);
  const snapshots = new FileLocationRegistrySnapshotRepository(siteJson, nodesPath, seedRegistry, published);
  const initial = snapshots.readSnapshotSync();
  const active = activeDocuments(initial);
  const registry = buildRegistryFromLocationDocuments(siteJson, nodesConfigFor(initial), active.documents, active.legacySpatialByLocation, active.modelDispositionByLocation);
  return {
    siteSeed: siteJson, registry, coordinator, drafts, published, snapshots, assets: assetStore, furnitureLibrary: assetStore, assetMetadata: assetStore,
    close: () => coordinator.close(),
  };
}

/** Loads the full file-mode registry, including published location overrides. */
export function loadFileRegistry(sitePath: string, nodesPath: string): Registry {
  const siteJson: unknown = JSON.parse(readFileSync(sitePath, 'utf8'));
  const nodesJson: unknown = JSON.parse(readFileSync(nodesPath, 'utf8'));
  return buildFileRegistry(siteJson, nodesJson);
}

/** Validates a candidate NODES_CONFIG without dropping its published floors. */
export function buildFileRegistry(siteJson: unknown, nodesJson: unknown): Registry {
  const parsed = parseNodesConfig(nodesJson);
  if (parsed.kind === 'legacy') return buildRegistry(siteJson, { nodes: parsed.nodes });
  const seed = buildRegistry(siteJson, { nodes: [] });
  validatePublishedAgainstSeed(seed, parsed.document);
  const active = parsed.document.publishedLocations.flatMap((location) => {
    const active = location.revisions.find((revision) => revision.revision === location.activeRevision);
    if (!active) throw new LocationConflictError(`Published location ${location.locationId} has no active document.`);
    return [active];
  });
  const modelDispositionByLocation = new Map(active.flatMap((revision) => {
    const disposition = locationModelPresentationDisposition(revision.document, revision.assetProvenance, revision.revision);
    return disposition ? [[revision.locationId, disposition] as const] : [];
  }));
  return buildRegistryFromLocationDocuments(siteJson, parsed.document, active.map((revision) => revision.document), new Map(active.flatMap((revision) => revision.legacySpatial ? [[revision.locationId, revision.legacySpatial] as const] : [])), modelDispositionByLocation);
}

export class FilePublishedLocationRepository implements PublishedLocationRepository {
  constructor(
    private readonly seedRegistry: Registry,
    private readonly nodesPath: string,
    private readonly coordinator: RegistryMutationCoordinator,
    private readonly writeOperations: AtomicFileOperations = {},
  ) {}

  async assertLocationIdAvailable(locationId: string): Promise<void> {
    if (!isLocationId(locationId)) throw new TypeError('Location ID is invalid.');
    const state = this.readNodes();
    if (this.seedRegistry.floors.some((floor) => floor.id === locationId)
      || state.publishedLocations.some((item) => item.locationId === locationId)) {
      throw new LocationConflictError('The location ID is already in use.');
    }
  }

  async getActive(locationId: string): Promise<PublishedLocationState | null> {
    return this.activeFromConfig(locationId, this.readNodes());
  }

  async listActive(): Promise<PublishedLocationState[]> {
    return this.activeStatesFromConfig(this.readNodes());
  }

  activeStatesFromConfig(config: NodesConfigV2): PublishedLocationState[] {
    const ids = new Set([...this.seedRegistry.floors.map((floor) => floor.id), ...config.publishedLocations.map((item) => item.locationId)]);
    const states: PublishedLocationState[] = [];
    for (const id of [...ids].sort()) {
      const state = this.activeFromConfig(id, config);
      if (state) states.push(state);
    }
    return states;
  }

  async listHistory(locationId: string): Promise<PublishedLocationRevision[]> {
    return (await this.getActive(locationId))?.history ?? [];
  }

  private activeFromConfig(locationId: string, config: NodesConfigV2): PublishedLocationState | null {
    const override = config.publishedLocations.find((item) => item.locationId === locationId);
    if (override) {
      const baseline = this.seedRegistry.floors.find((floor) => floor.id === locationId);
      const history = [
        ...(baseline ? [legacyRevision(baseline, this.seedRegistry)] : []),
        ...override.revisions,
      ];
      return { locationId, activeRevision: override.activeRevision, history };
    }
    const floor = this.seedRegistry.floors.find((item) => item.id === locationId);
    if (!floor) return null;
    const revision = legacyRevision(floor, this.seedRegistry);
    return { locationId, activeRevision: 0, history: [revision] };
  }

  async commitWithinMutation(input: {
    expectedRegistryRevision: number;
    expectedPublishedRevision: number | null;
    revision: PublishedLocationRevision;
    assignments: readonly LocationSensorAssignment[];
  }): Promise<{ kind: 'committed'; durability: 'confirmed' | 'unconfirmed'; acknowledgement: 'received'; registryRevision: number; activeRevision: number; contentSha256: string }> {
    const config = this.readNodes();
    if (config.revision !== input.expectedRegistryRevision) throw new LocationConflictError('The registry changed; reload before publishing.');
    const document = parseLocationDocument(input.revision.document);
    if (document.locationId !== input.revision.locationId || !Number.isSafeInteger(input.revision.createdAt) || input.revision.createdAt < 0) {
      throw new TypeError('Published revision metadata is invalid.');
    }
    if (!sameAssignments(document.sensorAssignments, input.assignments)) throw new TypeError('Published assignments must match the location document.');

    const seedFloor = this.seedRegistry.floors.find((floor) => floor.id === input.revision.locationId);
    const existing = config.publishedLocations.find((item) => item.locationId === input.revision.locationId);
    const activeRevision = existing?.activeRevision ?? (seedFloor ? 0 : null);
    if (activeRevision !== input.expectedPublishedRevision) throw new LocationConflictError('The published location changed; reload before publishing.');
    const activeRow = existing?.revisions.find((row) => row.revision === activeRevision) ?? null;
    const activeDocument = activeRow?.document
      ?? (seedFloor ? legacyFloorToBaseline(seedFloor, this.seedRegistry.nodes.values()) : null);
    const baseRevision: PublishedLocationRevision | null = activeDocument ? {
      locationId: input.revision.locationId,
      revision: activeRevision!,
      createdBy: activeRow?.createdBy ?? 'system-bootstrap',
      createdAt: activeRow?.createdAt ?? 0,
      document: activeDocument,
      legacySpatial: activeRow?.legacySpatial ?? null,
      assetProvenance: activeRow?.assetProvenance ?? (activeRevision === 0 ? legacyStaticModelProvenance(activeDocument as ReturnType<typeof legacyFloorToBaseline>) : {}),
    } : null;
    const validatedCandidate = revalidateLocationCandidate(
      document, input.revision.legacySpatial, baseRevision ? {
        revision: baseRevision.revision, document: baseRevision.document, legacySpatial: baseRevision.legacySpatial,
      } : null, activeRevision,
    );
    const assetProvenance = validateLocationAssetProvenanceTransition(
      validatedCandidate.document, input.revision.assetProvenance, input.revision.createdBy,
      baseRevision ? { revision: baseRevision.revision, document: baseRevision.document, assetProvenance: baseRevision.assetProvenance } : null,
    );
    if (activeDocument && document.visibility !== activeDocument.visibility) {
      throw new LocationConflictError('Location visibility is inherited and cannot be changed by a draft.');
    }
    if (!activeDocument && document.visibility !== 'public') {
      throw new LocationConflictError('New locations use the public visibility default.');
    }
    const nextRevision = (activeRevision ?? 0) + 1;
    if (input.revision.revision !== nextRevision) throw new TypeError(`Published revision must be ${nextRevision}.`);
    if (input.revision.createdBy.trim() === '' || input.revision.createdBy.length > 256) throw new TypeError('Publisher identity is invalid.');
    await this.assertNoGlobalGeometryCollision(config, document);

    const nodes = structuredClone(config.nodes);
    applyAssignments(nodes, input.revision.locationId, document.sensorAssignments, document.visibility);
    const candidate: NodesConfigV2 = {
      ...config,
      revision: config.revision + 1,
      nodes,
      publishedLocations: upsertPublished(config.publishedLocations, { ...input.revision, document: validatedCandidate.document, legacySpatial: validatedCandidate.legacySpatial, assetProvenance }),
    };
    const reparsed = parseNodesConfig(candidate);
    if (reparsed.kind !== 'v2') throw new Error('Internal registry schema conversion failed.');
    validatePublishedAgainstSeed(this.seedRegistry, reparsed.document);
    const outcome = atomicWriteNodesConfig(this.nodesPath, reparsed.document, this.writeOperations);
    if (outcome.durability === 'unconfirmed') {
      this.coordinator.latchDurabilityRecovery?.(() => recoverNodesConfig(this.nodesPath, outcome.revision, outcome.contentSha256, this.writeOperations));
    }
    return {
      kind: 'committed', durability: outcome.durability, acknowledgement: 'received',
      registryRevision: reparsed.document.revision, activeRevision: nextRevision, contentSha256: outcome.contentSha256,
    };
  }

  async registryRevision(): Promise<number> { return this.readNodes().revision; }

  private readNodes(): NodesConfigV2 {
    const config = readNodesConfig(this.nodesPath);
    validatePublishedAgainstSeed(this.seedRegistry, config);
    return config;
  }

  private async assertNoGlobalGeometryCollision(config: NodesConfigV2, document: LocationDocument): Promise<void> {
    const newTableIds = new Set(document.tables.map((table) => table.id));
    const newSeatIds = new Set(document.tables.flatMap((table) => table.seats.map((seat) => seat.id)));
    const activeOverrides = new Map(config.publishedLocations.map((item) => [item.locationId, item.revisions.find((row) => row.revision === item.activeRevision)!.document]));
    const used = new Set<string>();
    const usedSeats = new Set<string>();
    for (const floor of this.seedRegistry.floors) {
      const active = floor.id === document.locationId ? document : activeOverrides.get(floor.id) ?? legacyFloorToBaseline(floor, this.seedRegistry.nodes.values());
      if (floor.id !== document.locationId) for (const table of active.tables) {
        used.add(table.id);
        for (const seat of table.seats) usedSeats.add(seat.id);
      }
    }
    for (const [locationId, active] of activeOverrides) {
      if (this.seedRegistry.floors.some((floor) => floor.id === locationId) || locationId === document.locationId) continue;
      for (const table of active.tables) {
        used.add(table.id);
        for (const seat of table.seats) usedSeats.add(seat.id);
      }
    }
    for (const id of newTableIds) if (used.has(id)) throw new LocationConflictError(`Table ID "${id}" is already used by another location.`);
    for (const id of newSeatIds) if (usedSeats.has(id)) throw new LocationConflictError(`Seat ID "${id}" is already used by another location.`);
  }
}

/** Reads file-backed nodes and active location records as one shared-writer-protected snapshot. */
export class FileLocationRegistrySnapshotRepository implements LocationRegistrySnapshotRepository {
  constructor(
    private readonly siteSeed: unknown,
    private readonly nodesPath: string,
    private readonly seedRegistry: Registry,
    private readonly published: FilePublishedLocationRepository,
  ) {}

  async readSnapshot(): Promise<LocationRegistrySnapshot> { return this.readSnapshotSync(); }

  readSnapshotSync(): LocationRegistrySnapshot {
    const config = readNodesConfig(this.nodesPath);
    validatePublishedAgainstSeed(this.seedRegistry, config);
    const states = this.published.activeStatesFromConfig(config);
    const activeOverrides = states.flatMap((state) => {
      if (state.activeRevision === 0) return [];
      const active = state.history.find((revision) => revision.revision === state.activeRevision);
      return active ? [parseLocationDocument(active.document)] : [];
    });
    const provenance = new Map(states.flatMap((state) => {
      const active = state.history.find((revision) => revision.revision === state.activeRevision);
      return state.activeRevision !== 0 && active?.legacySpatial ? [[state.locationId, active.legacySpatial] as const] : [];
    }));
    const modelDispositionByLocation = activeLocationModelDispositions(states);
    const current = buildRegistryFromLocationDocuments(this.siteSeed, config, activeOverrides, provenance, modelDispositionByLocation);
    const locations = states.map((state) => {
      if (state.activeRevision !== 0) return state;
      const floor = current.floors.find((item) => item.id === state.locationId);
      if (!floor) return state;
      const legacyDocument = legacyFloorToBaseline(floor, current.nodes.values());
      const history = state.history.map((revision) => revision.revision === 0 ? { ...revision, document: legacyDocument } : revision);
      return { ...state, history };
    });
    return {
      registryRevision: config.revision,
      nodes: [...current.nodes.values()].map((node) => ({ ...node, owns: [...node.owns], pose: node.pose ? { ...node.pose } : null, detector: node.detector ?? 'node' })),
      locations,
    };
  }
}

function nodesConfigFor(snapshot: LocationRegistrySnapshot): unknown {
  return { nodes: snapshot.nodes.map((node) => ({
    uid: node.uid, label: node.label, ...(node.floorId && node.pose ? { floor: node.floorId, pose: node.pose } : {}),
    owns: node.owns, simulated: node.simulated, rgb: node.rgb, detector: node.detector,
  })) };
}

function activeDocuments(snapshot: LocationRegistrySnapshot): {
  documents: LocationDocument[];
  legacySpatialByLocation: Map<string, LegacySpatialProvenance>;
  modelDispositionByLocation: Map<string, LocationModelPresentationDisposition>;
} {
  const legacySpatialByLocation = new Map<string, LegacySpatialProvenance>();
  const modelDispositionByLocation = activeLocationModelDispositions(snapshot.locations);
  const documents = snapshot.locations.flatMap((state) => {
    const active = state.history.find((revision) => revision.revision === state.activeRevision);
    if (!active) return [];
    if (state.activeRevision !== 0 && active.legacySpatial) legacySpatialByLocation.set(active.locationId, active.legacySpatial);
    if (state.activeRevision === 0) return [];
    return active ? [parseLocationDocument(active.document)] : [];
  });
  return { documents, legacySpatialByLocation, modelDispositionByLocation };
}

function legacyRevision(floor: FloorDef, registry: Registry): PublishedLocationRevision {
  const document = legacyFloorToBaseline(floor, registry.nodes.values());
  return {
    locationId: floor.id,
    revision: 0,
    createdBy: 'system-bootstrap',
    createdAt: 0,
    document,
    assetProvenance: legacyStaticModelProvenance(document),
  };
}

function upsertPublished(
  current: NodesConfigV2['publishedLocations'],
  revision: PublishedLocationRevision,
): NodesConfigV2['publishedLocations'] {
  const next = current.map((item) => ({ ...item, revisions: [...item.revisions] }));
  const existing = next.find((item) => item.locationId === revision.locationId);
  const serialized = {
    locationId: revision.locationId,
    revision: revision.revision,
    createdBy: revision.createdBy,
    createdAt: revision.createdAt,
    document: parseLocationDocument(revision.document),
    legacySpatial: revision.legacySpatial ?? null,
    assetProvenance: revision.assetProvenance ?? {},
  };
  if (existing) {
    existing.revisions.push(serialized);
    existing.activeRevision = revision.revision;
  } else {
    next.push({ locationId: revision.locationId, activeRevision: revision.revision, revisions: [serialized] });
  }
  return next;
}

function applyAssignments(nodes: unknown[], locationId: string, assignments: readonly LocationSensorAssignment[], visibility: LocationDocument['visibility']): void {
  const byUid = new Map<string, Record<string, unknown>>();
  for (const raw of nodes) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { uid?: unknown }).uid === 'string') {
      byUid.set(((raw as { uid: string }).uid).toLowerCase(), raw as Record<string, unknown>);
    }
  }
  const assigned = new Map(assignments.map((item) => [item.uid.toLowerCase(), item]));
  if (assigned.size !== assignments.length) throw new TypeError('Sensor assignments contain duplicate UIDs.');
  for (const [uid, node] of byUid) {
    if (node.floor === locationId && !assigned.has(uid)) {
      delete node.floor;
      delete node.pose;
      delete node.owns;
    }
  }
  for (const [uid, assignment] of assigned) {
    const node = byUid.get(uid);
    if (!node) throw new LocationConflictError(`Sensor ${uid} is not registered on this edge.`);
    if (node.rgb === true && visibility !== 'console') throw new LocationConflictError(`RGB sensor ${uid} cannot be assigned to a public location.`);
    if (typeof node.floor === 'string' && node.floor !== locationId) throw new LocationConflictError(`Sensor ${uid} already belongs to another location.`);
    node.floor = locationId;
    node.pose = { ...assignment.pose };
    node.owns = [...assignment.owns];
  }
}

function sameAssignments(a: readonly LocationSensorAssignment[], b: readonly LocationSensorAssignment[]): boolean {
  const normalize = (rows: readonly LocationSensorAssignment[]) => [...rows].map((row) => ({
    uid: row.uid.toLowerCase(), pose: row.pose, owns: [...row.owns].sort(),
  })).sort((x, y) => x.uid.localeCompare(y.uid));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function validatePublishedAgainstSeed(registry: Registry, document: NodesConfigV2): void {
  const floorIds = new Set(registry.floors.map((floor) => floor.id));
  const seedById = new Map(registry.floors.map((floor) => [floor.id, legacyRevision(floor, registry)]));
  for (const override of document.publishedLocations) {
    let base = seedById.get(override.locationId) ?? null;
    for (const revision of override.revisions) {
      // Older Task 2.2 files have no asset provenance field. The only safe
      // migration is copying an exact reference from its trusted prior row;
      // new/unrelated IDs fail closed.
      const inheritedAssetProvenance = revision.assetProvenance ?? (base ? {
        ...(revision.document.planAssetId !== undefined && revision.document.planAssetId === base.document.planAssetId && base.assetProvenance?.planAssetId
          ? { planAssetId: base.assetProvenance.planAssetId } : {}),
        ...(revision.document.modelAssetId !== undefined && revision.document.modelAssetId === base.document.modelAssetId && base.assetProvenance?.modelAssetId
          ? { modelAssetId: base.assetProvenance.modelAssetId } : {}),
      } : {});
      revision.assetProvenance = validateLocationAssetProvenanceTransition(
        revision.document, inheritedAssetProvenance, revision.createdBy,
        base ? { revision: base.revision, document: base.document, assetProvenance: base.assetProvenance } : null,
      );
      if (revision.legacySpatial) {
        if (!base) throw new LocationConflictError('Legacy spatial provenance has no matching immutable base revision.');
        try {
          revalidateLocationCandidate(
            revision.document,
            revision.legacySpatial,
            { revision: base.revision, document: base.document, legacySpatial: base.legacySpatial },
            base.revision,
          );
        } catch { throw new LocationConflictError('Legacy spatial provenance does not match its immutable base revision.'); }
      }
      base = revision;
    }
  }
  const tableIds = new Set<string>();
  const seatIds = new Set<string>();
  for (const floor of registry.floors) {
    const override = document.publishedLocations.find((item) => item.locationId === floor.id);
    const active = override?.revisions.find((row) => row.revision === override.activeRevision)?.document;
    for (const table of active?.tables ?? floor.tables) {
      if (tableIds.has(table.id)) throw new LocationConflictError(`Duplicate table ID "${table.id}" across active locations.`);
      tableIds.add(table.id);
      for (const seat of 'seats' in table ? table.seats : []) {
        if (seatIds.has(seat.id)) throw new LocationConflictError(`Duplicate seat ID "${seat.id}" across active locations.`);
        seatIds.add(seat.id);
      }
    }
  }
  for (const override of document.publishedLocations) {
    if (floorIds.has(override.locationId)) continue;
    const active = override.revisions.find((row) => row.revision === override.activeRevision)!.document;
    for (const table of active.tables) {
      if (tableIds.has(table.id)) throw new LocationConflictError(`Duplicate table ID "${table.id}" across active locations.`);
      tableIds.add(table.id);
      for (const seat of table.seats) {
        if (seatIds.has(seat.id)) throw new LocationConflictError(`Duplicate seat ID "${seat.id}" across active locations.`);
        seatIds.add(seat.id);
      }
    }
  }
}
