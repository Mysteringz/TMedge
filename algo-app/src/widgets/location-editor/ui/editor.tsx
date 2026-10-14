import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getEligibleDraftSensors, getLocationDraft, LocationApiError, publishLocationDraft, readDraftPlan, saveLocationDraft, uploadDraftModel, uploadFloorPlan } from '../../../entities/location-config/api/index.ts';
import type { DraftDetail, LocationDocument, Point, Table, TableShape } from '../../../entities/location-config/model/types.ts';
import { navigate } from '../../../console/router.ts';
import { addDefaultZone, cmToMetres, createTable, generateTableSeats, metresToCm, modelSceneFromDocument, moveShape, newStableId, sameJson, setShape, shapeOf, validateEditorDocument, type EditorValidationIssue, type ModelSceneDocument } from '../../../features/location-editor/index.ts';
import { canSelectGeneratedRoom, locationRoomSource, requiresModelClearConfirmation, selectGeneratedRoom, selectTwoDimensional } from '../../../features/location-room-source/index.ts';
import { EditorCanvas, type DragStart, type Drawing, type Selection } from './editor-canvas.tsx';
import { EditorInspector } from './editor-inspector.tsx';
import { SensorPlacementStep } from './sensor-placement-step.tsx';
import { SensorCoverageSummary } from './sensor-coverage-summary.tsx';
import { ModelAlignmentStep, ModelReviewSummary, type ModelUploadOutcome } from './model-alignment-step.tsx';
import { ModelPreview } from './model-preview.tsx';
import { SIMPLE_ROOM_TABLE_HEIGHT_M, SIMPLE_ROOM_WALL_HEIGHT_M } from '../../../../../src/shared/simple-room-geometry.ts';
import './location-editor.css';

type Step = 'details' | 'sensors' | 'model' | 'review';

