import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEligibleDraftSensors, LocationApiError, suggestDraftCoverage } from '../../../entities/location-config/api/index.ts';
import type { DraftDetail, EligibleSensor, LocationDocument, SensorAssignment, TableCoverageSuggestion } from '../../../entities/location-config/model/types.ts';
import { addSensorAssignment, changedPoseField, coverageState, ownerSeatCount, patchSensorPose, proposedSensors, removeSensorAssignment, setTableOwner, tableCoverageMap } from '../../../features/location-editor/index.ts';
import { EditorCanvas } from './editor-canvas.tsx';

type PoseInput = { x: string; y: string; height: string; yaw: string; mirror: boolean };
type PoseFieldName = 'x' | 'y' | 'height' | 'yaw';
type PoseErrors = Partial<Record<PoseFieldName, string>>;

/**
 * Sensors step for the shared private location editor. The parent passes the
 * authored document and save/navigation callbacks; this widget owns only
 * transient sensor selection, eligibility reads and advisory coverage state.
 * @example <SensorPlacementStep draft={draft} document={document} onUpdate={update} onSave={save} ... />
 */
export function SensorPlacementStep({ draft, document, onUpdate, onSave, onBack, onContinue, busy, mustReload, onTransientValidityChange, onSensorLabelsChange, canvasTarget, canvasMode, active }: {
  draft: DraftDetail;
  document: LocationDocument;
  onUpdate(change: (current: LocationDocument) => LocationDocument): void;
  onSave(): Promise<DraftDetail | null>;
  onBack(): void;
  onContinue(): void;
  busy: string;
  mustReload: boolean;
  onTransientValidityChange(field: string, invalid: boolean): void;
  onSensorLabelsChange(sensors: Array<Pick<EligibleSensor, 'uid' | 'label'>>): void;
  canvasTarget: HTMLElement | null;
  canvasMode: '2d' | '3d';
  active: boolean;
}) {
  const [eligible, setEligible] = useState<EligibleSensor[]>([]);
  const [loadingSensors, setLoadingSensors] = useState(true);
  const [sensorError, setSensorError] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [poseInput, setPoseInput] = useState<PoseInput>({ x: '', y: '', height: '', yaw: '0', mirror: false });
  const [poseErrors, setPoseErrors] = useState<PoseErrors>({});
  const [coverageResult, setCoverageResult] = useState<{ key: string; state: 'loading' | 'ready' | 'error'; suggestions?: TableCoverageSuggestion[]; error?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [coverageRetry, setCoverageRetry] = useState(0);
  const requestId = useRef(0);
  const transientSensorRef = useRef<string | null>(null);
  const transientValidityCallback = useRef(onTransientValidityChange);
  transientValidityCallback.current = onTransientValidityChange;
  const eligibleByUid = useMemo(() => new Map(eligible.map((sensor) => [sensor.uid.toLowerCase(), sensor])), [eligible]);
  const assignmentsByUid = useMemo(() => new Map(document.sensorAssignments.map((assignment) => [assignment.uid.toLowerCase(), assignment])), [document.sensorAssignments]);
  const selectedAssignment = selectedUid ? assignmentsByUid.get(selectedUid.toLowerCase()) : undefined;
  const selectedSensor = selectedUid ? eligibleByUid.get(selectedUid.toLowerCase()) : undefined;

  useEffect(() => {
    const previous = transientSensorRef.current;
    if (previous && previous !== selectedUid) {
      for (const field of poseFieldNames) transientValidityCallback.current(`sensor.${previous}.${field}`, false);
    }
    transientSensorRef.current = selectedUid;
    return () => {
      if (selectedUid) for (const field of poseFieldNames) transientValidityCallback.current(`sensor.${selectedUid}.${field}`, false);
    };
  }, [selectedUid]);
  const disabled = busy !== '' || mustReload;
  const proposal = useMemo(() => proposedSensors(document, eligible), [document, eligible]);
  const coverageKey = JSON.stringify([draft.draftId, document, proposal]);
  const coverageCurrent = !loadingSensors && !sensorError && coverageResult?.key === coverageKey;
  const coverage = coverageCurrent && coverageResult.state === 'ready' ? coverageResult.suggestions ?? null : null;
  const coverageStateLabel = coverageCurrent ? coverageResult.state : 'loading';
  const coverageError = coverageCurrent && coverageResult.state === 'error' ? coverageResult.error ?? '' : '';
  const coverageReady = coverageCurrent && coverageResult.state === 'ready';
  const coverageByTable = useMemo(() => tableCoverageMap(coverage ? { locationId: draft.locationId, suggestions: coverage } : null), [coverage, draft.locationId]);
  const coverageOverlay = useMemo(() => Object.fromEntries(document.tables.map((table) => [table.id, coverageState(coverageByTable.get(table.id))])), [coverageByTable, document.tables]);

  const loadSensors = async () => {
    setLoadingSensors(true); setSensorError('');
    try {
      const result = await getEligibleDraftSensors(draft.draftId);
      setEligible(result.sensors);
      onSensorLabelsChange(result.sensors);
      setSelectedUid((current) => current ?? document.sensorAssignments.find((item) => result.sensors.some((sensor) => sensor.uid.toLowerCase() === item.uid.toLowerCase()))?.uid ?? result.sensors[0]?.uid ?? null);
    } catch (error) {
      setSensorError(error instanceof LocationApiError ? error.message : 'Eligible sensors could not be loaded.');
    } finally { setLoadingSensors(false); }
  };

  useEffect(() => { if (active) void loadSensors(); }, [draft.draftId, active]);
  useEffect(() => {
    if (!selectedUid) {
      setPoseInput({ x: '', y: '', height: '', yaw: '0', mirror: false }); setPoseErrors({}); return;
    }
    const pose = assignmentsByUid.get(selectedUid.toLowerCase())?.pose ?? eligibleByUid.get(selectedUid.toLowerCase())?.pose;
    setPoseInput(pose ? { x: String(pose.x / 100), y: String(pose.y / 100), height: String(pose.heightCm / 100), yaw: String(pose.yawDeg), mirror: pose.mirror }
      : { x: '', y: '', height: '', yaw: '0', mirror: false });
    setPoseErrors({}); setNotice('');
  }, [selectedUid, assignmentsByUid, eligibleByUid]);

  useEffect(() => {
    if (!active || loadingSensors || sensorError) { setCoverageResult(null); return; }
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setCoverageResult({ key: coverageKey, state: 'loading' });
      try {
        const result = await suggestDraftCoverage(draft.draftId, document, proposal);
        if (requestId.current !== id) return;
        setCoverageResult({ key: coverageKey, state: 'ready', suggestions: result.suggestions });
      } catch (error) {
        if (requestId.current !== id) return;
        setCoverageResult({ key: coverageKey, state: 'error', error: error instanceof LocationApiError ? error.message : 'Coverage suggestions could not be refreshed.' });
      }
    }, 180);
    return () => { window.clearTimeout(timer); };
  }, [draft.draftId, document, proposal, coverageKey, loadingSensors, sensorError, coverageRetry, active]);

  const markerRows = useMemo(() => {
    const markers = document.sensorAssignments.map((assignment) => {
      const sensor = eligibleByUid.get(assignment.uid.toLowerCase());
      return { uid: assignment.uid, label: sensor?.label ?? 'Previously assigned sensor', x: assignment.pose.x, y: assignment.pose.y, stale: !sensor, movable: !!sensor };
    });
    if (selectedUid && selectedSensor && !selectedAssignment && isFiniteInput(poseInput.x) && isFiniteInput(poseInput.y)) {
      markers.push({ uid: selectedUid, label: selectedSensor.label, x: Number(poseInput.x) * 100, y: Number(poseInput.y) * 100, stale: false, movable: true });
    }
    return markers;
  }, [document.sensorAssignments, eligibleByUid, selectedUid, selectedSensor, selectedAssignment, poseInput.x, poseInput.y]);

  const validation = (field: PoseFieldName, input: string): { value: number; error: string } => {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) return { value: NaN, error: field === 'height' ? 'Enter a mounting height from 1.5 m to 15 m.' : 'Enter a valid number.' };
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return { value: NaN, error: 'Enter a valid number.' };
    const bounds: [number, number] = field === 'x' ? [-10, document.widthCm / 100 + 10]
      : field === 'y' ? [-10, document.heightCm / 100 + 10]
        : field === 'height' ? [1.5, 15] : [-360, 360];
    if (parsed < bounds[0] || parsed > bounds[1]) return { value: NaN, error: `Enter a value from ${bounds[0]} to ${bounds[1]} ${field === 'yaw' ? 'degrees' : 'metres'}.` };
    return { value: parsed, error: '' };
  };

  const commitPoseField = (field: PoseFieldName, raw: string) => {
    const result = validation(field, raw);
    setPoseErrors((current) => ({ ...current, [field]: result.error || undefined }));
    if (selectedUid) onTransientValidityChange(`sensor.${selectedUid}.${field}`, !!result.error);
    if (result.error || !selectedUid || !selectedAssignment) return;
    const patch = changedPoseField(selectedAssignment.pose, field, result.value);
    if (!patch) return;
    onUpdate((current) => patchSensorPose(current, selectedUid, patch));
  };

  const changePoseInput = (field: PoseFieldName, value: string) => {
    setPoseInput((current) => ({ ...current, [field]: value }));
    const result = validation(field, value);
    setPoseErrors((current) => ({ ...current, [field]: result.error || undefined }));
    if (selectedUid) onTransientValidityChange(`sensor.${selectedUid}.${field}`, !!result.error);
    if (result.error || !selectedUid || !selectedAssignment) return;
    const patch = changedPoseField(selectedAssignment.pose, field, result.value);
    if (patch) onUpdate((current) => patchSensorPose(current, selectedUid, patch));
  };

  const completePose = (): SensorAssignment['pose'] | null => {
    const x = validation('x', poseInput.x), y = validation('y', poseInput.y), height = validation('height', poseInput.height), yaw = validation('yaw', poseInput.yaw);
    setPoseErrors({ x: x.error || undefined, y: y.error || undefined, height: height.error || undefined, yaw: yaw.error || undefined });
    if (x.error || y.error || height.error || yaw.error) return null;
    return { x: x.value * 100, y: y.value * 100, heightCm: height.value * 100, yawDeg: yaw.value, mirror: poseInput.mirror };
  };

  const addSelectedSensor = () => {
    if (!selectedUid || !selectedSensor || selectedAssignment) return;
    const pose = completePose();
    if (!pose) { setNotice('Complete a valid position and confirm the mounting height before adding this sensor.'); return; }
    onUpdate((current) => addSensorAssignment(current, selectedUid, pose));
    setNotice('Sensor added to this private draft. Current live sensor assignments are unchanged.');
  };

  const moveSensor = (uid: string, xCm: number, yCm: number) => {
    const boundedX = Math.max(-1000, Math.min(document.widthCm + 1000, xCm));
    const boundedY = Math.max(-1000, Math.min(document.heightCm + 1000, yCm));
    if (assignmentsByUid.has(uid.toLowerCase())) {
      onUpdate((current) => patchSensorPose(current, uid, { x: boundedX, y: boundedY }));
    } else if (selectedUid?.toLowerCase() === uid.toLowerCase()) {
      setPoseInput((current) => ({ ...current, x: String(boundedX / 100), y: String(boundedY / 100) }));
    }
  };
  const nudgeSelectedSensor = (dx: number, dy: number) => {
    if (!selectedUid) return;
    if (selectedAssignment) moveSensor(selectedUid, selectedAssignment.pose.x + dx, selectedAssignment.pose.y + dy);
    else if (isFiniteInput(poseInput.x) && isFiniteInput(poseInput.y)) moveSensor(selectedUid, Number(poseInput.x) * 100 + dx, Number(poseInput.y) * 100 + dy);
  };

  const chooseOwner = (tableId: string, ownerUid: string | null) => {
    if (!coverageReady) return;
    onUpdate((current) => setTableOwner(current, tableId, ownerUid));
  };
  const useSuggestion = (row: TableCoverageSuggestion) => {
    if (!coverageReady || !row.suggestedOwner) return;
    chooseOwner(row.tableId, row.suggestedOwner);
    setNotice('Suggested owner applied to the private draft. Save draft to retain it.');
  };
  const retryCoverage = () => { setCoverageResult(null); setCoverageRetry((current) => current + 1); };

  return <section className="loc-sensor-step" role="region" tabIndex={0} aria-labelledby="location-sensors-heading">
    <div className="loc-sensor-heading"><div><p className="cx-kicker">Private placement</p><h2 id="location-sensors-heading" tabIndex={-1} data-location-step-heading>Sensors</h2>
      <p className="cx-muted">Edit the draft only. Current live sensor assignments are unchanged until you publish.</p></div>
      <p className="loc-visibility"><b>Visibility · read-only</b><span>{draft.visibility === 'public' ? 'Public' : 'Console-only'}</span></p>
    </div>
    {draft.visibility === 'public' && <p className="loc-sensor-note">RGB sensors can only be assigned to console-only locations. This location is public.</p>}
    {(sensorError || coverageError) && <div className="loc-alert" role="alert"><p>{sensorError || coverageError}</p>
      {sensorError && <button type="button" className="btn btn-secondary" data-testid="location-sensors-retry" onClick={() => void loadSensors()}>Retry eligible sensors</button>}
      {!sensorError && coverageError && <button type="button" className="btn btn-secondary" data-testid="location-coverage-retry" onClick={retryCoverage}>Retry coverage</button>}
    </div>}
    {notice && <p className="loc-status" role="status" aria-live="polite">{notice}</p>}
    <div className="loc-sensor-layout">
      <section className="card loc-sensor-list" aria-labelledby="location-eligible-heading">
        <h3 id="location-eligible-heading">Eligible sensors</h3>
        {loadingSensors ? <p role="status" aria-busy="true">Loading eligible sensors…</p>
          : eligible.length ? <>
            <h4>Available for this location</h4>
            <ul className="loc-object-list">
              {eligible.map((sensor) => {
                const assignment = assignmentsByUid.get(sensor.uid.toLowerCase());
                return <li key={sensor.uid}>
                  <button type="button" className="loc-object-button loc-sensor-choice" data-testid={`location-sensor-${testToken(sensor.uid)}`} aria-pressed={selectedUid?.toLowerCase() === sensor.uid.toLowerCase()}
                    disabled={disabled}
                    aria-describedby="location-sensor-keyboard-help" onClick={() => setSelectedUid(sensor.uid)} onKeyDown={(event) => {
                      const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                      const move = delta[event.key]; if (!move) return;
                      event.preventDefault();
                      if (selectedUid?.toLowerCase() === sensor.uid.toLowerCase()) nudgeSelectedSensor(move[0] * (event.shiftKey ? 10 : 1), move[1] * (event.shiftKey ? 10 : 1));
                      else setSelectedUid(sensor.uid);
                    }}>
                    <span>{sensor.label}</span><small>{assignment ? `${sensor.pose ? 'Already in this location' : 'Available for this location'} · In this draft` : sensor.pose ? 'Already in this location' : 'Available for this location'}</small>
                    {sensor.rgb && <small>RGB · console-only</small>}
                  </button>
                </li>;
              })}
            </ul>
          </> : <p>No eligible sensors are available.</p>}
        {document.sensorAssignments.some((assignment) => !eligibleByUid.has(assignment.uid.toLowerCase())) && <>
          <h4>Needs attention</h4><ul className="loc-object-list">
            {document.sensorAssignments.filter((assignment) => !eligibleByUid.has(assignment.uid.toLowerCase())).map((assignment) => <li key={assignment.uid}>
              <button type="button" className="loc-object-button loc-sensor-stale" data-testid={`location-sensor-stale-${testToken(assignment.uid)}`} aria-pressed={selectedUid?.toLowerCase() === assignment.uid.toLowerCase()} disabled={disabled} onClick={() => setSelectedUid(assignment.uid)}>
                <span>Previously assigned sensor</span><small>Needs attention · no longer eligible</small>
              </button>
            </li>)}
          </ul>
        </>}
        <p id="location-sensor-keyboard-help" className="loc-sr">Select a sensor and use arrow keys to move it. Hold Shift to move ten centimetres.</p>
      </section>

      <aside className="card loc-sensor-inspector" aria-label="Selected sensor placement">
        <h3>Sensor placement</h3>
        {!selectedUid ? <p>Select an eligible sensor to place it.</p>
          : selectedAssignment && !selectedSensor ? <>
            <p className="loc-sensor-warning">Needs attention · no longer eligible</p>
            <p>The saved assignment stays in this private draft but is excluded from current coverage suggestions.</p>
            <button type="button" className="btn btn-secondary" data-testid="location-sensor-remove-stale" disabled={disabled} onClick={() => { onUpdate((current) => removeSensorAssignment(current, selectedUid)); setSelectedUid(null); }}>Remove stale assignment</button>
          </>
            : selectedSensor ? <>
              <p className="loc-sensor-label">{selectedSensor.label}</p>
              {selectedAssignment ? <p className="cx-muted">In this draft · {selectedSensor.pose ? 'Already in this location' : 'Private placement'}</p>
                : selectedSensor.pose ? <p className="cx-muted">Already in this location · not yet in this draft</p>
                  : <p className="loc-sensor-warning">Pose not set</p>}
              <PoseField label="Position X (m)" name="x" value={poseInput.x} error={poseErrors.x} min={-10} max={document.widthCm / 100 + 10} testId="location-sensor-position-x"
                disabled={disabled} onChange={(value) => changePoseInput('x', value)} onCommit={(value) => commitPoseField('x', value)} />
              <PoseField label="Position Y (m)" name="y" value={poseInput.y} error={poseErrors.y} min={-10} max={document.heightCm / 100 + 10} testId="location-sensor-position-y"
                disabled={disabled} onChange={(value) => changePoseInput('y', value)} onCommit={(value) => commitPoseField('y', value)} />
              <PoseField label="Height (m)" name="height" value={poseInput.height} error={poseErrors.height} min={1.5} max={15} testId="location-sensor-height"
                help="Enter a mounting height from 1.5 m to 15 m." disabled={disabled} onChange={(value) => changePoseInput('height', value)} onCommit={(value) => commitPoseField('height', value)} />
              <PoseField label="Yaw (°)" name="yaw" value={poseInput.yaw} error={poseErrors.yaw} min={-360} max={360} testId="location-sensor-yaw"
                disabled={disabled} onChange={(value) => changePoseInput('yaw', value)} onCommit={(value) => commitPoseField('yaw', value)} />
              <label className="loc-sensor-mirror"><input type="checkbox" data-testid="location-sensor-mirror" checked={poseInput.mirror} disabled={disabled} onChange={(event) => {
                const mirror = event.target.checked; setPoseInput((current) => ({ ...current, mirror }));
                if (selectedAssignment) onUpdate((current) => patchSensorPose(current, selectedUid, { mirror }));
              }} /> Mirror orientation</label>
              {selectedAssignment ? <button type="button" className="btn btn-ghost" data-testid="location-sensor-remove" disabled={disabled} onClick={() => { onUpdate((current) => removeSensorAssignment(current, selectedUid)); setNotice('Sensor removed from the private draft.'); }}>Remove from draft</button>
                : <button type="button" className="btn btn-secondary" data-testid="location-sensor-add" disabled={disabled} onClick={addSelectedSensor}>Add to draft with this pose</button>}
              <p className="cx-muted">Changing a draft pose does not move the live sensor. Height and mirror are preserved when another pose field changes.</p>
            </>
              : <p>Select an eligible sensor to place it.</p>}
      </aside>
    </div>
    {active && canvasTarget && canvasMode === '2d' && createPortal(<section className="card loc-sensor-map" aria-label="Sensor placement map">
      <div className="loc-canvas-panel">
        <EditorCanvas document={document} selected={null} drawing={null} planUrl={null} sensors={markerRows} selectedSensorUid={selectedUid ?? undefined} coverageStatus={coverageOverlay}
          onSensorSelect={setSelectedUid} onSensorMove={moveSensor} onSensorNudge={nudgeSelectedSensor}
          onSelect={() => {}} onSketchPoint={() => {}} onDragStart={() => {}} onDragTo={() => {}} onDragEnd={() => {}} onNudge={() => {}} onFinishDrawing={() => {}} onCancelDrawing={() => {}} />
      </div>
      <p className="loc-canvas-caption">Top-left origin · position in metres; sensor markers can be selected from the list, dragged, or moved with arrow keys.</p>
    </section>, canvasTarget)}

    <section className="card loc-coverage-section" aria-labelledby="location-coverage-heading">
      <div className="loc-sensor-heading"><div><h3 id="location-coverage-heading">Table coverage and owners</h3><p className="cx-muted">Suggestions are advisory. One sensor can own multiple tables; each table has at most one owner.</p></div>
        {coverageStateLabel === 'loading' && <span role="status" aria-busy="true">Coverage suggestions are updating; previous counts are not current.</span>}
      </div>
      {!document.tables.length ? <p>Add tables in Details &amp; layout to review coverage.</p>
        : coverageStateLabel === 'error' ? <p>Coverage suggestions could not be refreshed.</p>
          : <div className="loc-coverage-table-wrap"><table className="loc-coverage-table">
            <thead><tr><th scope="col">Table</th><th scope="col">Seat coverage</th><th scope="col">Assigned owner</th><th scope="col">Suggestion</th><th scope="col">Draft status</th></tr></thead>
            <tbody>{document.tables.map((table) => {
              const row = coverageByTable.get(table.id);
              const state = coverageState(row);
              const owner = document.sensorAssignments.find((assignment) => assignment.owns.includes(table.id));
              const ownerCount = ownerSeatCount(row, owner?.uid);
              const ownerSensor = owner ? eligibleByUid.get(owner.uid.toLowerCase()) : undefined;
              const suggestedSensor = row?.suggestedOwner ? eligibleByUid.get(row.suggestedOwner.toLowerCase()) : undefined;
              const ownerStale = !!owner && !ownerSensor;
              return <tr key={table.id} data-testid={`location-table-coverage-${testToken(table.id)}`} className={`loc-coverage-row is-${state}`}>
                <th scope="row">{table.name}<small>{table.seats.length} seats</small></th>
                <td><span className={`loc-coverage-status is-${state}`}>{state === 'unknown' ? 'Unknown' : state === 'none' ? 'No sensor coverage' : state === 'partial' ? 'Some seats uncovered' : 'All seats covered'}</span>
                  {row && <small>{row.seatCoverage.coveredSeats} / {row.seatCoverage.totalSeats} seats covered</small>}
                  {owner && ownerCount !== null && ownerCount < (row?.seatCoverage.totalSeats ?? 0) && <small className="loc-sensor-warning">Needs attention · draft owner must cover every seat ({ownerCount}/{row?.seatCoverage.totalSeats ?? table.seats.length})</small>}
                </td>
                <td><label className="loc-field"><span className="loc-sr">Assigned owner for {table.name}</span><select className="input" aria-label={`Assigned owner for ${table.name}`} data-testid={`location-table-owner-${testToken(table.id)}`} value={owner?.uid ?? ''} disabled={disabled || !coverageReady} onChange={(event) => chooseOwner(table.id, event.target.value || null)}>
                  <option value="">No sensor</option>
                  {ownerStale && <option value={owner.uid}>Previously assigned sensor · no longer eligible</option>}
                  {document.sensorAssignments.filter((assignment) => eligibleByUid.has(assignment.uid.toLowerCase())).map((assignment) => <option key={assignment.uid} value={assignment.uid}>{eligibleByUid.get(assignment.uid.toLowerCase())?.label ?? 'Eligible sensor'}</option>)}
                </select></label></td>
                <td>{suggestedSensor ? <><span>{suggestedSensor.label}</span>{row?.suggestedOwner !== owner?.uid && <button type="button" className="btn btn-ghost" data-testid={`location-table-use-suggestion-${testToken(table.id)}`} disabled={disabled || !coverageReady} onClick={() => row && useSuggestion(row)}>Use suggestion</button>}</> : <span className="cx-muted">None</span>}</td>
                <td>{owner ? ownerStale ? 'Draft assignment needs attention · sensor no longer eligible' : ownerCount !== null && ownerCount === row?.seatCoverage.totalSeats ? 'Draft owner covers every seat' : 'Unknown · draft owner needs full coverage' : 'Unknown'}</td>
              </tr>;
            })}</tbody>
          </table></div>}
    </section>
    <footer className="loc-footer">
      <button type="button" className="btn btn-ghost" data-testid="location-sensors-back" disabled={busy !== ''} onClick={onBack}>Back to layout</button>
      <span>{mustReload ? 'Reload latest before further changes' : `Draft revision ${draft.draftRevision} · private · live assignments unchanged`}</span>
      <button type="button" className="btn btn-secondary" data-testid="location-sensors-save" disabled={disabled} onClick={() => void onSave()}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
      <button type="button" className="btn btn-primary" data-testid="location-sensors-continue" disabled={disabled} onClick={onContinue}>Continue to Room view</button>
    </footer>
  </section>;
}

