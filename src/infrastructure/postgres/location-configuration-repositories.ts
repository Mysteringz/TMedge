import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { InvalidLocationDocumentError, isLocationId, parseLocationDocument, type LocationDocument, type LocationSensorAssignment } from '../../modules/location-config/domain/location-document.js';
import { parseLegacySpatialProvenance, revalidateLocationCandidate, type ValidatedLocationCandidate } from '../../modules/location-config/domain/location-candidate.js';
import { normalizeLocationAssetDisplayName, parseLocationAssetProvenance, validateLocationAssetProvenanceTransition, legacyStaticModelProvenance, sameLocationAssetProvenance } from '../../modules/location-config/domain/location-assets.js';
import {
  LocationConflictError, LocationDraftNotFoundError, LocationStorageUnavailableError, UnknownRegistryCommitOutcomeError,
  type FurnitureType, type LocationAssetMetadata, type LocationDraft, type PublishedLocationRevision, type PublishedLocationState,
} from '../../modules/location-config/domain/location-records.js';
import type {
  FurnitureLibraryMetadata, FurnitureLibraryStore, LocationAssetMetadataRepository, LocationAssetStore, LocationDraftRepository, PublishedLocationRepository, RegistryMutationCoordinator,
  DraftWriteOutcome, RegistryCommitOutcome,
} from '../../modules/location-config/repositories/location-storage.js';
import { DEFAULT_IMAGE_LIMIT, DEFAULT_MODEL_LIMIT, FileLocationAssetStore, validateAsset } from '../location-config/file-location-asset-store.js';
import { incrementLocationRegistryRevision, readLocationRegistryRevision } from './location-registry-revision.js';
import { queryRows } from './query-rows.js';
import { parseTrustedLegacyBaseline } from '../location-config/legacy-location-mapper.js';
import { persistLocationNodeAssignments } from './location-node-assignment-writer.js';

interface DraftRow {
  draft_id: string; creator_id: string; location_id: string; draft_revision: number; base_published_revision: number | null;
  created_at: number | string; updated_at: number | string; document: unknown; legacy_spatial?: unknown; asset_provenance?: unknown;
}
interface PublishedRow { location_id: string; revision: number | string; created_by: string; created_at: number | string; document: unknown; legacy_spatial?: unknown; asset_provenance?: unknown; }
interface ActivePublishedRow extends PublishedRow { active_revision: number | string; }
interface AssetRow { asset_id: string; creator_id: string; purpose: LocationAssetMetadata['purpose']; media_type: LocationAssetMetadata['mediaType']; display_name?: string | null; furniture_type?: FurnitureType | null; sha256: string; byte_length: number | string; created_at: number | string; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** PostgreSQL CAS adapter. A missing or foreign-owned row has the same result. */
export class PostgresLocationDraftRepository implements LocationDraftRepository {
  constructor(private readonly source: DataSource) {}

  async createDraft(input: LocationDraft): Promise<DraftWriteOutcome> {
    const draft = validateDraft(input);
    try {
      const result: unknown = await this.source.query(
        `INSERT INTO public.location_drafts
          (draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
         ON CONFLICT (draft_id) DO NOTHING
         RETURNING draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance`,
        [draft.draftId, draft.creatorId, draft.locationId, draft.draftRevision, draft.basePublishedRevision, draft.createdAt, draft.updatedAt, JSON.stringify(draft.document), JSON.stringify(draft.legacySpatial ?? null), JSON.stringify(draft.assetProvenance ?? {})],
      );
      const rows = queryRows<DraftRow>(result);
      if (!rows[0]) throw new LocationConflictError('The draft ID already exists.');
      return committedDraftOutcome(mapDraft(rows[0]));
    } catch (error) { throw storageError(error); }
  }

  async getDraft(creatorId: string, draftId: string): Promise<LocationDraft | null> {
    validateCreatorId(creatorId);
    if (!UUID_RE.test(draftId)) return null;
    try {
      const rows = await this.source.query(
        `SELECT draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance
         FROM public.location_drafts WHERE creator_id = $1 AND draft_id = $2`, [creatorId, draftId],
      ) as DraftRow[];
      return rows[0] ? mapDraft(rows[0]) : null;
    } catch (error) { throw storageError(error); }
  }

  async getDraftForRead(creatorId: string, draftId: string): Promise<LocationDraft | null> {
    return this.getDraft(creatorId, draftId);
  }

  async getDraftForReadWithinMutation(creatorId: string, draftId: string): Promise<LocationDraft | null> {
    return this.getDraft(creatorId, draftId);
  }