/** Render one private draft step; the parent route supplies `draftId` and owns step navigation through `onStep`. */
export function LocationEditor({ draftId, step, onStep }: { draftId: string; step: Step; onStep(step: Step): void }) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [document, setDocument] = useState<LocationDocument | null>(null);
  const [baseDocument, setBaseDocument] = useState<LocationDocument | null>(null);
  const [savedDocument, setSavedDocument] = useState<LocationDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [modelPreflightBlocked, setModelPreflightBlocked] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [planUrl, setPlanUrl] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<{ file: File; url: string; appliedAssetId?: string } | null>(null);
  const [planPreviewFailed, setPlanPreviewFailed] = useState(false);
  const [planRetry, setPlanRetry] = useState(0);
  const [planFileName, setPlanFileName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [transientInputs, setTransientInputs] = useState<Record<string, boolean>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const [sensorLabels, setSensorLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  const drag = useRef<DragStart | null>(null);
  const drawingOrigin = useRef<string | null>(null);
  const sensorLabelRequestId = useRef(0);
  const wizard = useRef<HTMLElement>(null);
  useEffect(() => {
    const url = pendingPlan?.url;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [pendingPlan?.url]);

  const load = async (preserveLocal = false): Promise<boolean> => {
    setLoading(true); setProblem('');
    try {
      const result = await getLocationDraft(draftId);
      setDraft(result);
      const remote = structuredClone(result.document);
      const labelRequest = ++sensorLabelRequestId.current;
      setSensorLabels(new Map());
      if (remote.sensorAssignments.length) {
        void getEligibleDraftSensors(result.draftId).then((response) => {
          if (sensorLabelRequestId.current === labelRequest) setSensorLabels(new Map(response.sensors.map((sensor) => [sensor.uid.toLowerCase(), sensor.label])));
        }).catch(() => {});
      }
      setBaseDocument(remote);
      setSavedDocument(remote);
      setDocument(result.basePublishedRevision === null ? addDefaultZone(remote) : remote);
      setPendingPlan((current) => current?.appliedAssetId && current.appliedAssetId === remote.planAssetId ? null : current);
      setConflict(false); setMustReload(result.durability === 'unconfirmed');
      if (!preserveLocal) setMessage(result.durability === 'unconfirmed' ? 'Draft update was applied, but storage durability could not be confirmed. Reload before more edits.' : '');
      return true;
    } catch (cause) { setProblem(messageFor(cause, 'Location draft could not be loaded.')); }
    finally { setLoading(false); }
    return false;
  };
  useEffect(() => { void load(); }, [draftId]);
  useEffect(() => {
    if (!loading) wizard.current?.querySelector<HTMLElement>('[data-location-step-heading]')?.focus();
  }, [step, loading]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const planId = draft?.document.planAssetId;
    const allowed = draft?.assetCapabilities?.planAssetId?.previewAvailable;
    setPlanUrl(null);
    setPlanPreviewFailed(false);
    if (draft && planId && allowed) {
      void readDraftPlan(draft.draftId, planId).then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob); setPlanUrl(objectUrl);
      }).catch(() => { if (active) { setPlanPreviewFailed(true); setMessage('The saved plan preview is unavailable. Its reference remains on the draft.'); } });
    }
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [draft?.draftId, draft?.document.planAssetId, draft?.assetCapabilities?.planAssetId?.previewAvailable, planRetry]);

  const dirty = !!document && !!savedDocument && !sameJson(document, savedDocument);
  const errors = useMemo(() => document ? validateEditorDocument(document, baseDocument) : [], [document, baseDocument]);
  const modelCapability = draft?.assetCapabilities?.modelAssetId;
  const source = document ? locationRoomSource(document, modelCapability) : '2d';
  const candidateScene = useMemo(() => {
    if (!document) return null;
    try { return modelSceneFromDocument(document, modelCapability, sensorLabels); }
    catch { return null; }
  }, [document, modelCapability, sensorLabels]);
  const generatedEligible = document ? canSelectGeneratedRoom(document) : false;
  const hasTransientInvalid = Object.values(transientInputs).some(Boolean);
  const previewInvalid = errors.length > 0 || hasTransientInvalid || !candidateScene || (source === 'generated' && !generatedEligible);
  const [lastValidScene, setLastValidScene] = useState<ModelSceneDocument | null>(null);
  useEffect(() => {
    if (!previewInvalid && candidateScene) setLastValidScene(candidateScene);
  }, [previewInvalid, candidateScene]);
  const currentScene = previewInvalid ? lastValidScene ?? candidateScene : candidateScene;
  const displayScene: ModelSceneDocument = currentScene
    ? { ...currentScene, source }
    : { source, widthM: Math.max(0.1, (document?.widthCm ?? 1000) / 100), heightM: Math.max(0.1, (document?.heightCm ?? 1000) / 100), wallHeightM: SIMPLE_ROOM_WALL_HEIGHT_M, tableHeightM: SIMPLE_ROOM_TABLE_HEIGHT_M, tables: [], sensors: [] };
  const previewStale = previewInvalid && !!currentScene;
  const previewHasError = !candidateScene;
  useEffect(() => {
    const fields = [...(wizard.current?.querySelectorAll<HTMLElement>('[data-location-field]') ?? [])];
    for (const field of fields) {
      const descriptions = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && !id.startsWith('loc-validation-'));
      if (descriptions.length) field.setAttribute('aria-describedby', descriptions.join(' '));
      else field.removeAttribute('aria-describedby');
      if (field.dataset.locationInvalid === 'true' && field.dataset.localInvalid !== 'true') field.removeAttribute('aria-invalid');
      delete field.dataset.locationInvalid;
    }
    errors.forEach((issue, index) => {
      for (const field of fields.filter((item) => item.dataset.locationField === issue.field)) {
        field.setAttribute('aria-invalid', 'true');
        field.dataset.locationInvalid = 'true';
        const descriptions = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        field.setAttribute('aria-describedby', [...descriptions, `loc-validation-${index}`].join(' '));
      }
    });
  }, [errors, step, loading, selection]);

  const save = async (transactionOwnsBusy = false): Promise<DraftDetail | null> => {
    if (!draft || !document || mustReload) return null;
    if (modelPreflightBlocked && !transactionOwnsBusy) {
      setProblem('Retry or clear the selected GLB before saving this draft.');
      return null;
    }
    const invalidRaw = wizard.current?.querySelector<HTMLElement>('[data-local-invalid="true"]');
    if (invalidRaw) {
      setProblem('Correct the highlighted field before saving.');
      invalidRaw.focus();
      return null;
    }
    const validation = validateEditorDocument(document, baseDocument);
    if (validation.length) {
      const first = validation[0] ?? { field: 'floor.width', message: 'Review the geometry.' };
      setProblem(first.message); setAnnouncement(first.message);
      const targetSelection = selectionForField(first.field, document);
      if (targetSelection) setSelection(targetSelection);
      if (step !== 'details') onStep('details');
      requestAnimationFrame(() => requestAnimationFrame(() => focusInvalidField(first, wizard.current)));
      return null;
    }
    if (!transactionOwnsBusy) setBusy('save'); setProblem(''); setConflict(false);
    try {
      const written = await saveLocationDraft(draft, document);
      const appliedDocument = structuredClone(written.document);
      const preservedCapabilities = {
        ...(draft.assetCapabilities?.planAssetId && appliedDocument.planAssetId === draft.document.planAssetId
          ? { planAssetId: draft.assetCapabilities.planAssetId } : {}),
        ...(draft.assetCapabilities?.modelAssetId && appliedDocument.modelAssetId === draft.document.modelAssetId
          ? { modelAssetId: draft.assetCapabilities.modelAssetId } : {}),
      };
      if (written.durability === 'unconfirmed') {
        const applied: DraftDetail = { ...draft, ...written, document: appliedDocument, assetCapabilities: preservedCapabilities };
        setDraft(applied); setDocument(appliedDocument); setSavedDocument(structuredClone(appliedDocument)); setBaseDocument(structuredClone(appliedDocument));
        setMustReload(true);
        setMessage(`Draft revision ${written.draftRevision} was applied, but storage durability could not be confirmed. Reload latest before continuing.`);
        return applied;
      }
      try {
        const authoritative = await getLocationDraft(draft.draftId);
        setDraft(authoritative); setDocument(structuredClone(authoritative.document)); setSavedDocument(structuredClone(authoritative.document)); setBaseDocument(structuredClone(authoritative.document));
        setMustReload(authoritative.durability === 'unconfirmed');
        setMessage(authoritative.durability === 'unconfirmed' ? 'Draft save was applied, but storage durability could not be confirmed. Reload latest before continuing.' : 'Draft saved · private');
        return authoritative;
      } catch {
        const applied: DraftDetail = { ...draft, ...written, document: appliedDocument, assetCapabilities: preservedCapabilities };
        setDraft(applied); setDocument(appliedDocument); setSavedDocument(structuredClone(appliedDocument)); setBaseDocument(structuredClone(appliedDocument));
        setMustReload(true); setMessage('');
        setProblem(`Draft revision ${written.draftRevision} was saved, but safe asset details could not be reloaded. Your saved revision is retained; reload before further changes.`);
        return null;
      }
    } catch (cause) {
      if (cause instanceof LocationApiError && cause.status === 409) { setConflict(true); setProblem('This draft changed elsewhere. Your local edits are still here. Reload latest or keep a copy before comparing.'); }
      else setProblem(messageFor(cause, 'Draft could not be saved. Your edits are still here.'));
      return null;
    } finally { if (!transactionOwnsBusy) setBusy(''); }
  };

  const uploadPlan = async (file: File) => {
    if (!draft || !document) return;
    if (mustReload) { setProblem('Reload the latest saved draft before uploading a plan.'); return; }
    setBusy('upload'); setProblem('');
    let savedBeforeUpload: DraftDetail | null = null;
    try {
      const ready = dirty ? await save(true) : draft;
      if (!ready) return;
      if (dirty && ready.draftRevision > draft.draftRevision) savedBeforeUpload = ready;
      if (ready.durability === 'unconfirmed') { setProblem('Draft save was applied, but storage durability could not be confirmed. Reload before uploading.'); setMustReload(true); return; }
      const invalidRaw = wizard.current?.querySelector<HTMLElement>('[data-local-invalid="true"]');
      if (invalidRaw) { setProblem('Correct the highlighted field before uploading the plan.'); invalidRaw.focus(); return; }
      if (validateEditorDocument(document, baseDocument).length) return;
      const uploaded = await uploadFloorPlan(ready, file);
      const appliedDocument = { ...ready.document, planAssetId: uploaded.assetId };
      const appliedDraft: DraftDetail = {
        ...ready, draftRevision: uploaded.draftRevision, durability: uploaded.durability, document: appliedDocument,
      };
      setDraft(appliedDraft);
      setDocument(structuredClone(appliedDocument));
      setSavedDocument(structuredClone(appliedDocument));
      setBaseDocument(structuredClone(appliedDocument));
      setPendingPlan((current) => current ? { ...current, appliedAssetId: uploaded.assetId } : current);
      setPlanFileName(file.name);
      if (uploaded.durability === 'unconfirmed') {
        setMustReload(true);
        setProblem(`Floor plan attachment was applied to draft revision ${uploaded.draftRevision}, but storage durability could not be confirmed. Your selected image is retained. Reload latest before further changes.`);
        setAnnouncement(`Floor plan attachment applied to draft revision ${uploaded.draftRevision}. Reload latest before continuing.`);
        return;
      }
      const loaded = await load();
      if (!loaded) {
        setMustReload(true);
        setProblem(`Floor plan attachment was saved to draft revision ${uploaded.draftRevision}, but latest draft details could not be reloaded. Your selected image is retained. Retry reload before further changes.`);
        return;
      }
      setMessage('Floor plan saved to this private draft.');
    } catch (cause) {
      if (cause instanceof LocationApiError && cause.status === 409) {
        setConflict(true);
        setProblem(savedBeforeUpload
          ? `Draft revision ${savedBeforeUpload.draftRevision} was saved privately, but the plan upload conflicted. Your selected image preview is retained. Reload latest before retrying.`
          : 'This draft changed before the plan upload completed. Your selected image preview is retained. Reload latest before retrying.');
      } else {
        setProblem(savedBeforeUpload
          ? `Draft revision ${savedBeforeUpload.draftRevision} was saved privately. The plan upload failed; your selected image preview is retained for retry.`
          : 'The plan upload failed. The saved draft is unchanged, and your selected image preview is retained for retry.');
      }
    }
    finally { setBusy(''); }
  };

  const uploadModel = async (file: File): Promise<ModelUploadOutcome | null> => {
    if (!draft || !document) return null;
    if (mustReload) { setProblem('Reload the latest saved draft before uploading a model.'); return null; }
    setBusy('model-upload'); setProblem('');
    let savedBeforeUpload: DraftDetail | null = null;
    try {
      const ready = dirty ? await save(true) : draft;
      if (!ready) return null;
      if (dirty && ready.draftRevision > draft.draftRevision) savedBeforeUpload = ready;
      if (ready.durability === 'unconfirmed') {
        setMustReload(true);
        setProblem('Draft save was applied, but storage durability could not be confirmed. Reload before uploading a model.');
        return null;
      }
      const result = await uploadDraftModel(ready, file);
      const appliedDocument: LocationDocument = {
        ...ready.document,
        modelAssetId: result.assetId,
        modelTransform: ready.document.modelTransform ?? defaultModelTransform(),
      };
      delete appliedDocument.proceduralRoom;
      const appliedDraft: DraftDetail = {
        ...ready,
        draftRevision: result.draftRevision,
        durability: result.durability,
        document: appliedDocument,
        assetCapabilities: {
          ...ready.assetCapabilities,
          modelAssetId: {
            source: 'upload', previewAvailable: true, alignmentEditable: true,
            replaceWithUpload: true, fromPublishedBase: false,
            ...(result.displayName ? { displayName: result.displayName } : {}),
          },
        },
      };
      setDraft(appliedDraft);
      setDocument(structuredClone(appliedDocument));
      setSavedDocument(structuredClone(appliedDocument));
      setBaseDocument(structuredClone(appliedDocument));
      if (result.durability === 'unconfirmed') {
        setMustReload(true);
        setProblem(`GLB attachment was applied to draft revision ${result.draftRevision}, but storage durability could not be confirmed. The selected file and preview are retained. Reload latest before further changes.`);
        return { assetId: result.assetId, draftRevision: result.draftRevision, durability: result.durability, displayName: result.displayName, reloaded: false };
      }
      const loaded = await load();
      if (!loaded) {
        setMustReload(true);
        setProblem(`GLB attachment was saved to draft revision ${result.draftRevision}, but draft details could not be reloaded. The selected file and preview are retained. Retry reload before further changes.`);
        return { assetId: result.assetId, draftRevision: result.draftRevision, durability: result.durability, displayName: result.displayName, reloaded: false };
      }
      setMessage('GLB attached to this private draft. The previously published source remains active until publication.');
      return { assetId: result.assetId, draftRevision: result.draftRevision, durability: result.durability, displayName: result.displayName, reloaded: true };
    } catch (cause) {
      if (cause instanceof LocationApiError && cause.status === 409) {
        setConflict(true);
        setProblem(savedBeforeUpload
          ? `Draft revision ${savedBeforeUpload.draftRevision} was saved privately, but the GLB upload conflicted. The selected file and prior model are retained. Reload latest before retrying.`
          : 'This draft changed before the GLB upload completed. The selected file and prior model are retained. Reload latest before retrying.');
      } else {
        setProblem(savedBeforeUpload
          ? `Draft revision ${savedBeforeUpload.draftRevision} was saved privately. The GLB upload failed; the prior model is retained and the selected file can be retried.`
          : 'The GLB upload failed. The prior model is retained and the selected file can be retried.');
      }
      return null;
    } finally { setBusy(''); }
  };

  const publish = async () => {
    if (!draft) return;
    if (modelPreflightBlocked) { setProblem('Retry or clear the selected GLB before publishing this draft.'); return; }
    if (mustReload) { setProblem('Reload the latest saved draft before publishing.'); return; }
    setBusy('publish'); setProblem('');
    try {
      let current = draft;
      if (dirty) {
        const saved = await save(true);
        if (!saved) return;
        current = saved;
        if (saved.durability === 'unconfirmed') {
          setMustReload(true);
          setProblem('Draft save was applied, but storage durability could not be confirmed. Reload before publishing.');
          return;
        }
      }
      if (mustReload) { setProblem('Reload the latest saved draft before publishing.'); return; }
      const result = await publishLocationDraft(current);
      if (result.durability === 'unconfirmed') {
        setMustReload(true);
        setProblem(`Publication of revision ${result.publishedRevision} was applied, but storage durability could not be confirmed. Reload before continuing.`);
      } else {
        setMessage(`Published revision ${result.publishedRevision}.`);
        navigate('/locations');
      }
    } catch (cause) {
      if (cause instanceof LocationApiError && cause.status === 409) { setConflict(true); setProblem('The active location changed. Reload latest before trying to publish.'); }
      else setProblem(messageFor(cause, 'Location could not be published. The current published version remains active.'));
    } finally { setBusy(''); }
  };

  const changeStep = async (next: Step) => {
    if (modelPreflightBlocked && step !== next) {
      setProblem('Retry or clear the selected GLB before leaving the Room view step.');
      return;
    }
    if (step !== next && dirty) {
      const result = await save(); if (!result) return;
      if (result.durability === 'unconfirmed') return;
    }
    onStep(next);
  };

  const update = (change: (current: LocationDocument) => LocationDocument) => {
    setDocument((current) => current ? change(current) : current); setProblem('');
  };
  const reportTransientInput = (key: string, invalid: boolean) => setTransientInputs((current) => {
    if ((current[key] ?? false) === invalid) return current;
    return { ...current, [key]: invalid };
  });
  const clearModelCapability = () => setDraft((current) => {
    if (!current?.assetCapabilities) return current;
    const assetCapabilities = { ...current.assetCapabilities };
    delete assetCapabilities.modelAssetId;
    return { ...current, assetCapabilities };
  });
  const selectRoomSource = (nextSource: 'generated' | '2d') => {
    if (!document || !draft) return;
    if (nextSource === 'generated' && !canSelectGeneratedRoom(document)) {
      setProblem('Built-in room needs a floor outline that matches the rectangular floor dimensions. Edit the outline or choose another source.');
      return;
    }
    const nextDocument = nextSource === 'generated' ? selectGeneratedRoom(document) : selectTwoDimensional(document, modelCapability);
    if (!nextDocument) return;
    if (requiresModelClearConfirmation(document)) {
      const choice = nextSource === 'generated' ? 'Built-in room' : '2D only';
      const accepted = globalThis.confirm(`Switch this draft to ${choice}? This clears the active draft model reference and alignment. The published revision stays active, and its immutable asset and history are retained.`);
      if (!accepted) return;
    }
    setDocument(nextDocument);
    clearModelCapability();
    setProblem('');
    setMessage(`${nextSource === 'generated' ? 'Built-in room' : '2D floor view'} selected for this private draft. The published revision remains active until publication.`);
  };
  const focusCanvas = () => requestAnimationFrame(() => wizard.current?.querySelector<SVGSVGElement>('.loc-canvas')?.focus());
  const cancelDrawing = () => {
    if (!drawing) return;
    const origin = drawingOrigin.current;
    drawingOrigin.current = null;
    setDrawing(null);
    if (origin) requestAnimationFrame(() => wizard.current?.querySelector<HTMLButtonElement>(`#${origin}`)?.focus());
  };

  const editDimensions = (field: 'widthCm' | 'heightCm', metres: string) => {
    const value = metresToCm(Number(metres));
    if (!Number.isFinite(value) || value <= 0) return;
    update((current) => {
      const oldWidth = current.widthCm, oldHeight = current.heightCm;
      const oldOutline = structuredClone(current.outline);
      const followsRoom = sameJson(oldOutline, roomOutline(oldWidth, oldHeight));
      const newWidth = field === 'widthCm' ? value : oldWidth, newHeight = field === 'heightCm' ? value : oldHeight;
      const next = { ...current, [field]: value };
      if (followsRoom) next.outline = roomOutline(newWidth, newHeight);
      if (baseDocument?.zones.length === 0 && current.zones.length === 1 && current.zones[0]?.name === 'Main area' && sameJson(current.zones[0].polygon, oldOutline)) {
        next.zones = [{ ...current.zones[0], polygon: roomOutline(newWidth, newHeight) }];
      }
      return next;
    });
  };

  const addZone = () => {
    if (!document) return;
    if (!document.zones.length) {
      const next = addDefaultZone(document), zone = next.zones[0];
      update(() => next);
      if (zone) setSelection({ kind: 'zone', id: zone.id });
      return;
    }
    drawingOrigin.current = 'loc-add-zone';
    setDrawing({ kind: 'zone', points: [] }); setMessage('Draw the zone with the pointer, or use arrow keys to position the canvas cursor and Space to add vertices. Press Enter to finish or Escape to cancel.'); focusCanvas();
  };
  const addTable = (kind: TableShape['type']) => {
    if (!document?.zones.length) { setProblem('Add a named zone before placing tables.'); return; }
    if (kind === 'polygon') { drawingOrigin.current = 'loc-add-polygon-table'; setDrawing({ kind: 'polygon-table', points: [] }); setMessage('Draw the table with the pointer, or use arrow keys to position the canvas cursor and Space to add vertices. Press Enter to finish or Escape to cancel.'); focusCanvas(); return; }
    const table = createTable(document, kind);
    if (table) { update((current) => ({ ...current, tables: [...current.tables, table] })); setSelection({ kind: 'table', id: table.id }); }
  };
  const finishDrawing = () => {
    if (!drawing || !document) return;
    if (drawing.points.length < 3) { setProblem('A polygon needs at least three vertices.'); return; }
    if (drawing.kind === 'zone') {
      const zone = { id: newStableId('ZONE'), name: `Zone ${document.zones.length + 1}`, polygon: drawing.points };
      update((current) => ({ ...current, zones: [...current.zones, zone] })); setSelection({ kind: 'zone', id: zone.id });
    } else {
      const zone = document.zones[0]; if (!zone) return;
      const id = newStableId('TABLE');
      const table = generateTableSeats({ id, name: `Table ${document.tables.length + 1}`, zoneId: zone.id, capacity: 4, shape: { type: 'polygon', points: drawing.points }, seats: [] });
      update((current) => ({ ...current, tables: [...current.tables, table] })); setSelection({ kind: 'table', id });
    }
    drawingOrigin.current = null;
    setDrawing(null); setMessage('Polygon added. Edit its name and coordinates in the inspector.');
  };

  const dragTo = (point: Point) => {
    const started = drag.current; if (!started) return;
    const dx = point[0] - started.x, dy = point[1] - started.y;
    setDocument((current) => current ? applyDrag(started.document, started, point, dx, dy) : current);
  };
  const nudge = (dx: number, dy: number) => {
    if (!document || !selection) return;
    let spoken = `Selected ${selection.kind} moved ${dx} centimetres horizontally and ${dy} centimetres vertically.`;
    if (selection.kind === 'zone' && selection.index !== undefined) {
      const zone = document.zones.find((item) => item.id === selection.id);
      const point = zone?.polygon[selection.index];
      if (point) spoken = `Zone vertex ${selection.index + 1} moved to ${cmToMetres(point[0] + dx)} metres X and ${cmToMetres(point[1] + dy)} metres Y.`;
    }
    update((current) => {
      if (selection.kind === 'zone' && selection.index !== undefined) return replaceZonePoint(current, selection.id, selection.index, (point) => [point[0] + dx, point[1] + dy]);
      if (selection.kind === 'seat') return mapSeat(current, selection.id, (seat) => ({ ...seat, x: seat.x + dx, y: seat.y + dy }));
      const table = current.tables.find((item) => item.id === selection.id); if (!table) return current;
      return moveTable(current, table, dx, dy);
    });
    setAnnouncement(spoken);
  };

  if (loading) return <main className="cx-train loc-page" aria-busy="true" role="status">Loading location draft…</main>;
  if (!draft || !document) return <main className="cx-train loc-page"><p className="loc-alert" role="alert">{problem || 'Location draft is unavailable.'}</p>
    <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" data-testid="location-load-retry" disabled={loading} onClick={() => void load()}>Retry</button><button type="button" className="btn btn-ghost" data-testid="location-load-back" onClick={() => navigate('/locations')}>Back to locations</button></div>
  </main>;

  const stepItems: Array<{ id: Step; label: string }> = [
    { id: 'details', label: 'Details & layout' }, { id: 'sensors', label: 'Sensors' }, { id: 'model', label: 'Room view' }, { id: 'review', label: 'Review' },
  ];
  return <main className="cx-train loc-page" ref={wizard}>
    <header className="cx-train-head loc-editor-head">
      <div><p className="cx-kicker">{draft.basePublishedRevision === null ? 'New location' : `Editing revision ${draft.basePublishedRevision}`}</p><h1 className="cx-h2" tabIndex={-1} data-location-step-heading>{document.name || 'Location draft'}</h1>
        <p className="cx-muted">{draft.visibility === 'public' ? 'Public · student-visible' : 'Console-only · not shown to students'} · Visibility is read-only</p></div>
      <button type="button" className="btn btn-secondary" data-testid="location-editor-back" disabled={busy !== '' || modelPreflightBlocked} onClick={() => navigate('/locations')}>Back to locations</button>
    </header>
    <nav className="loc-steps" aria-label="Location wizard steps">
      {stepItems.map((item, index) => <button type="button" key={item.id} data-testid={`location-step-${item.id}`} disabled={busy !== '' || modelPreflightBlocked} className={`loc-step ${step === item.id ? 'is-current' : ''}`} aria-current={step === item.id ? 'step' : undefined}
        onClick={() => void changeStep(item.id)}><span className="loc-step-number">{index + 1}</span><span>{item.label}<small className="loc-step-state">{item.id === step ? 'Current step' : item.id === 'details' ? dirty ? 'Unsaved changes' : 'Saved draft' : item.id === 'review' ? 'Final check' : 'Not started'}</small></span></button>)}
    </nav>
    {problem && <div className="loc-alert" role="alert"><p>{problem}</p>
      {conflict && <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" data-testid="location-reload-conflict" onClick={() => void load()}>Reload latest</button>
        <button type="button" className="btn btn-ghost" data-testid="location-copy-conflict" onClick={() => void copyLocal(document)}>Keep my edits / copy changes</button></div>}
      {mustReload && <button type="button" className="btn btn-secondary" data-testid="location-reload-latest" onClick={() => void load()}>Reload latest</button>}
    </div>}
    {message && <p className="loc-status" role="status" aria-live="polite">{message}</p>}

    <div className={`loc-step-layout is-${step}`}>
    <div className="loc-step-main">
    {step === 'details' ? <fieldset className="loc-editor-fieldset" disabled={busy !== '' || mustReload} inert={busy !== '' || mustReload} aria-busy={busy !== ''}>
      <div className="loc-metadata card">
        <Field label="Location name" value={document.name} onChange={(name) => update((current) => ({ ...current, name }))} />
        <Field label="Building" value={document.building} onChange={(building) => update((current) => ({ ...current, building }))} />
        <Field label="Floor width (m)" fieldPath="floor.width" type="number" min={1} max={1000} step={0.01} value={String(cmToMetres(document.widthCm))} onChange={(value) => editDimensions('widthCm', value)} onTransientInvalid={(invalid) => reportTransientInput('floor.width', invalid)} />
        <Field label="Floor height (m)" fieldPath="floor.height" type="number" min={1} max={1000} step={0.01} value={String(cmToMetres(document.heightCm))} onChange={(value) => editDimensions('heightCm', value)} onTransientInvalid={(invalid) => reportTransientInput('floor.height', invalid)} />
        <p className="loc-visibility"><b>Visibility · read-only</b><span>{draft.basePublishedRevision === null ? 'Public · server default' : draft.visibility === 'public' ? 'Public · student-visible' : 'Console-only · not shown to students'}</span></p>
      </div>
      <section className="loc-plan-section card" aria-labelledby="loc-plan-title">
        <div><h2 id="loc-plan-title">Floor plan</h2><p className="cx-muted">Blank canvas or a private PNG/JPEG background. Plan images are not shown to students.</p></div>
        {document.planAssetId || pendingPlan ? <div className="loc-plan-state">
          {pendingPlan ? <img src={pendingPlan.url} alt="Selected floor plan preview; not uploaded" />
            : planUrl ? <img src={planUrl} alt="Private floor plan background preview" />
              : planPreviewFailed ? <p role="status">The saved plan preview is unavailable; its reference is preserved. <button type="button" className="btn btn-ghost" data-testid="location-plan-preview-retry" onClick={() => setPlanRetry((value) => value + 1)}>Retry preview</button></p>
                : <p role="status">{draft.assetCapabilities?.planAssetId?.previewAvailable ? 'Loading private floor plan…' : 'The saved plan preview is unavailable; its reference is preserved.'}</p>}
          <span className="cx-muted">{pendingPlan ? `${pendingPlan.file.name} · selected, not uploaded` : planFileName || 'Saved private plan image'}</span>
          {pendingPlan && <button type="button" className="btn btn-secondary" data-testid="location-plan-upload-retry" disabled={busy !== '' || conflict || mustReload} onClick={() => void uploadPlan(pendingPlan.file)}>Retry plan upload</button>}
          <button type="button" className="btn btn-ghost" data-testid="location-plan-use-blank" onClick={() => { setPendingPlan(null); setPlanFileName(''); update((current) => { const next = { ...current }; delete next.planAssetId; return next; }); }}>Use blank canvas</button>
        </div> : <p className="cx-muted">Blank canvas selected.</p>}
        <label className="loc-upload"><span>{document.planAssetId ? 'Replace plan (PNG or JPEG)' : 'Upload floor plan (PNG or JPEG)'}</span>
          <input type="file" accept="image/png,image/jpeg" aria-label="Upload floor plan (PNG or JPEG)" data-testid="location-plan-upload" disabled={busy !== '' || mustReload} onChange={(event) => { const file = event.target.files?.[0]; if (file) { setPendingPlan({ file, url: URL.createObjectURL(file) }); setPlanFileName(file.name); void uploadPlan(file); } event.currentTarget.value = ''; }} />
        </label>
      </section>
      <div className="loc-editor-toolbar" aria-label="Layout tools">
      <button type="button" className="btn btn-secondary" data-testid="location-tool-add-zone" data-location-tool id="loc-add-zone" onClick={addZone}>Add zone</button>
        <button type="button" className="btn btn-secondary" data-testid="location-tool-add-rectangle" onClick={() => addTable('rect')}>Add rectangle table</button>
        <button type="button" className="btn btn-secondary" data-testid="location-tool-add-circle" onClick={() => addTable('circle')}>Add round table</button>
        <button type="button" className="btn btn-secondary" data-testid="location-tool-add-polygon-table" data-location-tool id="loc-add-polygon-table" onClick={() => addTable('polygon')}>Draw polygon table</button>
        {drawing && <><button type="button" className="btn btn-primary" data-testid="location-tool-finish-polygon" onClick={finishDrawing}>Finish polygon</button><button type="button" className="btn btn-ghost" data-testid="location-tool-cancel-sketch" onClick={cancelDrawing}>Cancel sketch</button></>}
      </div>
      <div className="loc-editor-grid">
        <section className="loc-canvas-panel card" aria-label="Floor plan canvas">
          <EditorCanvas document={document} selected={selection} drawing={drawing} planUrl={planUrl} onSelect={setSelection}
            onSketchPoint={(point) => setDrawing((current) => current ? { ...current, points: [...current.points, point] } : current)}
            onDragStart={(value) => { drag.current = value; }} onDragTo={dragTo} onDragEnd={() => { drag.current = null; }} onNudge={nudge}
            onFinishDrawing={finishDrawing} onCancelDrawing={cancelDrawing} />
          <p className="loc-canvas-live" aria-live="polite">{announcement}</p>
        </section>
        <EditorInspector document={document} selected={selection} onSelect={(value) => { setSelection(value); if (value.kind === 'zone' && value.index !== undefined) focusCanvas(); }} update={update} onTransientValidityChange={reportTransientInput} />
      </div>
      {!!errors.length && <div className="loc-validation" role="status" tabIndex={-1}><b>Review the layout</b><ul>{errors.map((item, index) => <li key={`${item.field}:${item.message}`} id={`loc-validation-${index}`}>{item.message}</li>)}</ul></div>}
      <footer className="loc-footer">
        <button type="button" className="btn btn-ghost" data-testid="location-details-back" onClick={() => navigate('/locations')}>Back</button>
        <span>{dirty ? 'Unsaved local changes' : `Draft revision ${draft.draftRevision} · private`}</span>
        <button type="button" className="btn btn-secondary" data-testid="location-save-draft" disabled={busy !== '' || mustReload} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
        <button type="button" className="btn btn-primary" data-testid="location-continue-sensors" disabled={busy !== '' || mustReload} onClick={() => void changeStep('sensors')}>Continue to sensors</button>
      </footer>
    </fieldset> : step === 'sensors' ? <SensorPlacementStep draft={draft} document={document} onUpdate={update} onSave={() => save()}
      onTransientValidityChange={(field, invalid) => reportTransientInput(field, invalid)}
      onSensorLabelsChange={(sensors) => setSensorLabels(new Map(sensors.map((sensor) => [sensor.uid.toLowerCase(), sensor.label])))}
      onBack={() => onStep('details')} onContinue={() => void changeStep('model')} busy={busy} mustReload={mustReload} />
      : step === 'model' ? <ModelAlignmentStep draft={draft} document={document} busy={busy} mustReload={mustReload} onUpdate={update}
        onSelectSource={selectRoomSource} onUpload={uploadModel} onSave={() => void save()} onBack={() => void changeStep('sensors')} onContinue={() => void changeStep('review')} onPreflightBlockedChange={setModelPreflightBlocked} />
        : <Review document={document} draft={draft} dirty={dirty} busy={busy} mustReload={mustReload} onEdit={() => onStep('details')} onEditCoverage={() => onStep('sensors')} onEditModel={() => onStep('model')} onSave={() => void save()} onPublish={() => void publish()} onBack={() => onStep('model')} />}
    </div>
    <aside className="loc-live-preview" aria-label="Live room preview" data-testid="location-room-live-preview">
      {(step === 'details' || step === 'sensors') && <button type="button" className="btn btn-secondary loc-live-preview-toggle" data-testid="location-room-live-preview-toggle"
        aria-expanded={previewExpanded} aria-controls="location-room-preview-panel" onClick={() => setPreviewExpanded((expanded) => !expanded)}>
        {previewExpanded ? 'Hide 3D preview' : 'Show 3D preview'}
      </button>}
      <div id="location-room-preview-panel" className={`loc-live-preview-panel ${(step === 'details' || step === 'sensors') && !previewExpanded ? 'is-collapsed' : ''}`}>
        <ModelPreview draft={draft} document={document} scene={displayScene} capability={modelCapability} retry={previewRetry} stale={previewStale}
          onRetry={() => setPreviewRetry((value) => value + 1)} />
      </div>
      {previewHasError && <p className="loc-alert" role="alert">The last valid room preview could not be built. Retry the preview or continue editing with the 2D tools.</p>}
    </aside>
    </div>
  </main>;
}

