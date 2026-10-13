import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { routeParam } from '../../../shared/http.js';
import type { LocationAssetSlot } from '../domain/location-assets.js';
import { InvalidLocationAssetReferenceError } from '../domain/location-assets.js';
import { exposeAuthoredLocationCandidate, revalidateLocationCandidate } from '../domain/location-candidate.js';
import { InvalidLocationDocumentError, parseLocationDocument, type LocationDocument, type LocationSensorAssignment } from '../domain/location-document.js';
import type { LocationDraft } from '../domain/location-records.js';
import {
  LocationConflictError, LocationDraftNotFoundError, LocationStorageUnavailableError, UnknownRegistryCommitOutcomeError,
} from '../domain/location-records.js';
import type {
  LocationAssetMetadataRepository, LocationAssetStore, LocationDraftRepository, LocationRegistrySnapshotRepository,
  PublishedLocationRepository, PublishedModelDistributor, RegistryMutationCoordinator,
} from '../repositories/location-storage.js';
import { CreateLocationDraftUseCase } from '../use-cases/create-location-draft.js';
import { StartLocationEditDraftUseCase } from '../use-cases/start-location-edit-draft.js';
import { SaveLocationDraftUseCase } from '../use-cases/save-location-draft.js';
import { PublishLocationUseCase, PublishedModelDistributionFailedError, PublishedModelDistributionUnavailableError } from '../use-cases/publish-location.js';
import { UploadLocationAssetUseCase } from '../use-cases/upload-location-asset.js';
import { ReadLocationDraftAssetUseCase } from '../use-cases/read-location-draft-asset.js';
import type { PreparedRuntimeGeneration } from '../../../edge/runtime.js';

