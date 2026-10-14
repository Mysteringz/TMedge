import { useEffect, useId, useRef, useState } from 'react';
import type { FurnitureAssignment, FurnitureLibraryItem, FurnitureSlots, FurnitureType, LocationDocument, Table } from '../../../entities/location-config/index.ts';
import { assignmentForNewOverride, effectiveFurniture, FURNITURE_FIT_LIMITS } from '../model/assignments.ts';

type FurnitureCopySource = 'generated' | 'custom' | 'other';

export function RoomFurnitureDefaults({ value, items, disabled, source, onChange, onOpenLibrary }: {
  value?: FurnitureSlots; items: ReadonlyMap<string, FurnitureLibraryItem>; disabled: boolean;
  source: FurnitureCopySource;
  onChange(value: FurnitureSlots | undefined): void; onOpenLibrary(type: FurnitureType): void;
}) {
  return <section className="loc-furniture-controls" aria-labelledby="loc-furniture-defaults-title">
    <h3 id="loc-furniture-defaults-title">Shared furniture defaults</h3>
    <p className="cx-muted">Defaults apply to every table. Table edits replace the complete matching default.</p>
    {(['table', 'chair'] as const).map((slot) => <RoomFurnitureSlot key={slot} slot={slot} source={source} assignment={value?.[slot]} item={value?.[slot] ? items.get(value[slot]!.assetId) : undefined} disabled={disabled}
      onOpenLibrary={() => onOpenLibrary(slot)} onChange={(assignment) => {
        const next = { ...(value ?? {}) };
        if (assignment) next[slot] = assignment; else delete next[slot];
        onChange(Object.keys(next).length ? next : undefined);
      }} />)}
  </section>;
}

function RoomFurnitureSlot({ slot, source, assignment, item, disabled, onOpenLibrary, onChange }: {
  slot: FurnitureType; assignment?: FurnitureAssignment; item?: FurnitureLibraryItem; disabled: boolean;
  source: FurnitureCopySource;
  onOpenLibrary(): void; onChange(value?: FurnitureAssignment): void;
}) {
  return <fieldset className="loc-furniture-slot">
    <legend>{slot === 'table' ? 'Table model default' : 'Chair model default · all seats'}</legend>
    <p className="loc-furniture-assigned" data-testid={`location-furniture-default-${slot}`}>
      {assignment ? `${item ? `${item.displayName} · ${slot === 'table' ? 'Table' : 'Chair'} model` : `Assigned shared ${slot} model`} · scale ${assignment.scale}× · yaw ${assignment.yawDeg}° · elevation ${assignment.elevationM} m`
        : source === 'generated' ? `No ${slot} model default. Built-in rooms use a generated ${slot} fallback.`
          : source === 'custom' ? `No ${slot} model default. No ${slot} overlay is assigned to the custom room.`
            : `No ${slot} model default. Shared ${slot} models appear in 3D room views.`}
    </p>
    <div className="loc-inline-actions">
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={onOpenLibrary}>{assignment ? 'Change model' : 'Choose model'}</button>
      {assignment && <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onChange(undefined)}>Clear default</button>}
    </div>
    {assignment && <FurnitureFitFields slot={slot} prefix={`location-default-${slot}`} value={assignment} disabled={disabled} onChange={onChange} />}
  </fieldset>;
}

export function TableFurnitureOverrides({ document, table, items, disabled, source, onUpdate, onOpenLibrary }: {
  document: LocationDocument; table: Table; items: ReadonlyMap<string, FurnitureLibraryItem>; disabled: boolean;
  source: FurnitureCopySource;
  onUpdate(change: (current: LocationDocument) => LocationDocument): void; onOpenLibrary(type: FurnitureType): void;
}) {
  const updateSlot = (slot: FurnitureType, value?: FurnitureAssignment) => onUpdate((current) => ({
    ...current,
    tables: current.tables.map((candidate) => {
      if (candidate.id !== table.id) return candidate;
      const overrides = { ...(candidate.furnitureOverrides ?? {}) };
      if (value) overrides[slot] = value; else delete overrides[slot];
      const next = { ...candidate };
      if (Object.keys(overrides).length) next.furnitureOverrides = overrides;
      else delete next.furnitureOverrides;
      return next;
    }),
  }));

  return <section className="loc-inspector-block loc-furniture-controls" aria-labelledby="loc-table-furniture-title" data-testid="location-table-furniture">
    <h3 id="loc-table-furniture-title">Furniture models</h3>
    {(['table', 'chair'] as const).map((slot) => {
      const override = table.furnitureOverrides?.[slot];
      const inherited = document.furnitureDefaults?.[slot];
      const effective = effectiveFurniture(document.furnitureDefaults, table.furnitureOverrides, slot);
      return <TableFurnitureSlot key={slot} slot={slot} source={source} override={override} effective={effective} inherited={inherited}
        item={effective ? items.get(effective.assetId) : undefined} tableId={table.id} disabled={disabled}
        onOpenLibrary={() => onOpenLibrary(slot)} onOverride={() => updateSlot(slot, assignmentForNewOverride(inherited))}
        onReset={() => updateSlot(slot, undefined)} onFit={(value) => updateSlot(slot, value)} />;
    })}
  </section>;
}