/** Private pre-publication summary; publishing is an explicit parent callback and never follows a save implicitly. */
function Review({ document, draft, dirty, busy, mustReload, onEdit, onEditCoverage, onEditModel, onSave, onPublish, onBack }: {
  document: LocationDocument; draft: DraftDetail; dirty: boolean; busy: string; mustReload: boolean;
  onEdit(): void; onEditCoverage(): void; onEditModel(): void; onSave(): void; onPublish(): void; onBack(): void;
}) {
  return <section className="loc-review">
    <div className="loc-review-header"><div><p className="cx-kicker">Final check</p><h2 tabIndex={-1} data-location-step-heading>Review location</h2></div><button className="btn btn-secondary" type="button" data-testid="location-review-edit-details" disabled={busy !== ''} onClick={onEdit}>Edit details & layout</button></div>
    <div className="card loc-review-card"><h3>{document.name}</h3><p>{document.building} · {cmToMetres(document.widthCm)} × {cmToMetres(document.heightCm)} m</p>
      <p><b>Visibility · read-only</b> · {draft.visibility === 'public' ? 'Public · student-visible' : 'Console-only · not shown to students'}</p>
      <p>Floor plan: {document.planAssetId ? 'Private plan image' : 'Blank canvas'}</p>
      <h3>Zones</h3><ul>{document.zones.map((zone) => <li key={zone.id}>{zone.name} · {zone.polygon.length} vertices</li>)}</ul>
      <h3>Tables and seats</h3>{document.tables.length ? <ul>{document.tables.map((table) => <li key={table.id}>{table.name} · {table.shape?.type ?? 'legacy rectangle'} · {table.capacity} seats</li>)}</ul> : <p>No tables yet.</p>}
    </div>
    <ModelReviewSummary draft={draft} document={document} onEdit={onEditModel} />
    <SensorCoverageSummary draft={draft} document={document} onEdit={onEditCoverage} />
    <p className="loc-review-note">{draft.visibility === 'public'
      ? 'This draft is private. Students continue to see the current published version until you publish these changes.'
      : 'This draft is private. Publishing applies the console configuration; this location remains hidden from students.'}</p>
    <footer className="loc-footer"><button type="button" className="btn btn-ghost" data-testid="location-review-back" disabled={busy !== ''} onClick={onBack}>Back</button><span>{dirty ? 'Unsaved local changes' : `Draft revision ${draft.draftRevision} · private`}</span>
      <button type="button" className="btn btn-secondary" data-testid="location-review-save-draft" disabled={busy !== '' || mustReload} onClick={onSave}>Save draft</button>
      <button type="button" className="btn btn-primary" data-testid="location-publish" disabled={busy !== '' || dirty || mustReload} onClick={onPublish}>{busy === 'publish' ? 'Publishing…' : 'Publish location'}</button>
    </footer>
  </section>;
}