export interface LocationRouterDependencies {
  auth: Pick<AlgoAuth, 'principalOf'>;
  edgeId: string;
  siteSeed: unknown;
  drafts: LocationDraftRepository;
  published: PublishedLocationRepository;
  snapshots: LocationRegistrySnapshotRepository;
  assets: LocationAssetStore;
  assetMetadata: LocationAssetMetadataRepository;
  coordinator: RegistryMutationCoordinator;
  runtime: import('../repositories/location-storage.js').PreparedLocationRuntime<PreparedRuntimeGeneration>;
  modelDistributor?: PublishedModelDistributor;
  suggestCoverage(
    siteSeed: unknown,
    snapshot: import('../repositories/location-storage.js').LocationRegistrySnapshot,
    document: LocationDocument,
    proposedSensors: LocationSensorAssignment[],
  ): Array<{ tableId: string; coveredBy: string[]; suggestedOwner: string | null }>;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOC_KEYS = ['name', 'building', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments', 'planAssetId', 'modelAssetId', 'modelTransform'];

export function createLocationRouter(dependencies: LocationRouterDependencies): Router {
  const router = Router();
  const create = new CreateLocationDraftUseCase({
    edgeId: dependencies.edgeId, drafts: dependencies.drafts, published: dependencies.published,
    snapshots: dependencies.snapshots, coordinator: dependencies.coordinator, now: dependencies.now,
  });
  const startEdit = new StartLocationEditDraftUseCase({
    drafts: dependencies.drafts, snapshots: dependencies.snapshots, mutationCoordinator: dependencies.coordinator, now: dependencies.now,
  });
  const save = new SaveLocationDraftUseCase({
    drafts: dependencies.drafts, published: dependencies.published, assetMetadata: dependencies.assetMetadata, now: dependencies.now,
  });
  const publish = new PublishLocationUseCase<PreparedRuntimeGeneration>({
    drafts: dependencies.drafts, published: dependencies.published, snapshots: dependencies.snapshots,
    mutationCoordinator: dependencies.coordinator, runtime: dependencies.runtime,
    assetMetadata: dependencies.assetMetadata, modelDistributor: dependencies.modelDistributor, now: dependencies.now,
  });
  const upload = new UploadLocationAssetUseCase({ drafts: dependencies.drafts, assets: dependencies.assets, saveDraft: save, now: dependencies.now });
  const readAsset = new ReadLocationDraftAssetUseCase({
    drafts: dependencies.drafts, published: dependencies.published,
    metadata: dependencies.assetMetadata, assets: dependencies.assets,
  });

  // This router is mounted at `/api`, so keep every middleware and fallback
  // inside its own namespace. A broad gate here would intercept shell APIs
  // such as `/api/me` before their normal handlers can run.
  router.use('/locations', (req, res, next) => {
    const principal = dependencies.auth.principalOf(req);
    if (!principal) return fail(res, 401, 'UNAUTHENTICATED', 'Sign in again.');
    if (!principal.capabilities.includes('locations.manage')) return fail(res, 403, 'FORBIDDEN', 'Location management is unavailable to this account.');
    res.locals.locationActor = principal.name;
    return next();
  });
  router.use('/locations', express.json({ limit: '1mb', strict: true }));

  router.get('/locations', asyncRoute(async (req, res) => {
    const creatorId = actor(req);
    const snapshot = await dependencies.snapshots.readSnapshot();
    const drafts = await dependencies.drafts.listDrafts(creatorId);
    const published = snapshot.locations.map((state) => {
      const active = state.history.find((revision) => revision.revision === state.activeRevision);
      if (!active) throw new LocationStorageUnavailableError();
      return {
        locationId: state.locationId, name: active.document.name, building: active.document.building,
        visibility: active.document.visibility, activeRevision: state.activeRevision,
      };
    });
    return send(res, 200, {
      published,
      drafts: drafts.map((draft) => draftSummary(draft)),
    });
  }));

  router.post('/locations/drafts', writeGuard, asyncRoute(async (req, res) => {
    const body = strictRecord(req.body, ['name', 'building', 'widthCm', 'heightCm']);
    const outcome = await create.execute({ creatorId: actor(req), name: body.name as string, building: body.building as string, widthCm: body.widthCm as number, heightCm: body.heightCm as number });
    return send(res, 201, await draftWriteDto(outcome.draft, outcome.durability, dependencies));
  }));

  router.post('/locations/:locationId/drafts', writeGuard, asyncRoute(async (req, res) => {
    const body = strictRecord(req.body, ['expectedPublishedRevision']);
    if (!Number.isSafeInteger(body.expectedPublishedRevision) || (body.expectedPublishedRevision as number) < 0) throw new TypeError('Expected published revision is invalid.');
    const outcome = await startEdit.execute({ creatorId: actor(req), locationId: routeParam(req.params, 'locationId'), expectedPublishedRevision: body.expectedPublishedRevision as number });
    return send(res, 201, await draftWriteDto(outcome.draft, outcome.durability, dependencies));
  }));

  router.get('/locations/drafts/:draftId', asyncRoute(async (req, res) => {
    const draft = await dependencies.drafts.getDraftForRead(actor(req), routeParam(req.params, 'draftId'));
    if (!draft) throw new LocationDraftNotFoundError();
    return send(res, 200, await draftDetailDto(draft, dependencies));
  }));

  router.put('/locations/drafts/:draftId', writeGuard, asyncRoute(async (req, res) => {
    const body = strictRecord(req.body, ['expectedDraftRevision', 'document']);
    if (!Number.isSafeInteger(body.expectedDraftRevision) || (body.expectedDraftRevision as number) < 1) throw new TypeError('Expected draft revision is invalid.');
    const draft = await requireDraft(dependencies.drafts, actor(req), routeParam(req.params, 'draftId'));
    const outcome = await save.execute({ creatorId: actor(req), draftId: draft.draftId, expectedDraftRevision: body.expectedDraftRevision as number, document: body.document });
    return send(res, 200, await draftWriteDto(outcome.draft, outcome.durability, dependencies));
  }));

  router.get('/locations/drafts/:draftId/sensors', asyncRoute(async (req, res) => {
    const draft = await requireDraft(dependencies.drafts, actor(req), routeParam(req.params, 'draftId'));
    const snapshot = await dependencies.snapshots.readSnapshot();
    const sensors = snapshot.nodes.filter((node) => (node.floorId === draft.locationId
      || (node.floorId === null && node.pose === null && node.owns.length === 0))
      && !(node.rgb && draft.document.visibility === 'public'))
      .map((node) => ({ uid: node.uid, label: node.label, simulated: node.simulated, rgb: node.rgb, detector: node.detector, pose: node.floorId === draft.locationId ? node.pose : null }));
    return send(res, 200, { locationId: draft.locationId, sensors });
  }));

  router.post('/locations/drafts/:draftId/coverage-suggestions', writeGuard, asyncRoute(async (req, res) => {
    const body = strictRecord(req.body, ['document', 'proposedSensors']);
    const draft = await requireDraft(dependencies.drafts, actor(req), routeParam(req.params, 'draftId'));
    const document = authoredDocument(body.document, draft);
    const proposedSensors = parseProposedSensors(body.proposedSensors, document);
    const snapshot = await dependencies.snapshots.readSnapshot();
    const suggestions = dependencies.suggestCoverage(dependencies.siteSeed, snapshot, document, proposedSensors);
    return send(res, 200, { locationId: draft.locationId, suggestions });
  }));

  router.put('/locations/drafts/:draftId/assets/:purpose', writeGuard, (req, res, next) => {
    const purpose = routeParam(req.params, 'purpose');
    if (purpose !== 'floor-plan' && purpose !== 'model') return fail(res, 404, 'NOT_FOUND', 'No such asset purpose.');
    const mediaType = req.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
    if ((purpose === 'floor-plan' && mediaType !== 'image/png' && mediaType !== 'image/jpeg')
      || (purpose === 'model' && mediaType !== 'model/gltf-binary')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'The asset media type is not supported.');
    const parser = express.raw({ type: () => true, limit: purpose === 'floor-plan' ? '20mb' : '128mb' });
    return parser(req, res, next);
  }, asyncRoute(async (req, res) => {
    const purpose = routeParam(req.params, 'purpose') as 'floor-plan' | 'model';
    const draftId = routeParam(req.params, 'draftId');
    const revision = parseIfMatch(req.get('if-match'));
    const mediaType = req.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
    if (!Buffer.isBuffer(req.body)) throw new TypeError('Asset request body is invalid.');
    const result = await upload.execute({ creatorId: actor(req), draftId, expectedDraftRevision: revision, purpose, mediaType, bytes: req.body });
    return send(res, 200, {
      assetId: result.metadata.assetId, mediaType: result.metadata.mediaType,
      sha256: result.metadata.sha256, byteLength: result.metadata.byteLength,
      draftRevision: result.outcome.draft.draftRevision, durability: result.outcome.durability,
    });
  }));

  router.get('/locations/drafts/:draftId/assets/:assetId', asyncRoute(async (req, res) => {
    const assetId = routeParam(req.params, 'assetId');
    const asset = await readAsset.execute({ creatorId: actor(req), draftId: routeParam(req.params, 'draftId'), assetId });
    return res.status(200).set({
      'Content-Type': asset.metadata.mediaType,
      'Content-Length': String(asset.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    }).send(asset.bytes);
  }));

  router.post('/locations/drafts/:draftId/publications', writeGuard, asyncRoute(async (req, res) => {
    const body = strictRecord(req.body, ['expectedDraftRevision', 'expectedPublishedRevision']);
    if (!Number.isSafeInteger(body.expectedDraftRevision) || (body.expectedDraftRevision as number) < 1
      || (body.expectedPublishedRevision !== null && (!Number.isSafeInteger(body.expectedPublishedRevision) || (body.expectedPublishedRevision as number) < 0))) {
      throw new TypeError('Publication revision preconditions are invalid.');
    }
    const result = await publish.execute({
      creatorId: actor(req), draftId: routeParam(req.params, 'draftId'),
      expectedDraftRevision: body.expectedDraftRevision as number,
      expectedPublishedRevision: body.expectedPublishedRevision as number | null,
    });
    return send(res, 200, result);
  }));

  router.use('/locations', (_req, res) => fail(res, 404, 'NOT_FOUND', 'No such location endpoint.'));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(res, error));
  return router;
}

function writeGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.get('x-tm-algo') !== '1') { fail(res, 403, 'FORBIDDEN', 'Missing x-tm-algo header.'); return; }
  const origin = req.get('origin');
  if (!origin) { fail(res, 403, 'FORBIDDEN', 'Request origin is required.'); return; }
  let matches = false;
  try { const url = new URL(origin); matches = url.origin === new URL(`${req.protocol}://${req.get('host')}`).origin && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { /* rejected below */ }
  if (!matches) { fail(res, 403, 'FORBIDDEN', 'Request origin is not permitted.'); return; }
  next();
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
}

function actor(req: Request): string {
  const value = resLocalsActor(req);
  if (!value) throw new LocationStorageUnavailableError();
  return value;
}
function resLocalsActor(req: Request): string | undefined { return (req.res?.locals as { locationActor?: string } | undefined)?.locationActor; }

async function requireDraft(repository: LocationDraftRepository, creatorId: string, id: string) {
  if (!UUID_RE.test(id)) throw new LocationDraftNotFoundError();
  const draft = await repository.getDraft(creatorId, id);
  if (!draft) throw new LocationDraftNotFoundError();
  return draft;
}

function strictRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Request body must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('Request contains an unknown field.');
  return input;
}

