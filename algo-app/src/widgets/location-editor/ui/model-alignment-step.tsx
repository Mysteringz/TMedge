import { useEffect, useId, useState } from 'react';
import type { AssetUploadResult, DraftDetail, LocationDocument, ModelTransform, TableShape } from '../../../entities/location-config/index.ts';
import { modelSceneFromDocument, shapeOf } from '../../../features/location-editor/index.ts';
import { LOCATION_MODEL_TRANSFORM_LIMITS } from '../../../../../src/shared/location-validation.ts';
import { validateLocationModelBuffer } from '../model-viewer-loader.ts';
import { ModelPreview } from './model-preview.tsx';

export interface ModelUploadOutcome extends Pick<AssetUploadResult, 'assetId' | 'draftRevision' | 'durability' | 'displayName'> {
  /** False when the attachment committed but authoritative draft details could not yet be reloaded. */
  reloaded: boolean;
}

/** Optional model editor; the parent owns draft persistence/publication and passes only safe asset capability data.
 * @example <ModelAlignmentStep draft={draft} document={document} onUpload={uploadModel} onUpdate={update} />
 */
export function ModelAlignmentStep({ draft, document, busy, mustReload, onUpdate, onUpload, onSave, onBack, onContinue, onPreflightBlockedChange }: {
  draft: DraftDetail; document: LocationDocument; busy: string; mustReload: boolean;
  onUpdate(change: (current: LocationDocument) => LocationDocument): void;
  onUpload(file: File): Promise<ModelUploadOutcome | null>;
  onSave(): void; onBack(): void; onContinue(): void;
  onPreflightBlockedChange(blocked: boolean): void;
}) {
  const capability = draft.assetCapabilities?.modelAssetId;
  const legacyStatic = capability?.source === 'legacy-static';
  const hasModel = !!document.modelAssetId;
  const editable = hasModel && capability?.source === 'upload' && capability.alignmentEditable;
  const transform = document.modelTransform ?? defaultTransform();
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<ModelUploadOutcome | null>(null);
  const [preflightFailed, setPreflightFailed] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [message, setMessage] = useState('');
  const [transformError, setTransformError] = useState('');

  useEffect(() => {
    if (pendingOutcome && !mustReload && draft.document.modelAssetId === pendingOutcome.assetId
      && draft.draftRevision >= pendingOutcome.draftRevision && draft.durability !== 'unconfirmed') {
      setPendingFile(null);
      setPendingOutcome(null);
      setPreflightFailed(false);
      onPreflightBlockedChange(false);
      setMessage('GLB attached to this private draft. The previously published model remains active until publication.');
    }
  }, [pendingOutcome, draft.document.modelAssetId, draft.draftRevision, draft.durability, mustReload, onPreflightBlockedChange]);

  const upload = async (file: File) => {
    setMessage('');
    setPendingFile(file);
    setPreflightFailed(false);
    setPreflighting(true);
    onPreflightBlockedChange(true);
    try {
      if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('The GLB file exceeds the supported size.');
      await validateLocationModelBuffer(await file.arrayBuffer());
    } catch {
      setPreflightFailed(true);
      setMessage('This GLB could not be decoded for preview. The current draft model, transform, and unsaved edits are unchanged. Choose another GLB or retry.');
      return;
    } finally { setPreflighting(false); }
    const result = await onUpload(file);
    if (!result) return;
    setPendingOutcome(result);
    if (result.durability === 'unconfirmed') {
      setMessage(`The GLB was attached to draft revision ${result.draftRevision}, but storage durability could not be confirmed. The selected file is retained; reload before continuing.`);
      return;
    }
    if (!result.reloaded) {
      setMessage(`The GLB was attached to draft revision ${result.draftRevision}, but draft details could not be reloaded. The selected file is retained; retry reload before continuing.`);
      return;
    }
    setPendingFile(null);
    setPendingOutcome(null);
    setPreflightFailed(false);
    onPreflightBlockedChange(false);
    setMessage('GLB attached to this private draft. The previously published model remains active until publication.');
  };

  const updateTransform = (group: keyof ModelTransform, axis: 'x' | 'y' | 'z', value: number) => {
    onUpdate((current) => {
      const currentTransform = current.modelTransform ?? defaultTransform();
      return { ...current, modelTransform: { ...currentTransform, [group]: { ...currentTransform[group], [axis]: value } } };
    });
  };

  return <section className="card loc-model-step" aria-labelledby="loc-model-step-title">
    <header className="loc-model-heading">
      <div><p className="cx-kicker">Optional step</p><h2 tabIndex={-1} data-location-step-heading id="loc-model-step-title">3D model</h2>
        <p className="cx-muted">Align a self-contained GLB to the fixed floor, table, seat and sensor coordinates.</p></div>
      <p className="loc-visibility"><b>Visibility · read-only</b><span>{draft.visibility === 'public' ? 'Public · student-visible' : 'Console-only · not shown to students'}</span></p>
    </header>

    {legacyStatic ? <section className="loc-model-legacy" aria-labelledby="loc-model-legacy-title">
      <h3 id="loc-model-legacy-title">Existing venue model · read-only</h3>
      <p>The existing venue model is retained from the published base. Its preview is unavailable in this console. Use the 2D floor view below; upload a GLB to change the model or alignment.</p>
      <ReadOnlyTransform transform={transform} />
      <FloorGeometryFallback document={document} />
    </section> : editable && capability?.previewAvailable ? <ModelPreview
      draft={draft} document={document} capability={capability} retry={previewRetry} onRetry={() => setPreviewRetry((value) => value + 1)} />
      : <section className="loc-model-empty" aria-label="Model preview status">
        {hasModel ? <><p role="status">The referenced model is retained, but its authorized preview capability is unavailable. Reload the draft or choose a replacement GLB.</p><FloorGeometryFallback document={document} /></>
          : <><p>No 3D model is selected. {draft.visibility === 'public' ? 'Students will see the 2D floor map until a model is uploaded and published.' : 'The console will use the saved floor geometry.'}</p><FloorGeometryFallback document={document} /></>}
      </section>}

    {editable && <section className="loc-model-transform" aria-labelledby="loc-model-transform-title">
      <div className="loc-model-transform-heading"><div><h3 id="loc-model-transform-title">Model alignment</h3>
        <p className="cx-muted">The GLB moves against the fixed authored floor overlays. Camera controls do not change alignment.</p></div>
        <span className="loc-model-source">{capability.fromPublishedBase ? 'Published base · private draft' : 'This draft · private'}</span></div>
      {draft.visibility === 'public'
        ? <p className="loc-model-delivery" data-testid="location-model-delivery-status">GLB validated on edge · student delivery will be verified during publication.{draft.basePublishedRevision !== null && ' The current published model remains active until this draft is published.'}</p>
        : <p className="loc-model-delivery" data-testid="location-model-delivery-status">Console-only · edge preview. This model stays on the edge and has no student-delivery state.</p>}
      <div className="loc-transform-grid">
        {(['scale', 'rotationDeg', 'positionM'] as const).map((group) => <fieldset key={group} className="loc-transform-group">
          <legend>{group === 'scale' ? 'Scale (×)' : group === 'rotationDeg' ? 'Rotation (°)' : 'Position (m)'}</legend>
          <div className="loc-transform-fields">{(['x', 'y', 'z'] as const).map((axis) => {
            const limits = group === 'scale' ? LOCATION_MODEL_TRANSFORM_LIMITS.scale
              : group === 'rotationDeg' ? LOCATION_MODEL_TRANSFORM_LIMITS.rotationDeg : LOCATION_MODEL_TRANSFORM_LIMITS.positionM;
            const label = group === 'scale' ? `Scale ${axis.toUpperCase()}`
              : group === 'rotationDeg' ? `Rotation ${axis.toUpperCase()} (°)` : `Position ${axis.toUpperCase()} (m)`;
            return <ModelNumberField key={`${group}:${axis}`} label={label} value={transform[group][axis]} min={limits.min} max={limits.max}
              path={`${group}.${axis}`} disabled={busy !== '' || mustReload || preflighting || preflightFailed || !editable}
              onValue={(value) => updateTransform(group, axis, value)} onError={setTransformError} />;
          })}</div>
        </fieldset>)}
      </div>
      {transformError && <p role="alert" className="loc-alert">{transformError}</p>}
      <p className="loc-model-alignment-note">Numeric values keep full precision. Scale is dimensionless; rotations use degrees; position uses metres.</p>
    </section>}

    {pendingFile && <div className="loc-model-pending" role="status" data-testid="location-model-pending-file">
      <span>{pendingOutcome ? `Selected ${pendingOutcome.displayName ?? pendingFile.name} · attached to revision ${pendingOutcome.draftRevision}` : busy === 'model-upload' ? `Uploading ${pendingFile.name} to the private draft…` : `${pendingFile.name} · selected for private draft upload`}</span>
      {preflighting && <span data-testid="location-model-preflight-status">Checking the selected GLB locally before upload...</span>}
      {busy === 'model-upload' && <progress aria-label="Uploading GLB" data-testid="location-model-upload-progress" />}
      <button type="button" className="btn btn-secondary" data-testid="location-model-upload-retry" disabled={busy !== '' || mustReload || preflighting || !!pendingOutcome} onClick={() => void upload(pendingFile)}>Retry upload</button>
      {!pendingOutcome && <button type="button" className="btn btn-ghost" data-testid="location-model-upload-clear" disabled={busy !== '' || mustReload || preflighting} onClick={() => { setPendingFile(null); setPreflightFailed(false); setMessage(''); onPreflightBlockedChange(false); }}>Clear selection</button>}
    </div>}
    {message && <p className="loc-model-upload-status" role="status" aria-live="polite">{message}</p>}
    {capability?.source === 'upload' && <p className="loc-model-filename" data-testid="location-model-filename" role="status">
      {capability.displayName ?? 'Uploaded GLB'} · {capability.fromPublishedBase ? 'Published base · private draft' : 'This draft · private'}
    </p>}

    <div className="loc-model-upload-panel">
      <label className="loc-upload"><span>{legacyStatic ? 'Replace with uploaded GLB' : hasModel ? 'Replace GLB' : 'Upload GLB'}</span>
        <input type="file" accept=".glb,model/gltf-binary" aria-label={legacyStatic ? 'Replace with uploaded GLB' : 'Upload GLB'}
          data-testid="location-model-upload" disabled={busy !== '' || mustReload || preflighting}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file); }} />
      </label>
      <p className="cx-muted">Choose a self-contained binary glTF (.glb), up to 128 MiB. The server checks the file before it replaces the current reference.</p>
      {hasModel && !legacyStatic && <button type="button" className="btn btn-ghost" data-testid="location-model-use-2d" disabled={busy !== '' || mustReload}
        onClick={() => onUpdate((current) => { const next = { ...current }; delete next.modelAssetId; delete next.modelTransform; return next; })}>Use 2D only in this draft</button>}
      {legacyStatic && <p className="loc-model-legacy-help">Upload a GLB to change the model or alignment. The inherited model stays in place until the replacement upload succeeds.</p>}
    </div>

    <footer className="loc-footer">
      <button type="button" className="btn btn-ghost" data-testid="location-model-back" disabled={busy !== ''} onClick={onBack}>Back</button>
      <span>{pendingOutcome && (pendingOutcome.durability === 'unconfirmed' || !pendingOutcome.reloaded) ? `Applied draft revision ${pendingOutcome.draftRevision} · reload required` : `Draft revision ${draft.draftRevision} · private`}</span>
      <button type="button" className="btn btn-secondary" data-testid="location-model-save-draft" disabled={busy !== '' || mustReload || preflighting || preflightFailed} onClick={onSave}>Save draft</button>
      <button type="button" className="btn btn-primary" data-testid="location-model-continue" disabled={busy !== '' || mustReload || preflighting || preflightFailed} onClick={onContinue}>Continue to review</button>
    </footer>
  </section>;
}