/** Labeled editor input; numeric values keep a raw string until blur to preserve sequential keyboard entry. */
function Field({ label, value, onChange, type = 'text', min, max, step, fieldPath, onTransientInvalid }: {
  label: string; value: string; onChange(value: string): void; type?: string; min?: number; max?: number; step?: number; fieldPath?: string;
  onTransientInvalid?(invalid: boolean): void;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value);
  const [fieldError, setFieldError] = useState('');
  const deferredNumber = type === 'number';
  const transientCallback = useRef(onTransientInvalid);
  transientCallback.current = onTransientInvalid;
  useEffect(() => () => transientCallback.current?.(false), []);
  useEffect(() => {
    const input = globalThis.document.activeElement;
    if (input?.getAttribute('data-location-field') !== fieldPath) { setRaw(value); setFieldError(''); onTransientInvalid?.(false); }
  }, [value, fieldPath]);
  const rawValid = !deferredNumber || validNumberText(raw, min, max, step);
  return <label className="loc-field"><span>{label}</span><input className="input" aria-label={label} data-testid={`location-field-${testToken(fieldPath ?? label)}`} data-location-field={fieldPath}
    data-local-invalid={fieldError || !rawValid ? 'true' : undefined} aria-invalid={fieldError || !rawValid ? true : undefined} aria-describedby={fieldError ? id : undefined}
    value={raw} type={deferredNumber ? 'text' : type} inputMode={deferredNumber ? 'decimal' : undefined} min={deferredNumber ? undefined : min} max={deferredNumber ? undefined : max} step={deferredNumber ? undefined : step} onChange={(event) => {
      const text = event.target.value; setRaw(text); setFieldError('');
      if (!deferredNumber) { onChange(text); return; }
      const valid = validNumberText(text, min, max, step);
      onTransientInvalid?.(!valid);
      if (valid) onChange(text);
    }}
    onBlur={() => {
      if (!deferredNumber) return;
      if (!validNumberText(raw, min, max, step)) {
        setFieldError(min !== undefined && max !== undefined ? `Enter a number from ${min} to ${max}.` : 'Enter a valid number.');
        onTransientInvalid?.(true);
        return;
      }
      setFieldError(''); onTransientInvalid?.(false); onChange(raw);
    }} />{fieldError && <small className="loc-field-error" id={id} role="alert">{fieldError}</small>}</label>;
}