function TableFurnitureSlot({ slot, source, override, effective, inherited, item, tableId, disabled, onOpenLibrary, onOverride, onReset, onFit }: {
  slot: FurnitureType; override?: FurnitureAssignment; effective?: FurnitureAssignment; inherited?: FurnitureAssignment;
  source: FurnitureCopySource;
  item?: FurnitureLibraryItem; tableId: string; disabled: boolean; onOpenLibrary(): void; onOverride(): void; onReset(): void; onFit(value: FurnitureAssignment): void;
}) {
  const selectId = useId();
  return <fieldset className="loc-furniture-slot">
    <legend>{slot === 'table' ? 'Table model' : `Chair model for all ${slot === 'chair' ? 'seats' : ''}`}</legend>
    <label className="loc-field" htmlFor={selectId}><span>Assignment</span>
      <select id={selectId} className="input" aria-label={`${slot === 'table' ? 'Table' : 'Chair'} model assignment`} data-testid={`location-furniture-mode-${tableId}-${slot}`} value={override ? 'override' : 'inherit'} disabled={disabled}
        onChange={(event) => { if (event.target.value === 'inherit') onReset(); else if (inherited) onOverride(); else onOpenLibrary(); }}>
        <option value="inherit">Inherit room default</option><option value="override">Use table override</option>
      </select>
    </label>
    {!override ? <p className="loc-furniture-assigned">{effective ? `Using room default${item ? ` · ${item.displayName} · ${slot === 'table' ? 'Table' : 'Chair'} model` : ''} · scale ${effective.scale}× · yaw ${effective.yawDeg}° · elevation ${effective.elevationM} m`
      : source === 'generated' ? 'No room default; the built-in room uses its generated primitive fallback.'
        : source === 'custom' ? 'No room default; no shared furniture overlay is assigned to this custom room.'
          : 'No room default; no shared furniture model is assigned.'}</p>
      : <>
        <p className="loc-furniture-assigned">{item ? `${item.displayName} · ${slot === 'table' ? 'Table' : 'Chair'} model` : `Assigned shared ${slot} model`} · override applies to this table{slot === 'chair' ? ' and all of its seats' : ''}.</p>
        <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" disabled={disabled} onClick={onOpenLibrary}>Change model</button>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onReset}>Reset to room default</button></div>
        <FurnitureFitFields slot={slot} prefix={`table-${tableId}-${slot}`} value={override} disabled={disabled} onChange={onFit} />
      </>}
  </fieldset>;
}

export function FurnitureFitFields({ slot, prefix, value, disabled, onChange }: {
  slot: FurnitureType; prefix: string; value: FurnitureAssignment; disabled: boolean; onChange(value: FurnitureAssignment): void;
}) {
  return <div className="loc-furniture-fit" role="group" aria-label={`${slot === 'table' ? 'Table' : 'Chair'} model fit`}>
    <FurnitureNumber label="Uniform scale (×)" field="scale" value={value.scale} prefix={prefix} disabled={disabled} onChange={(next) => onChange({ ...value, scale: next })} />
    <FurnitureNumber label="Yaw (°)" field="yawDeg" value={value.yawDeg} prefix={prefix} disabled={disabled} onChange={(next) => onChange({ ...value, yawDeg: next })} />
    <FurnitureNumber label="Elevation (m)" field="elevationM" value={value.elevationM} prefix={prefix} disabled={disabled} onChange={(next) => onChange({ ...value, elevationM: next })} />
  </div>;
}

function FurnitureNumber({ label, field, value, prefix, disabled, onChange }: { label: string; field: keyof typeof FURNITURE_FIT_LIMITS; value: number; prefix: string; disabled: boolean; onChange(value: number): void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState(String(value));
  const [error, setError] = useState('');
  const limits = FURNITURE_FIT_LIMITS[field];
  useEffect(() => {
    if (input.current !== globalThis.document.activeElement) { setRaw(String(value)); setError(''); }
  }, [value]);
  const validateAndApply = (text: string) => {
    const next = Number(text);
    if (!text.trim() || !Number.isFinite(next) || next < limits.min || next > limits.max) {
      setError(`Enter a value from ${limits.min} to ${limits.max}.`); return;
    }
    setError(''); setRaw(String(next));
    if (next !== value) onChange(next);
  };
  return <label className="loc-model-number-field" htmlFor={id}>
    <span>{label}</span><input ref={input} id={id} className="input" type="text" inputMode="decimal" min={limits.min} max={limits.max} step={limits.step} value={raw} disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : `${id}-help`} data-testid={`${prefix}-${field}`}
      onChange={(event) => {
        const text = event.currentTarget.value; setRaw(text); setError('');
        const next = Number(text);
        if (text.trim() && Number.isFinite(next) && next >= limits.min && next <= limits.max) onChange(next);
      }} onBlur={(event) => validateAndApply(event.currentTarget.value)} />
    <small id={`${id}-help`}>{limits.min} to {limits.max} · step {limits.step}</small>
    {error && <small id={`${id}-error`} className="loc-model-field-error" role="alert">{error}</small>}
  </label>;
}
