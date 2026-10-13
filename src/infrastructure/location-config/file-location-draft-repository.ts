import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvalidLocationDocumentError, parseLocationDocument, isLocationId, type LocationDocument } from '../../modules/location-config/domain/location-document.js';
import { parseLegacySpatialProvenance, type ValidatedLocationCandidate } from '../../modules/location-config/domain/location-candidate.js';
import { parseLocationAssetProvenance } from '../../modules/location-config/domain/location-assets.js';
import { LocationConflictError, LocationDraftNotFoundError, LocationStorageUnavailableError, type LocationDraft } from '../../modules/location-config/domain/location-records.js';
import type { DraftWriteOutcome, LocationDraftRepository, RegistryMutationCoordinator } from '../../modules/location-config/repositories/location-storage.js';
import { atomicReplaceFile, fileSha256, verifyAndSyncFile, type AtomicFileOperations } from './atomic-file-write.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRAFT_FILE_BYTES = 8 * 1024 * 1024;

/** Creator-hashed filenames keep caller identity out of paths and drafts private by construction. */
export class FileLocationDraftRepository implements LocationDraftRepository {
  private readonly unconfirmed = new Map<string, string>();
  private readonly verified = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly coordinator: RegistryMutationCoordinator,
    private readonly writeOperations: AtomicFileOperations = {},
  ) {}

  async createDraft(draftInput: LocationDraft): Promise<DraftWriteOutcome> {
    const draft = validateDraft(draftInput);
    try {
      return await this.coordinator.withMutationLock(async () => {
        const path = this.pathFor(draft.creatorId);
        this.recoverCurrent(path, draft.creatorId);
        const rows = readRows(path, draft.creatorId);
        if (rows.some((row) => row.draftId === draft.draftId)) throw new LocationConflictError('The draft ID already exists for this creator.');
        rows.push(draft);
        const write = writeRows(path, rows, this.writeOperations);
        this.recordWrite(path, write.durability, write.sha256);
        return { kind: 'committed', durability: write.durability, draft: structuredClone(draft), contentSha256: write.sha256 };
      });
    } catch (error) { throw draftStorageError(error); }
  }

  async getDraft(creatorId: string, draftId: string): Promise<LocationDraft | null> {
    this.coordinator.assertHealthy();
    validateCreator(creatorId);
    if (!UUID_RE.test(draftId)) return null;
    try { return readRows(this.pathFor(creatorId), creatorId).find((row) => row.draftId === draftId.toLowerCase()) ?? null; }
    catch (error) { throw draftStorageError(error); }
  }

  async listDrafts(creatorId: string): Promise<LocationDraft[]> {
    this.coordinator.assertHealthy();
    validateCreator(creatorId);
    try { return readRows(this.pathFor(creatorId), creatorId); }
    catch (error) { throw draftStorageError(error); }
  }

  async saveDraft(creatorId: string, draftId: string, expectedRevision: number, candidateInput: ValidatedLocationCandidate, updatedAt: number): Promise<DraftWriteOutcome> {
    validateCreator(creatorId);
    if (!UUID_RE.test(draftId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new TypeError('Draft save metadata is invalid.');
    }
    const candidate = validateCandidate(candidateInput);
    const { document } = candidate;
    try {
      return await this.coordinator.withMutationLock(async () => {
        const path = this.pathFor(creatorId);
        this.recoverCurrent(path, creatorId);
        const rows = readRows(path, creatorId);
        const index = rows.findIndex((row) => row.draftId === draftId.toLowerCase());
        if (index < 0) throw new LocationDraftNotFoundError();
        const current = rows[index]!;
        if (current.draftRevision !== expectedRevision) throw new LocationConflictError();
        if (updatedAt < current.updatedAt) throw new TypeError('Draft update time cannot move backwards.');
        if (document.locationId !== current.locationId) throw new TypeError('A draft cannot change its location ID.');
        if (document.visibility !== current.document.visibility) throw new TypeError('A draft cannot change server-managed location visibility.');
        const saved: LocationDraft = {
          ...current,
          draftRevision: current.draftRevision + 1,
          updatedAt,
          document,
          legacySpatial: candidate.legacySpatial,
          assetProvenance: candidate.assetProvenance,
        };
        rows[index] = saved;
        const write = writeRows(path, rows, this.writeOperations);
        this.recordWrite(path, write.durability, write.sha256);
        return { kind: 'committed', durability: write.durability, draft: structuredClone(saved), contentSha256: write.sha256 };
      });
    } catch (error) { throw draftStorageError(error); }
  }

  private recoverCurrent(path: string, ownerId: string): void {
    if (!existsSync(path)) return;
    assertPrivateDirectorySync(dirname(path));
    assertPrivateFileSync(path);
    if (!this.unconfirmed.has(path) && this.verified.has(path)) return;
    try {
      const expected = this.unconfirmed.get(path) ?? fileSha256(readFileSync(path));
      verifyAndSyncFile(path, expected, (bytes) => validateDraftBytes(bytes, ownerId), this.writeOperations);
      this.unconfirmed.delete(path);
      this.verified.add(path);
    } catch {
      throw new LocationStorageUnavailableError();
    }
  }

  private recordWrite(path: string, durability: 'confirmed' | 'unconfirmed', sha256: string): void {
    if (durability === 'unconfirmed') {
      this.unconfirmed.set(path, sha256);
      this.verified.delete(path);
    } else {
      this.unconfirmed.delete(path);
      this.verified.add(path);
    }
  }

  private pathFor(creatorId: string): string {
    const digest = createHash('sha256').update(creatorId).digest('hex');
    return join(this.dataDir, 'location-drafts', `${digest}.json`);
  }
}