function validNumberText(text: string, min?: number, max?: number, step?: number): boolean {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return false;
  const parsed = Number(text);
  return Number.isFinite(parsed) && (min === undefined || parsed >= min) && (max === undefined || parsed <= max)
    && (step === undefined || min === undefined || Math.abs((parsed - min) / step - Math.round((parsed - min) / step)) <= 1e-7);
}

function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function applyDrag(start: LocationDocument, drag: DragStart, point: Point, dx: number, dy: number): LocationDocument {
  if (drag.kind === 'zone-vertex' && drag.index !== undefined) return replaceZonePoint(start, drag.id, drag.index, () => point);
  if (drag.kind === 'seat') return mapSeat(start, drag.id, (seat) => ({ ...seat, x: point[0], y: point[1] }));
  const table = start.tables.find((item) => item.id === drag.id); if (!table) return start;
  return moveTable(start, table, dx, dy);
}

function moveTable(document: LocationDocument, table: Table, dx: number, dy: number): LocationDocument {
  const oldShape = shapeOf(table), moved = moveShape(oldShape, dx, dy, document.widthCm, document.heightCm);
  const before = shapeBounds(oldShape), after = shapeBounds(moved), actualX = after.x - before.x, actualY = after.y - before.y;
  const next = setShape(table, moved);
  next.seats = table.seats.map((seat) => ({ ...seat, x: seat.x + actualX, y: seat.y + actualY }));
  return { ...document, tables: document.tables.map((item) => item.id === table.id ? next : item) };
}