  async listDrafts(creatorId: string): Promise<LocationDraft[]> {
    validateCreatorId(creatorId);
    try {
      const rows = await this.source.query(
        `SELECT draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance
         FROM public.location_drafts WHERE creator_id = $1 ORDER BY updated_at DESC, draft_id`, [creatorId],
      ) as DraftRow[];
      return rows.map(mapDraft);
    } catch (error) { throw storageError(error); }
  }

  async saveDraft(creatorId: string, draftId: string, expectedRevision: number, candidateInput: ValidatedLocationCandidate, updatedAt: number): Promise<DraftWriteOutcome> {
    validateCreatorId(creatorId);
    if (!UUID_RE.test(draftId)) throw new LocationDraftNotFoundError();
    const candidate = validateCandidate(candidateInput);
    const { document } = candidate;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new TypeError('Draft save metadata is invalid.');
    try {
      return await this.source.transaction(async (manager) => {
        const rows = await manager.query(
          `SELECT draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance
           FROM public.location_drafts WHERE creator_id = $1 AND draft_id = $2 FOR UPDATE`, [creatorId, draftId],
        ) as DraftRow[];
        if (!rows[0]) throw new LocationDraftNotFoundError();
        const current = mapDraft(rows[0]);
        if (current.draftRevision !== expectedRevision) throw new LocationConflictError();
        if (document.locationId !== current.locationId) throw new TypeError('A draft cannot change its location ID.');
        if (document.visibility !== current.document.visibility) throw new TypeError('A draft cannot change server-managed location visibility.');
        if (updatedAt < current.updatedAt) throw new TypeError('Draft update time cannot move backwards.');
        const savedResult: unknown = await manager.query(
          `UPDATE public.location_drafts SET draft_revision = draft_revision + 1, updated_at = $4, document = $5::jsonb, legacy_spatial = $6::jsonb, asset_provenance = $7::jsonb
           WHERE creator_id = $1 AND draft_id = $2 AND draft_revision = $3
           RETURNING draft_id, creator_id, location_id, draft_revision, base_published_revision, created_at, updated_at, document, legacy_spatial, asset_provenance`,
          [creatorId, draftId, expectedRevision, updatedAt, JSON.stringify(document), JSON.stringify(candidate.legacySpatial), JSON.stringify(candidate.assetProvenance ?? {})],
        );
        const savedRows = queryRows<DraftRow>(savedResult);
        if (!savedRows[0]) throw new LocationConflictError();
        return committedDraftOutcome(mapDraft(savedRows[0]));
      });
    } catch (error) { throw storageError(error); }
  }
}

/** Owner-filtered metadata backed by PostgreSQL. */
export class PostgresLocationAssetMetadataRepository implements LocationAssetMetadataRepository {
  constructor(private readonly source: DataSource) {}

  async saveAssetMetadata(metadata: LocationAssetMetadata): Promise<void> {
    validateAssetMetadata(metadata);
    try {
      const result: unknown = await this.source.query(
        `INSERT INTO public.location_assets (asset_id, creator_id, purpose, media_type, display_name, furniture_type, sha256, byte_length, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (asset_id) DO NOTHING RETURNING asset_id`,
        [metadata.assetId, metadata.creatorId, metadata.purpose, metadata.mediaType, metadata.displayName ?? null, metadata.furnitureType ?? null, metadata.sha256, metadata.byteLength, metadata.createdAt],
      );
      const rows = queryRows<{ asset_id: string }>(result);
      if (!rows[0]) throw new LocationConflictError('Asset metadata is immutable and already exists.');
    } catch (error) { throw storageError(error); }
  }

  async getAssetMetadata(creatorId: string, assetId: string): Promise<LocationAssetMetadata | null> {
    validateCreatorId(creatorId);
    if (!UUID_RE.test(assetId)) return null;
    try {
      const rows = await this.source.query(
        `SELECT asset_id, creator_id, purpose, media_type, display_name, furniture_type, sha256, byte_length, created_at
         FROM public.location_assets WHERE creator_id = $1 AND asset_id = $2`, [creatorId, assetId],
      ) as AssetRow[];
      return rows[0] ? mapAsset(rows[0]) : null;
    } catch (error) { throw storageError(error); }
  }

  async getFurnitureMetadata(assetId: string): Promise<FurnitureLibraryMetadata | null> {
    if (!UUID_RE.test(assetId)) return null;
    try {
      const rows = await this.source.query(
        `SELECT asset_id, creator_id, purpose, media_type, display_name, furniture_type, sha256, byte_length, created_at
         FROM public.location_assets WHERE purpose = 'furniture' AND asset_id = $1`, [assetId],
      ) as AssetRow[];
      const metadata = rows[0] ? mapAsset(rows[0]) : null;
      return metadata?.purpose === 'furniture' ? metadata as FurnitureLibraryMetadata : null;
    } catch (error) { throw storageError(error); }
  }