/** Labeled sensor number input; raw decimal text is committed once on blur. */
function PoseField({ label, name, value, min, max, error, help, testId, disabled, onChange, onCommit }: {
  label: string; name: PoseFieldName; value: string; min: number; max: number; error?: string; help?: string; testId: string; disabled: boolean;
  onChange(value: string): void; onCommit(value: string): void;
}) {
  const [localError, setLocalError] = useState('');
  useEffect(() => { setLocalError(''); }, [value]);
  const errorId = `sensor-${name}-error`;
  const helpId = help ? `sensor-${name}-help` : undefined;
  return <label className="loc-field"><span>{label}</span><input className="input" type="text" inputMode="decimal" data-testid={testId} aria-label={label} aria-invalid={!!error || !!localError || undefined}
    aria-describedby={[helpId, (error || localError) ? errorId : undefined].filter(Boolean).join(' ') || undefined} value={value} disabled={disabled}
    onChange={(event) => { setLocalError(''); onChange(event.target.value); }} onBlur={() => {
      const parsed = value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) { setLocalError(name === 'height' ? 'Enter a mounting height from 1.5 m to 15 m.' : `Enter a value from ${min} to ${max}.`); return; }
      setLocalError(''); onCommit(value);
    }} />
    {help && <small id={helpId} className="cx-muted">{help}</small>}
    {(error || localError) && <small id={errorId} className="loc-field-error" role="alert">{error || localError}</small>}
  </label>;
}

function isFiniteInput(value: string): boolean { return value.trim() !== '' && Number.isFinite(Number(value)); }
function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
const poseFieldNames: PoseFieldName[] = ['x', 'y', 'height', 'yaw'];