function mapSeat(document: LocationDocument, id: string, change: (seat: Table['seats'][number]) => Table['seats'][number]): LocationDocument {
  return { ...document, tables: document.tables.map((table) => ({ ...table, seats: table.seats.map((seat) => seat.id === id ? change(seat) : seat) })) };
}

function replaceZonePoint(document: LocationDocument, id: string, index: number, change: (point: Point) => Point): LocationDocument {
  return { ...document, zones: document.zones.map((zone) => zone.id === id ? { ...zone, polygon: zone.polygon.map((point, i) => i === index ? change(point) : point) } : zone) };
}

function shapeBounds(shape: TableShape): { x: number; y: number; width: number; height: number } {
  if (shape.type === 'rect') return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.type === 'circle') return { x: shape.cx - shape.radius, y: shape.cy - shape.radius, width: shape.radius * 2, height: shape.radius * 2 };
  const xs = shape.points.map(([x]) => x), ys = shape.points.map(([, y]) => y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function roomOutline(width: number, height: number): Point[] { return [[0, 0], [width, 0], [width, height], [0, height]]; }
function defaultModelTransform(): NonNullable<LocationDocument['modelTransform']> {
  return { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } };
}

function messageFor(error: unknown, fallback: string): string { return error instanceof LocationApiError ? error.message : error instanceof Error ? error.message : fallback; }