function authoredDocument(value: unknown, draft: { document: LocationDocument; locationId: string }): LocationDocument {
  const input = strictRecord(value, DOC_KEYS);
  if (!['name', 'building', 'widthCm', 'heightCm', 'outline', 'zones', 'tables', 'sensorAssignments'].every((key) => Object.hasOwn(input, key))) {
    throw new TypeError('The authored location document is incomplete.');
  }
  return parseLocationDocument({
    schemaVersion: 1, locationId: draft.locationId, visibility: draft.document.visibility,
    ...input,
  });
}

function parseProposedSensors(value: unknown, document: LocationDocument): LocationSensorAssignment[] {
  if (!Array.isArray(value)) throw new TypeError('Proposed sensors must be an array.');
  const proposed = value.map((raw) => {
    const input = strictRecord(raw, ['uid', 'pose']);
    return { uid: input.uid, pose: input.pose, owns: [] };
  });
  return parseLocationDocument({ ...document, sensorAssignments: proposed }).sensorAssignments;
}

function parseIfMatch(value: string | undefined): number {
  if (!value || !/^(?:"?)([1-9][0-9]*)(?:"?)$/.test(value)) throw new TypeError('If-Match must contain the expected draft revision.');
  const match = /^(?:"?)([1-9][0-9]*)(?:"?)$/.exec(value);
  const revision = Number(match?.[1]);
  if (!Number.isSafeInteger(revision)) throw new TypeError('If-Match draft revision is invalid.');
  return revision;
}