/** Review-safe model source, transform, and publish-delivery status; never exposes asset provenance.
 * @example <ModelReviewSummary draft={draft} document={document} onEdit={openModelStep} />
 */
export function ModelReviewSummary({ draft, document, onEdit }: { draft: DraftDetail; document: LocationDocument; onEdit(): void }) {
  const capability = draft.assetCapabilities?.modelAssetId;
  const transform = document.modelTransform ?? defaultTransform();
  if (!document.modelAssetId) return <section className="card loc-model-review" aria-labelledby="loc-model-review-title">
    <h3 id="loc-model-review-title">3D model · optional</h3>
    <p>{draft.visibility === 'public' ? 'No 3D model — students will see the 2D floor map.' : 'No 3D model is selected. The console uses the saved floor geometry.'}</p>
    <button type="button" className="btn btn-secondary" data-testid="location-review-adjust-model" onClick={onEdit}>Add a 3D model</button>
  </section>;

  if (capability?.source === 'legacy-static') return <section className="card loc-model-review" aria-labelledby="loc-model-review-title">
    <h3 id="loc-model-review-title">3D model · retained</h3>
    <p>Existing venue model · retained, alignment read-only.</p>
    <ReadOnlyTransform transform={transform} />
    <p>The static model is not previewed or distributed as an uploaded asset. Use the 2D floor view, or upload a GLB to change it.</p>
    <button type="button" className="btn btn-secondary" data-testid="location-review-adjust-model" onClick={onEdit}>Replace with uploaded GLB</button>
  </section>;

  if (capability?.source !== 'upload') return <section className="card loc-model-review" aria-labelledby="loc-model-review-title">
    <h3 id="loc-model-review-title">3D model status unavailable</h3>
    <p>The saved reference is preserved. Reload the draft to confirm its preview capability.</p>
  </section>;

  return <section className="card loc-model-review" aria-labelledby="loc-model-review-title">
    <h3 id="loc-model-review-title">3D model · uploaded</h3>
    <p>{capability.fromPublishedBase ? 'Published base · private draft' : 'This draft · private'}</p>
    <p data-testid="location-review-model-filename">{capability.displayName ?? 'Uploaded GLB'}</p>
    {draft.visibility === 'public'
      ? <p>GLB validated on edge · student delivery will be verified during publication.{draft.basePublishedRevision !== null && ' The current published model remains active until this draft is published.'}</p>
      : <p>Console-only · edge preview. This model has no student-delivery state.</p>}
    <ReadOnlyTransform transform={transform} />
    {capability.alignmentEditable && <button type="button" className="btn btn-secondary" data-testid="location-review-adjust-model" onClick={onEdit}>Adjust alignment</button>}
  </section>;
}