function focusInvalidField(issue: EditorValidationIssue, root: HTMLElement | null): void {
  const target = [...(root?.querySelectorAll<HTMLElement>('[data-location-field]') ?? [])]
    .find((element) => element.dataset.locationField === issue.field);
  target?.focus();
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function selectionForField(field: string, document: LocationDocument): Selection | null {
  const zone = document.zones.find((item) => field.startsWith(`zone.${item.id}.`));
  if (zone) {
    const vertex = field.match(new RegExp(`^zone\\.${escapeRegExp(zone.id)}\\.vertex\\.(\\d+)\\.`));
    return { kind: 'zone', id: zone.id, ...(vertex ? { index: Number(vertex[1]) } : {}) };
  }
  const seat = document.tables.flatMap((table) => table.seats).find((item) => field.startsWith(`seat.${item.id}.`));
  if (seat) return { kind: 'seat', id: seat.id };
  const table = document.tables.find((item) => field.startsWith(`table.${item.id}.`));
  if (table) return { kind: 'table', id: table.id };
  if (field === 'seats.list') {
    const first = document.tables[0];
    if (first) return { kind: 'table', id: first.id };
  }
  return null;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function copyLocal(locationDocument: LocationDocument): Promise<void> {
  const text = JSON.stringify(locationDocument, null, 2);
  try { await navigator.clipboard.writeText(text); }
  catch {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = globalThis.document.createElement('a'); link.href = url; link.download = 'location-draft-local-copy.json'; link.click(); URL.revokeObjectURL(url);
  }
}