function draftSummary(draft: LocationDraft) {
  return {
    draftId: draft.draftId, locationId: draft.locationId,
    name: draft.document.name, building: draft.document.building, visibility: draft.document.visibility,
    draftRevision: draft.draftRevision, basePublishedRevision: draft.basePublishedRevision, updatedAt: draft.updatedAt,
  };
}

async function draftWriteDto(
  draft: LocationDraft,
  durability: 'confirmed' | 'unconfirmed',
  dependencies: LocationRouterDependencies,
) {
  const base = await pinnedBase(draft, dependencies);
  const candidate = revalidateLocationCandidate(draft.document, draft.legacySpatial, base, draft.basePublishedRevision);
  return {
    draftId: draft.draftId, locationId: draft.locationId,
    draftRevision: draft.draftRevision, basePublishedRevision: draft.basePublishedRevision,
    visibility: draft.document.visibility,
    durability,
    document: exposeAuthoredLocationCandidate(candidate.document, candidate.legacySpatial),
    legacyBaseAvailable: draft.basePublishedRevision === null || base !== null,
  };
}

async function draftDetailDto(draft: LocationDraft, dependencies: LocationRouterDependencies) {
  const write = await draftWriteDto(draft, 'confirmed', dependencies);
  const capabilities: Partial<Record<LocationAssetSlot, { source: 'upload' | 'legacy-static'; previewAvailable: boolean; alignmentEditable: boolean; replaceWithUpload: boolean }>> = {};
  const refs = [
    ['planAssetId', draft.document.planAssetId], ['modelAssetId', draft.document.modelAssetId],
  ] as const;
  for (const [slot, assetId] of refs) {
    if (!assetId) continue;
    const provenance = draft.assetProvenance?.[slot];
    if (!provenance) throw new InvalidLocationAssetReferenceError();
    if (provenance.kind === 'legacy-static') {
      capabilities[slot] = { source: 'legacy-static', previewAvailable: false, alignmentEditable: false, replaceWithUpload: true };
      continue;
    }
    const metadata = await dependencies.assetMetadata.getAssetMetadata(provenance.ownerId, assetId);
    const purpose = slot === 'planAssetId' ? 'floor-plan' : 'model';
    capabilities[slot] = {
      source: 'upload', previewAvailable: !!metadata && metadata.purpose === purpose,
      alignmentEditable: slot === 'modelAssetId', replaceWithUpload: true,
    };
  }
  return {
    ...write, updatedAt: draft.updatedAt,
    assetCapabilities: capabilities,
  };
}