  async listFurnitureMetadata(filter: { furnitureType?: FurnitureType; query?: string }): Promise<FurnitureLibraryMetadata[]> {
    try {
      const rows = await this.source.query(
        `SELECT asset_id, creator_id, purpose, media_type, display_name, furniture_type, sha256, byte_length, created_at
         FROM public.location_assets
         WHERE purpose = 'furniture'
           AND ($1::text IS NULL OR furniture_type = $1)
           AND ($2::text IS NULL OR strpos(lower(display_name), lower($2)) > 0)
         ORDER BY created_at DESC, asset_id ASC`,
        [filter.furnitureType ?? null, filter.query ?? null],
      ) as AssetRow[];
      return rows.map(mapAsset).filter((metadata) => metadata.purpose === 'furniture') as FurnitureLibraryMetadata[];
    } catch (error) { throw storageError(error); }
  }
}

/** Stores immutable bytes in persistent DATA_DIR and metadata in PostgreSQL. */
export class PostgresLocationAssetStore implements LocationAssetStore, FurnitureLibraryStore {
  private readonly bytes: FileLocationAssetStore;
  private readonly metadata: PostgresLocationAssetMetadataRepository;
  constructor(source: DataSource, dataDir: string) {
    this.bytes = new FileLocationAssetStore(dataDir);
    this.metadata = new PostgresLocationAssetMetadataRepository(source);
  }

  async put(creatorId: string, purpose: LocationAssetMetadata['purpose'], declaredMediaType: string, data: Uint8Array, createdAt: number, displayName?: string): Promise<LocationAssetMetadata> {
    validateAsset(purpose, declaredMediaType, data);
    const metadata = await this.bytes.put(creatorId, purpose, declaredMediaType, data, createdAt, displayName);
    await this.metadata.saveAssetMetadata(metadata);
    return metadata;
  }

  async read(creatorId: string, assetId: string): Promise<{ metadata: LocationAssetMetadata; bytes: Buffer } | null> {
    const metadata = await this.metadata.getAssetMetadata(creatorId, assetId);
    if (!metadata) return null;
    const stored = await this.bytes.read(creatorId, assetId);
    if (!stored) throw new LocationStorageUnavailableError();
    if (!sameAssetMetadata(metadata, stored.metadata)) throw new LocationStorageUnavailableError();
    return { metadata, bytes: stored.bytes };
  }

  async createFurnitureItem(input: { creatorId: string; furnitureType: FurnitureType; displayName: string; bytes: Uint8Array; createdAt: number }): Promise<FurnitureLibraryMetadata> {
    const metadata = await this.bytes.createFurnitureItem(input);
    await this.metadata.saveAssetMetadata(metadata);
    return metadata;
  }

  getFurnitureMetadata(assetId: string): Promise<FurnitureLibraryMetadata | null> {
    return this.metadata.getFurnitureMetadata(assetId);
  }

  listFurnitureMetadata(filter: { furnitureType?: FurnitureType; query?: string }): Promise<FurnitureLibraryMetadata[]> {
    return this.metadata.listFurnitureMetadata(filter);
  }

  async readFurnitureItem(assetId: string): Promise<{ metadata: FurnitureLibraryMetadata; bytes: Buffer } | null> {
    const metadata = await this.metadata.getFurnitureMetadata(assetId);
    if (!metadata) return null;
    const stored = await this.bytes.readFurnitureItem(assetId);
    if (!stored || !sameAssetMetadata(metadata, stored.metadata)) throw new LocationStorageUnavailableError();
    return { metadata, bytes: stored.bytes };
  }
}

/** Immutable revision history and atomic active-pointer/node-placement transaction. */
export class PostgresPublishedLocationRepository implements PublishedLocationRepository {
  constructor(
    private readonly source: DataSource,
    private readonly seedLocationIds: ReadonlySet<string> = new Set(),
    private readonly coordinator: RegistryMutationCoordinator,
    private readonly runTransaction: <T>(work: (manager: EntityManager) => Promise<T>) => Promise<T> = (work) => source.transaction(work),
  ) {}

  async assertLocationIdAvailable(locationId: string): Promise<void> {
    this.coordinator.assertHealthy();
    if (!isLocationId(locationId)) throw new TypeError('Location ID is invalid.');
    if (this.seedLocationIds.has(locationId)) throw new LocationConflictError('The location ID is already in use.');
    try {
      const rows = await this.source.query('SELECT 1 FROM public.location_published_revisions WHERE location_id = $1 LIMIT 1', [locationId]) as unknown[];
      if (rows.length > 0) throw new LocationConflictError('The location ID is already in use.');
    } catch (error) { throw storageError(error); }
  }