/** Reusable transform field used by the model alignment inspector; commits valid raw decimals only. */
function ModelNumberField({ label, value, min, max, path, disabled, onValue, onError }: {
  label: string; value: number; min: number; max: number; path: string; disabled: boolean;
  onValue(value: number): void; onError(message: string): void;
}) {
  const id = useId();
  const [raw, setRaw] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (globalThis.document.activeElement?.getAttribute('data-location-model-field') !== path) {
      setRaw(String(value)); setInvalid(false);
    }
  }, [value, path]);
  const commit = (text: string) => {
    const parsed = Number(text);
    if (!text.trim() || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setInvalid(true); onError(`${label} must be between ${min} and ${max}.`); return;
    }
    setInvalid(false); onError(''); setRaw(String(parsed));
    if (parsed !== value) onValue(parsed);
  };
  return <label className="loc-model-number-field"><span>{label}</span>
    <input className="input" type="text" inputMode="decimal" value={raw} min={min} max={max} disabled={disabled}
      aria-label={label} aria-invalid={invalid || undefined} aria-describedby={invalid ? id : `${id}-help`}
      data-testid={`location-model-transform-${path.replace('.', '-')}`} data-location-model-field={path}
      onChange={(event) => {
        const text = event.target.value; setRaw(text); setInvalid(false); onError('');
        if (text.trim() && Number.isFinite(Number(text)) && Number(text) >= min && Number(text) <= max) onValue(Number(text));
      }}
      onBlur={(event) => commit(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <small id={`${id}-help`}>{min} to {max}</small>
    {invalid && <small id={id} className="loc-model-field-error">Enter a value from {min} to {max}.</small>}
  </label>;
}

/** Used in legacy-static and Review states to show the exact pinned transform without edit controls. */
function ReadOnlyTransform({ transform }: { transform: ModelTransform }) {
  return <dl className="loc-model-readonly-transform">
    <dt>Scale</dt><dd>{vectorText(transform.scale)}</dd>
    <dt>Rotation (°)</dt><dd>{vectorText(transform.rotationDeg)}</dd>
    <dt>Position (m)</dt><dd>{vectorText(transform.positionM)}</dd>
    <dt>Alignment</dt><dd>Read-only · upload a GLB to change alignment.</dd>
  </dl>;
}

/** Used by the model step when no uploaded GLB is available; it draws draft geometry and fetches no static bytes. */
function FloorGeometryFallback({ document }: { document: LocationDocument }) {
  const scene = modelSceneFromDocument(document);
  return <div className="loc-model-floor-fallback" data-testid="location-model-2d-fallback">
    <h3>2D floor geometry</h3>
    <svg viewBox={`0 0 ${document.widthCm} ${document.heightCm}`} role="img" aria-label="Two-dimensional floor geometry with authored tables, seats and placed sensors" preserveAspectRatio="xMidYMid meet">
      <rect className="loc-model-floor-outline" x="0" y="0" width={document.widthCm} height={document.heightCm} />
      {document.tables.map((table) => <FloorTable key={table.id} id={table.id} shape={shapeOf(table)} />)}
      {document.tables.flatMap((table) => table.seats.map((seat) => <circle className="loc-model-floor-seat" key={`${table.id}:${seat.id}`} cx={seat.x} cy={seat.y} r={Math.max(4, Math.min(12, document.widthCm / 180))} />))}
      {document.sensorAssignments.map((assignment, index) => <circle className="loc-model-floor-sensor" key={assignment.uid} cx={assignment.pose.x} cy={assignment.pose.y} r={Math.max(8, Math.min(20, document.widthCm / 90))}><title>{`Placed sensor ${index + 1}`}</title></circle>)}
    </svg>
    <ul aria-label="Floor geometry objects">{scene.tables.map((table) => <li key={table.id}>{table.name} · {table.seats.length} seats</li>)}{scene.sensors.map((sensor, index) => <li key={`${sensor.label}:${index}`}>{sensor.label} · placed</li>)}</ul>
  </div>;
}

/** Internal child of FloorGeometryFallback that draws a rectangle, circle, or polygon table shape. */
function FloorTable({ id, shape }: { id: string; shape: TableShape }) {
  if (shape.type === 'circle') return <circle className="loc-model-floor-table" data-table-id={id} cx={shape.cx} cy={shape.cy} r={shape.radius} />;
  if (shape.type === 'polygon') return <polygon className="loc-model-floor-table" data-table-id={id} points={shape.points.map(([x, y]) => `${x},${y}`).join(' ')} />;
  return <rect className="loc-model-floor-table" data-table-id={id} x={shape.x} y={shape.y} width={shape.width} height={shape.height} />;
}

function defaultTransform(): ModelTransform {
  return { scale: { x: 1, y: 1, z: 1 }, rotationDeg: { x: 0, y: 0, z: 0 }, positionM: { x: 0, y: 0, z: 0 } };
}

function vectorText(value: ModelTransform['scale']): string { return `${value.x}, ${value.y}, ${value.z}`; }