async function pinnedBase(draft: LocationDraft, dependencies: LocationRouterDependencies) {
  if (draft.basePublishedRevision === null) return null;
  const state = await dependencies.published.getActive(draft.locationId);
  const base = state?.history.find((revision) => revision.revision === draft.basePublishedRevision) ?? null;
  if (!base) throw new LocationConflictError('The pinned base location revision is unavailable.');
  return base;
}

function send(res: Response, status: number, data: unknown): Response { return res.status(status).json({ data, error: null }); }
function fail(res: Response, status: number, code: string, message: string): Response { return res.status(status).json({ data: null, error: { code, message } }); }

function handleError(res: Response, error: unknown): Response {
  if (error && typeof error === 'object' && 'status' in error && (error as { status?: unknown }).status === 413) {
    return fail(res, 413, 'TOO_LARGE', 'The request exceeds the allowed size.');
  }
  if (error instanceof SyntaxError) return fail(res, 400, 'INVALID_JSON', 'The request body is malformed.');
  if (error instanceof LocationConflictError) return fail(res, 409, 'CONFLICT', error.message);
  if (error instanceof LocationDraftNotFoundError) return fail(res, 404, 'NOT_FOUND', 'Location draft was not found.');
  if (error instanceof UnknownRegistryCommitOutcomeError) return fail(res, 503, 'COMMIT_OUTCOME_UNKNOWN', 'Publication outcome is unknown; reload after registry recovery.');
  if (error instanceof PublishedModelDistributionUnavailableError || error instanceof PublishedModelDistributionFailedError) return fail(res, 503, 'MODEL_DISTRIBUTION_FAILED', 'The model was not acknowledged by every student site; the location was not published.');
  if (error instanceof LocationStorageUnavailableError) return fail(res, 503, 'STORAGE_UNAVAILABLE', 'Location storage is unavailable.');
  if (error instanceof InvalidLocationAssetReferenceError) return fail(res, 404, 'ASSET_NOT_FOUND', 'The referenced asset is not available.');
  if (error instanceof InvalidLocationDocumentError || error instanceof TypeError || error instanceof RangeError) return fail(res, 422, 'VALIDATION', 'The location request is invalid.');
  return fail(res, 500, 'INTERNAL', 'Location request could not be completed.');
}