function validateDraft(value: LocationDraft): LocationDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Draft record is invalid.');
  const keys = Object.keys(value);
  if (keys.some((key) => !['draftId', 'creatorId', 'locationId', 'draftRevision', 'basePublishedRevision', 'createdAt', 'updatedAt', 'document', 'legacySpatial', 'assetProvenance'].includes(key))
    || !UUID_RE.test(value.draftId) || typeof value.creatorId !== 'string'
    || !isLocationId(value.locationId) || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 1
    || (value.basePublishedRevision !== null && (!Number.isSafeInteger(value.basePublishedRevision) || value.basePublishedRevision < 0))
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new TypeError('Draft record is invalid.');
  }
  validateCreator(value.creatorId);
  const document = parseLocationDocument(value.document);
  if (document.locationId !== value.locationId) throw new TypeError('Draft location ID must match its document.');
  const legacySpatial = parseLegacySpatialProvenance(value.legacySpatial);
  const assetProvenance = parseLocationAssetProvenance(value.assetProvenance, document);
  if ((legacySpatial?.basePublishedRevision ?? null) !== (legacySpatial ? value.basePublishedRevision : null)) throw new TypeError('Draft legacy spatial provenance must match its pinned base revision.');
  return { ...value, draftId: value.draftId.toLowerCase(), document, legacySpatial, assetProvenance };
}

function validateCandidate(value: ValidatedLocationCandidate): ValidatedLocationCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['document', 'legacySpatial', 'assetProvenance'].includes(key))) throw new TypeError('Draft candidate is invalid.');
  const document = parseLocationDocument(value.document);
  const legacySpatial = parseLegacySpatialProvenance(value.legacySpatial);
  const assetProvenance = parseLocationAssetProvenance(value.assetProvenance, document);
  if (legacySpatial && value.legacySpatial?.basePublishedRevision !== legacySpatial.basePublishedRevision) throw new TypeError('Draft candidate provenance is invalid.');
  return { document, legacySpatial, assetProvenance };
}

function readRows(path: string, ownerId: string): LocationDraft[] {
  try {
    assertPrivateDirectorySync(dirname(path));
    assertPrivateFileSync(path);
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parseDraftRows(value, ownerId);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function writeRows(path: string, rows: LocationDraft[], operations: AtomicFileOperations): { durability: 'confirmed' | 'unconfirmed'; sha256: string } {
  const bytes = `${JSON.stringify(rows)}\n`;
  if (Buffer.byteLength(bytes) > MAX_DRAFT_FILE_BYTES) throw new RangeError('Draft storage exceeds its configured limit.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertPrivateDirectorySync(dirname(path));
  const outcome = atomicReplaceFile(path, bytes, 0o600, '.draft', operations);
  return { durability: outcome.durability, sha256: outcome.sha256 };
}

function validateDraftBytes(bytes: Buffer, ownerId: string): void {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  parseDraftRows(value, ownerId);
}

function parseDraftRows(value: unknown, ownerId: string): LocationDraft[] {
  if (!Array.isArray(value)) throw new Error('Draft storage file is invalid.');
  const rows = value.map((row) => validateDraft(row as LocationDraft));
  if (rows.some((row) => row.creatorId !== ownerId)) throw new Error('Draft storage owner boundary was violated.');
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.draftId)) throw new Error('Draft storage file contains duplicate IDs.');
    ids.add(row.draftId);
  }
  return rows;
}

function validateCreator(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new TypeError('Creator ID is invalid.');
}
function assertPrivateDirectorySync(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat.mode)) throw new Error('Draft storage directory is not private.');
}
function assertPrivateFileSync(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !isPrivateMode(stat.mode) || stat.size > MAX_DRAFT_FILE_BYTES) {
    throw new Error('Draft storage file is invalid or not private.');
  }
}
function isPrivateMode(mode: number): boolean { return process.platform === 'win32' || (mode & 0o077) === 0; }
function draftStorageError(error: unknown): Error {
  return error instanceof LocationConflictError || error instanceof LocationDraftNotFoundError
    || error instanceof InvalidLocationDocumentError || error instanceof TypeError || error instanceof RangeError
    || error instanceof LocationStorageUnavailableError
    ? error : new LocationStorageUnavailableError();
}
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'; }