  async getActive(locationId: string): Promise<PublishedLocationState | null> {
    this.coordinator.assertHealthy();
    try {
      const rows = await this.source.query(
        `SELECT a.revision AS active_revision, r.location_id, r.revision, r.created_by, r.created_at, r.document, r.legacy_spatial, r.asset_provenance
         FROM public.location_active_revisions a
         JOIN public.location_published_revisions r ON r.location_id = a.location_id
         WHERE a.location_id = $1 ORDER BY r.revision`, [locationId],
      ) as ActivePublishedRow[];
      if (!rows[0]) return null;
      const activeRevision = toSafeInteger(rows[0].active_revision, 'active revision');
      const history = rows.map(mapPublished);
      if (!history.some((item) => item.revision === activeRevision)) throw new LocationStorageUnavailableError();
      validatePublishedHistory(history);
      return { locationId, activeRevision, history };
    } catch (error) { throw storageError(error); }
  }

  async listActive(): Promise<PublishedLocationState[]> {
    this.coordinator.assertHealthy();
    try {
      const rows = await this.source.query(
        `SELECT a.revision AS active_revision, r.location_id, r.revision, r.created_by, r.created_at, r.document, r.legacy_spatial, r.asset_provenance
         FROM public.location_active_revisions a
         JOIN public.location_published_revisions r ON r.location_id = a.location_id
         ORDER BY r.location_id, r.revision`,
      ) as ActivePublishedRow[];
      const grouped = new Map<string, { activeRevision: number; history: PublishedLocationRevision[] }>();
      for (const row of rows) {
        const activeRevision = toSafeInteger(row.active_revision, 'active revision');
        const group = grouped.get(row.location_id);
        if (group && group.activeRevision !== activeRevision) throw new LocationStorageUnavailableError();
        if (group) group.history.push(mapPublished(row));
        else grouped.set(row.location_id, { activeRevision, history: [mapPublished(row)] });
      }
      return [...grouped].map(([locationId, { activeRevision, history }]) => {
        if (!history.some((item) => item.revision === activeRevision)) throw new LocationStorageUnavailableError();
        validatePublishedHistory(history);
        return { locationId, activeRevision, history };
      });
    } catch (error) { throw storageError(error); }
  }

  async listHistory(locationId: string): Promise<PublishedLocationRevision[]> {
    this.coordinator.assertHealthy();
    try {
      const rows = await this.source.query(
        `SELECT location_id, revision, created_by, created_at, document, legacy_spatial, asset_provenance
         FROM public.location_published_revisions WHERE location_id = $1 ORDER BY revision`, [locationId],
      ) as PublishedRow[];
      const history = rows.map(mapPublished);
      validatePublishedHistory(history);
      return history;
    } catch (error) { throw storageError(error); }
  }

  async commitWithinMutation(input: {
    expectedRegistryRevision: number;
    expectedPublishedRevision: number | null;
    revision: PublishedLocationRevision;
    assignments: readonly LocationSensorAssignment[];
  }): Promise<RegistryCommitOutcome> {
    const candidate = validateCandidate({
      document: input.revision.document as LocationDocument,
      legacySpatial: input.revision.legacySpatial ?? null,
      assetProvenance: input.revision.assetProvenance,
    });
    const candidateDocument = candidate.document;
    const candidateLocationRevision = (input.expectedPublishedRevision ?? 0) + 1;
    const candidateRegistryRevision = input.expectedRegistryRevision + 1;
    try {
      const result = await this.runTransaction(async (manager) => {
        const registryRevision = await lockRegistryRevision(manager);
        if (registryRevision !== input.expectedRegistryRevision) throw new LocationConflictError('The registry changed; reload before publishing.');
        const document = candidate.document;
        if (document.locationId !== input.revision.locationId || !Number.isSafeInteger(input.revision.createdAt) || input.revision.createdAt < 0
          || input.revision.createdBy.trim() === '' || !sameAssignments(document.sensorAssignments, input.assignments)) {
          throw new TypeError('Published revision metadata or assignments are invalid.');
        }
        const activeRows = await manager.query(
          `SELECT a.revision, r.created_by, r.created_at, r.document, r.legacy_spatial, r.asset_provenance FROM public.location_active_revisions a
           JOIN public.location_published_revisions r ON r.location_id = a.location_id AND r.revision = a.revision
           WHERE a.location_id = $1 FOR UPDATE OF a`, [input.revision.locationId],
        ) as Array<{ revision: number | string; created_by: string; created_at: number | string; document: unknown; legacy_spatial: unknown; asset_provenance: unknown }>;
        const active = activeRows[0] ? toSafeInteger(activeRows[0].revision, 'active revision') : null;
        if (active !== input.expectedPublishedRevision) throw new LocationConflictError('The published location changed; reload before publishing.');
        if (active === null && this.seedLocationIds.has(input.revision.locationId)) {
          throw new LocationConflictError('The location ID belongs to a legacy seed and cannot be created as new.');
        }
        const baseRevision: PublishedLocationRevision | null = activeRows[0] ? {
          locationId: input.revision.locationId,
          revision: active!,
          createdBy: activeRows[0].created_by,
          createdAt: toSafeInteger(activeRows[0].created_at, 'published creation time'),
          document: active === 0 ? parseTrustedLegacyBaseline(parseJson(activeRows[0].document)) : parseLocationDocument(parseJson(activeRows[0].document)),
          legacySpatial: parseLegacySpatialProvenance(activeRows[0].legacy_spatial),
          assetProvenance: parseLocationAssetProvenance(parseJson(activeRows[0].asset_provenance), active === 0 ? parseTrustedLegacyBaseline(parseJson(activeRows[0].document)) : parseLocationDocument(parseJson(activeRows[0].document))),
        } : null;
        const checkedCandidate = revalidateLocationCandidate(document, candidate.legacySpatial, baseRevision, active);
        const assetProvenance = validateLocationAssetProvenanceTransition(
          checkedCandidate.document, candidate.assetProvenance, input.revision.createdBy,
          baseRevision ? { revision: baseRevision.revision, document: baseRevision.document, assetProvenance: baseRevision.assetProvenance } : null,
        );
        const activeDocument = baseRevision?.document ?? null;
        if (activeDocument && activeDocument.visibility !== document.visibility) {
          throw new LocationConflictError('Location visibility is inherited and cannot be changed by a draft.');
        }
        if (!activeDocument && document.visibility !== 'public') {
          throw new LocationConflictError('New locations use the public visibility default.');
        }
        if (active === null) {
          const existingRows = await manager.query('SELECT 1 FROM public.location_published_revisions WHERE location_id = $1 LIMIT 1', [input.revision.locationId]) as unknown[];
          if (existingRows.length > 0) throw new LocationConflictError('The location has immutable history but no active revision.');
        }
        const nextRevision = (active ?? 0) + 1;
        if (input.revision.revision !== nextRevision) throw new TypeError(`Published revision must be ${nextRevision}.`);
        await validateGlobalTableIds(manager, input.revision.locationId, document);
        await persistLocationNodeAssignments(manager, input.revision.locationId, document);
        await manager.query(
          `INSERT INTO public.location_published_revisions (location_id, revision, created_by, created_at, document, legacy_spatial, asset_provenance)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
          [input.revision.locationId, nextRevision, input.revision.createdBy, input.revision.createdAt, JSON.stringify(checkedCandidate.document), JSON.stringify(checkedCandidate.legacySpatial), JSON.stringify(assetProvenance)],
        );
        await manager.query(
          `INSERT INTO public.location_active_revisions (location_id, revision) VALUES ($1, $2)
           ON CONFLICT (location_id) DO UPDATE SET revision = EXCLUDED.revision`,
          [input.revision.locationId, nextRevision],
        );
        const updatedRegistryRevision = await incrementLocationRegistryRevision(manager);
        return { registryRevision: updatedRegistryRevision, activeRevision: nextRevision };
      });
      return { kind: 'committed', durability: 'confirmed', acknowledgement: 'received', ...result };
    } catch (error) {
      if (isDeterministicLocationFailure(error)) throw storageError(error);

      let reconciled: 'committed' | 'notCommitted' | 'unknown';
      try {
        reconciled = await this.reconcileCommit(
          input.expectedRegistryRevision,
          input.expectedPublishedRevision,
          candidateRegistryRevision,
          candidateLocationRevision,
          { ...input.revision, assetProvenance: candidate.assetProvenance },
          candidateDocument,
        );
      } catch {
        reconciled = 'unknown';
      }
      if (reconciled === 'committed') {
        return {
          kind: 'committed', durability: 'confirmed', acknowledgement: 'reconciled',
          registryRevision: candidateRegistryRevision, activeRevision: candidateLocationRevision,
        };
      }
      if (reconciled === 'notCommitted') throw storageError(error);

      const unknown = new UnknownRegistryCommitOutcomeError(
        input.expectedRegistryRevision, candidateRegistryRevision, input.revision.locationId,
      );
      this.coordinator.quarantine(unknown);
      throw unknown;
    }
  }

  async registryRevision(): Promise<number> {
    this.coordinator.assertHealthy();
    try {
      return await readLocationRegistryRevision(this.source.manager);
    } catch (error) { throw storageError(error); }
  }

  private async reconcileCommit(
    baseRegistryRevision: number,
    expectedPublishedRevision: number | null,
    candidateRegistryRevision: number,
    candidateLocationRevision: number,
    inputRevision: PublishedLocationRevision,
    candidateDocument: LocationDocument,
  ): Promise<'committed' | 'notCommitted' | 'unknown'> {
    const actualRegistryRevision = await readLocationRegistryRevision(this.source.manager);
    const activeRows = await this.source.query(
      `SELECT a.revision AS active_revision, r.revision, r.created_by, r.created_at, r.document, r.legacy_spatial, r.asset_provenance
       FROM public.location_active_revisions a
       JOIN public.location_published_revisions r ON r.location_id = a.location_id AND r.revision = a.revision
       WHERE a.location_id = $1`, [inputRevision.locationId],
    ) as Array<{ active_revision: number | string; revision: number | string; created_by: string; created_at: number | string; document: unknown; legacy_spatial: unknown; asset_provenance: unknown }>;
    const candidateRows = await this.source.query(
      `SELECT revision FROM public.location_published_revisions WHERE location_id = $1 AND revision = $2`,
      [inputRevision.locationId, candidateLocationRevision],
    ) as Array<{ revision: number | string }>;

    if (actualRegistryRevision === candidateRegistryRevision && activeRows[0]
      && toSafeInteger(activeRows[0].active_revision, 'active revision') === candidateLocationRevision
      && toSafeInteger(activeRows[0].revision, 'published revision') === candidateLocationRevision
      && activeRows[0].created_by === inputRevision.createdBy
      && toSafeInteger(activeRows[0].created_at, 'published timestamp') === inputRevision.createdAt
      && sameLocationDocument(parseLocationDocument(parseJson(activeRows[0].document)), candidateDocument)
      && sameJson(parseLegacySpatialProvenance(activeRows[0].legacy_spatial), inputRevision.legacySpatial ?? null)
      && sameLocationAssetProvenance(parseJson(activeRows[0].asset_provenance), inputRevision.assetProvenance ?? {})) {
      return 'committed';
    }

    const activeRowsAtBase = await this.source.query(
      'SELECT revision FROM public.location_active_revisions WHERE location_id = $1', [inputRevision.locationId],
    ) as Array<{ revision: number | string }>;
    const actualActiveRevision = activeRowsAtBase[0] ? toSafeInteger(activeRowsAtBase[0].revision, 'active revision') : null;
    if (actualRegistryRevision === baseRegistryRevision && actualActiveRevision === expectedPublishedRevision && candidateRows.length === 0) {
      return 'notCommitted';
    }
    return 'unknown';
  }
}

async function validateGlobalTableIds(manager: EntityManager, locationId: string, document: LocationDocument): Promise<void> {
  const rows = await manager.query(
    `SELECT r.location_id, r.revision, r.document
     FROM public.location_active_revisions a
     JOIN public.location_published_revisions r USING (location_id, revision)
     WHERE a.location_id <> $1`, [locationId],
  ) as Array<{ location_id: string; revision: number | string; document: unknown }>;
  const used = new Set<string>();
  const usedSeats = new Set<string>();
  for (const row of rows) {
    const active = toSafeInteger(row.revision, 'published revision') === 0
      ? parseTrustedLegacyBaseline(row.document)
      : parseLocationDocument(row.document);
    for (const table of active.tables) {
      used.add(table.id);
      for (const seat of table.seats) usedSeats.add(seat.id);
    }
  }
  for (const table of document.tables) if (used.has(table.id)) throw new LocationConflictError(`Table ID "${table.id}" is already used by another location.`);
  for (const table of document.tables) {
    for (const seat of table.seats) {
      if (usedSeats.has(seat.id)) throw new LocationConflictError(`Seat ID "${seat.id}" is already used by another location.`);
    }
  }
}

async function lockRegistryRevision(manager: EntityManager): Promise<number> {
  const rows = await manager.query('SELECT revision FROM public.location_registry_revision WHERE id = 1 FOR UPDATE') as Array<{ revision: number | string }>;
  if (!rows[0]) throw new LocationStorageUnavailableError();
  return toSafeInteger(rows[0].revision, 'registry revision');
}

function mapDraft(row: DraftRow): LocationDraft {
  const document = parseLocationDocument(parseJson(row.document));
  const legacySpatial = parseLegacySpatialProvenance(parseJson(row.legacy_spatial));
  const assetProvenance = parseLocationAssetProvenance(parseJson(row.asset_provenance), document);
  const draft: LocationDraft = {
    draftId: row.draft_id.toLowerCase(), creatorId: row.creator_id, locationId: row.location_id,
    draftRevision: toSafeInteger(row.draft_revision, 'draft revision'),
    basePublishedRevision: row.base_published_revision === null ? null : toSafeInteger(row.base_published_revision, 'base published revision'),
    createdAt: toSafeInteger(row.created_at, 'draft creation time'),
    updatedAt: toSafeInteger(row.updated_at, 'draft update time'), document, legacySpatial, assetProvenance,
  };
  return validateDraft(draft);
}

function committedDraftOutcome(draft: LocationDraft): DraftWriteOutcome {
  return {
    kind: 'committed', durability: 'confirmed', draft,
    contentSha256: createHash('sha256').update(JSON.stringify(draft)).digest('hex'),
  };
}

function mapPublished(row: PublishedRow): PublishedLocationRevision {
  const revisionNumber = toSafeInteger(row.revision, 'published revision');
  const storedDocument = parseJson(row.document);
  const document = revisionNumber === 0 ? parseTrustedLegacyBaseline(storedDocument) : parseLocationDocument(storedDocument);
  const assetProvenance = row.asset_provenance === undefined && revisionNumber === 0
    ? legacyStaticModelProvenance(document as ReturnType<typeof parseTrustedLegacyBaseline>)
    : parseLocationAssetProvenance(parseJson(row.asset_provenance), document);
  const revision = {
    locationId: row.location_id, revision: revisionNumber,
    createdBy: row.created_by, createdAt: toSafeInteger(row.created_at, 'published creation time'),
    document,
    legacySpatial: revisionNumber === 0 ? null : parseLegacySpatialProvenance(parseJson(row.legacy_spatial)),
    assetProvenance,
  };
  if (revision.document.locationId !== revision.locationId) throw new LocationStorageUnavailableError();
  return revision;
}

function mapAsset(row: AssetRow): LocationAssetMetadata {
  const metadata: LocationAssetMetadata = {
    assetId: row.asset_id.toLowerCase(), creatorId: row.creator_id, purpose: row.purpose,
    mediaType: row.media_type, sha256: row.sha256, byteLength: toSafeInteger(row.byte_length, 'asset size'),
    createdAt: toSafeInteger(row.created_at, 'asset creation time'),
    ...(typeof row.display_name === 'string' ? { displayName: row.display_name } : {}),
    ...(row.furniture_type === 'table' || row.furniture_type === 'chair' ? { furnitureType: row.furniture_type } : {}),
  };
  validateAssetMetadata(metadata);
  return metadata;
}

function validateDraft(value: LocationDraft): LocationDraft {
  if (!value || typeof value !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.draftId)
    || typeof value.creatorId !== 'string' || value.creatorId.trim() === '' || value.creatorId.length > 256
    || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 1
    || (value.basePublishedRevision !== null && (!Number.isSafeInteger(value.basePublishedRevision) || value.basePublishedRevision < 0))
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new TypeError('Draft record is invalid.');
  }
  if (Object.keys(value).some((key) => !['draftId', 'creatorId', 'locationId', 'draftRevision', 'basePublishedRevision', 'createdAt', 'updatedAt', 'document', 'legacySpatial', 'assetProvenance'].includes(key))) {
    throw new TypeError('Draft record contains an unknown field.');
  }
  const document = parseLocationDocument(value.document);
  if (document.locationId !== value.locationId) throw new TypeError('Draft location ID must match its document.');
  const legacySpatial = parseLegacySpatialProvenance(value.legacySpatial);
  const assetProvenance = parseLocationAssetProvenance(value.assetProvenance, document);
  if (legacySpatial && legacySpatial.basePublishedRevision !== value.basePublishedRevision) throw new TypeError('Draft provenance must match its pinned published revision.');
  return { ...value, draftId: value.draftId.toLowerCase(), document, legacySpatial, assetProvenance };
}

function validateCandidate(value: ValidatedLocationCandidate): ValidatedLocationCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['document', 'legacySpatial', 'assetProvenance'].includes(key))) throw new TypeError('Location candidate is invalid.');
  const document = parseLocationDocument(value.document);
  return {
    document,
    legacySpatial: parseLegacySpatialProvenance(value.legacySpatial),
    assetProvenance: parseLocationAssetProvenance(value.assetProvenance, document),
  };
}

function validatePublishedHistory(history: readonly PublishedLocationRevision[]): void {
  const byRevision = new Map(history.map((revision) => [revision.revision, revision]));
  for (const revision of history) {
    try {
      const baseRevision = revision.revision === 0 ? null : revision.revision - 1;
      const base = baseRevision === null ? null : byRevision.get(baseRevision) ?? null;
      if (revision.revision > 1 && !base) throw new Error('Published history has a gap.');
      if (revision.legacySpatial) {
        const spatialBase = byRevision.get(revision.legacySpatial.basePublishedRevision);
        if (!spatialBase || spatialBase.revision !== revision.revision - 1) throw new Error('Legacy spatial base does not match revision history.');
      revalidateLocationCandidate(
        revision.document as LocationDocument,
        revision.legacySpatial,
          spatialBase ? { revision: spatialBase.revision, document: spatialBase.document, legacySpatial: spatialBase.legacySpatial } : null,
          spatialBase?.revision ?? null,
      );
      }
      if (revision.revision === 0) {
        const trustedSeed = legacyStaticModelProvenance(revision.document as ReturnType<typeof parseTrustedLegacyBaseline>);
        if (!sameLocationAssetProvenance(parseLocationAssetProvenance(revision.assetProvenance, revision.document), trustedSeed)) throw new Error('Revision-zero asset provenance is not trusted seed provenance.');
      } else {
        validateLocationAssetProvenanceTransition(
          revision.document as LocationDocument, revision.assetProvenance, revision.createdBy,
          base ? { revision: base.revision, document: base.document, assetProvenance: base.assetProvenance } : null,
        );
      }
    } catch { throw new LocationStorageUnavailableError(); }
  }
}

function validateAssetMetadata(metadata: LocationAssetMetadata): void {
  if (!metadata || typeof metadata !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.assetId)
    || typeof metadata.creatorId !== 'string' || metadata.creatorId.trim() === '' || metadata.creatorId.length > 256
    || (metadata.purpose !== 'floor-plan' && metadata.purpose !== 'model' && metadata.purpose !== 'furniture') || !/^[0-9a-f]{64}$/.test(metadata.sha256)
    || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1
    || (metadata.purpose === 'floor-plan' && metadata.byteLength > DEFAULT_IMAGE_LIMIT)
    || ((metadata.purpose === 'model' || metadata.purpose === 'furniture') && metadata.byteLength > DEFAULT_MODEL_LIMIT)
    || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0
    || ((metadata.purpose === 'model' || metadata.purpose === 'furniture') && metadata.mediaType !== 'model/gltf-binary')
    || (metadata.purpose === 'floor-plan' && metadata.mediaType !== 'image/png' && metadata.mediaType !== 'image/jpeg')) {
    throw new TypeError('Asset metadata is invalid.');
  }
  if ((metadata.purpose === 'furniture' && (metadata.furnitureType !== 'table' && metadata.furnitureType !== 'chair' || metadata.displayName === undefined))
    || (metadata.purpose !== 'furniture' && metadata.furnitureType !== undefined)) throw new TypeError('Furniture asset metadata is invalid.');
  if (metadata.displayName !== undefined && (metadata.purpose !== 'model' && metadata.purpose !== 'furniture'
    || normalizeLocationAssetDisplayName(metadata.displayName) !== metadata.displayName)) {
    throw new TypeError('Asset display name is invalid.');
  }
}

function validateCreatorId(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new TypeError('Creator ID is invalid.');
}

function sameAssetMetadata(a: LocationAssetMetadata, b: LocationAssetMetadata): boolean {
  return a.assetId === b.assetId && a.creatorId === b.creatorId && a.purpose === b.purpose && a.mediaType === b.mediaType
    && a.displayName === b.displayName && a.furnitureType === b.furnitureType && a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.createdAt === b.createdAt;
}
function sameAssignments(a: readonly LocationSensorAssignment[], b: readonly LocationSensorAssignment[]): boolean {
  const normalize = (rows: readonly LocationSensorAssignment[]) => [...rows].map((row) => ({
    uid: row.uid.toLowerCase(), pose: row.pose, owns: [...row.owns].sort(),
  })).sort((x, y) => x.uid.localeCompare(y.uid));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function sameLocationDocument(a: LocationDocument, b: LocationDocument): boolean {
  return JSON.stringify(parseLocationDocument(a)) === JSON.stringify(parseLocationDocument(b));
}
function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function isDeterministicLocationFailure(error: unknown): boolean {
  return error instanceof LocationConflictError || error instanceof LocationDraftNotFoundError
    || error instanceof LocationStorageUnavailableError || error instanceof TypeError
    || error instanceof RangeError || error instanceof InvalidLocationDocumentError;
}
function parseJson(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) as unknown : value; }
function toSafeInteger(value: number | string, where: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LocationStorageUnavailableError();
  return parsed;
}
function storageError(error: unknown): Error {
  return error instanceof LocationConflictError || error instanceof LocationDraftNotFoundError || error instanceof TypeError
    || error instanceof RangeError || error instanceof InvalidLocationDocumentError
    ? error : new LocationStorageUnavailableError();
}
