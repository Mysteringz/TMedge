import { useEffect, useId, useRef, useState } from 'react';
import type { LocationDocument, Point, Table, TableShape, Zone } from '../../../entities/location-config/model/types.ts';
import { changeShapeKind, cmToMetres, metresToCm, setShape, shapeOf } from '../../../features/location-editor/index.ts';
import type { Selection } from './editor-canvas.tsx';
import { generateSeats } from '../../../../../src/shared/seats.ts';

/** Edit the selected zone, table, or seat; `update` receives immutable document transforms in canonical centimetres. */
export function EditorInspector({ document, selected, onSelect, update, onTransientValidityChange }: {
  document: LocationDocument; selected: Selection | null; onSelect(value: Selection): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
}) {
  const zone = selected?.kind === 'zone' ? document.zones.find((item) => item.id === selected.id) : undefined;
  const table = selected?.kind === 'table' ? document.tables.find((item) => item.id === selected.id)
    : selected?.kind === 'seat' ? document.tables.find((item) => item.seats.some((seat) => seat.id === selected.id)) : undefined;
  const seat = selected?.kind === 'seat' ? table?.seats.find((item) => item.id === selected.id) : undefined;
  return <aside className="loc-inspector">
    <h2 id="loc-inspector-heading" className="loc-inspector-heading">{table ? `Table details · ${table.name}` : zone ? `Zone details · ${zone.name}` : 'Table details'}</h2>
    <fieldset className="loc-inspector-selection">
      <legend className="loc-sr">Choose a zone or table</legend>
      <label className="loc-field"><span>Zone</span><select className="input" aria-label="Select zone" data-testid="location-inspector-zone-select" value={zone?.id ?? ''}
        onChange={(event) => { if (event.target.value) onSelect({ kind: 'zone', id: event.target.value }); }}>
        <option value="">Choose zone</option>
        {document.zones.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label className="loc-field"><span>Table</span><select className="input" aria-label="Select table" data-testid="location-inspector-table-select" value={table?.id ?? ''}
        onChange={(event) => { if (event.target.value) onSelect({ kind: 'table', id: event.target.value }); }}>
        <option value="">Choose table</option>
        {document.tables.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </fieldset>
    {zone && <ZoneFields key={zone.id} zone={zone} selectedIndex={selected?.kind === 'zone' && selected.id === zone.id ? selected.index : undefined} onTransientValidityChange={onTransientValidityChange}
      onSelectIndex={(index) => onSelect({ kind: 'zone', id: zone.id, index })} update={update} />}
    {table && <TableFields key={table.id} table={table} document={document} selectedSeat={seat?.id ?? null} onSelect={onSelect} update={update} onTransientValidityChange={onTransientValidityChange} />}
    {!zone && !table && <p className="cx-muted">Select a zone, table, or seat to edit its labelled coordinates.</p>}
    <div className="loc-inspector-block">
      <h2>Zones</h2>
      <ul className="loc-object-list" data-location-field="zones.list" tabIndex={-1}>
        {document.zones.map((item) => <li key={item.id}>
          <button type="button" className="loc-object-button" data-testid={`location-select-zone-${testToken(item.id)}`} aria-pressed={zone?.id === item.id} onClick={() => onSelect({ kind: 'zone', id: item.id })}>{item.name}</button>
        </li>)}
        {!document.zones.length && <li className="cx-muted">No zones yet.</li>}
      </ul>
    </div>
    <div className="loc-inspector-block">
      <h2>Tables</h2>
      <ul className="loc-object-list" data-location-field="tables.list" tabIndex={-1}>
        {document.tables.map((item) => <li key={item.id}>
          <button type="button" className="loc-object-button" data-testid={`location-select-table-${testToken(item.id)}`} aria-pressed={selected?.kind === 'table' && selected.id === item.id} onClick={() => onSelect({ kind: 'table', id: item.id })}>{item.name}</button>
        </li>)}
        {!document.tables.length && <li className="cx-muted">Add your first table.</li>}
      </ul>
    </div>
  </aside>;
}

/** Inspector section for one zone; edits are applied through the parent's immutable document updater. */
function ZoneFields({ zone, selectedIndex, onSelectIndex, update, onTransientValidityChange }: {
  zone: Zone; selectedIndex?: number; onSelectIndex(index: number): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  const verticesDisclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (verticesDisclosure.current) verticesDisclosure.current.open = true; }, [zone.id]);
  return <div className="loc-inspector-block loc-inspector-selected-fields">
    <Field label="Zone name" fieldPath={`zone.${zone.id}.name`} value={zone.name} onChange={(value) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, name: value } : item) }))} />
    <details ref={verticesDisclosure} className="loc-inspector-disclosure">
      <summary>Zone vertices ({zone.polygon.length})</summary>
      <VertexFields label={zone.name} fieldPath={`zone.${zone.id}.polygon`} coordinateFieldPath={`zone.${zone.id}`} points={zone.polygon} selectedIndex={selectedIndex} onSelectIndex={onSelectIndex} onTransientValidityChange={onTransientValidityChange}
        onChange={(points) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, polygon: points } : item) }))} />
    </details>
  </div>;
}

/** Inspector section for a table and its seats; geometry stays canonical in centimetres until displayed as metres. */
function TableFields({ table, document, selectedSeat, onSelect, update, onTransientValidityChange }: {
  table: Table; document: LocationDocument; selectedSeat: string | null; onSelect(value: Selection): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  const shape = shapeOf(table);
  const prefix = `table.${table.id}`;
  const verticesDisclosure = useRef<HTMLDetailsElement>(null);
  const seatsDisclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (shape.type === 'polygon' && verticesDisclosure.current) verticesDisclosure.current.open = true; }, [shape.type, table.id]);
  useEffect(() => { if (selectedSeat && seatsDisclosure.current) seatsDisclosure.current.open = true; }, [selectedSeat, table.id]);
  const patchTable = (change: (table: Table) => Table) => update((doc) => ({ ...doc, tables: doc.tables.map((item) => item.id === table.id ? change(item) : item) }));
  const changeShape = (next: TableShape) => patchTable((item) => setShape(item, next));
  const setNumber = (field: string, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...shape, [field]: value } as TableShape;
    changeShape(next);
  };
  return <div className="loc-inspector-block loc-inspector-selected-fields">
    <Field label="Table name" fieldPath={`${prefix}.name`} value={table.name} onChange={(value) => patchTable((item) => ({ ...item, name: value }))} />
    <label className="loc-field"><span>Table zone</span><select className="input" aria-label="Table zone" data-testid={`location-field-${testToken(`${prefix}.zone`)}`} data-location-field={`${prefix}.zone`} value={table.zoneId} onChange={(event) => patchTable((item) => ({ ...item, zoneId: event.target.value }))}>
      {document.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
    </select></label>
    <label className="loc-field"><span>Table shape</span><select className="input" aria-label="Table shape" data-testid={`location-field-${testToken(`${prefix}.shape`)}`} value={shape.type} onChange={(event) => patchTable((item) => changeShapeKind(item, event.target.value as TableShape['type'], document.widthCm, document.heightCm))}>
      <option value="rect">Rectangle</option><option value="circle">Round</option><option value="polygon">Polygon</option>
    </select></label>
    <Field label="Capacity" fieldPath={`${prefix}.capacity`} type="number" min={1} max={20} step={1} value={String(table.capacity)} onTransientInvalid={(invalid) => onTransientValidityChange(`${prefix}.capacity`, invalid)} onChange={(value) => {
      const capacity = Number(value); if (Number.isInteger(capacity) && capacity >= 1 && capacity <= 20) patchTable((item) => ({ ...item, capacity }));
    }} />
    <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" data-testid={`location-generate-seats-${testToken(table.id)}`} onClick={() => patchTable((item) => ({ ...item, seats: importSeats(item) }))}>Generate seats</button></div>
    {shape.type === 'polygon' && <details ref={verticesDisclosure} className="loc-inspector-disclosure">
      <summary>Polygon vertices ({shape.points.length})</summary>
      <ShapeFields shape={shape} fieldPath={`${prefix}.shape`} onNumber={setNumber} onTransientValidityChange={onTransientValidityChange} onPoints={(points) => changeShape({ type: 'polygon', points })} />
    </details>}
    {shape.type !== 'polygon' && <ShapeFields shape={shape} fieldPath={`${prefix}.shape`} onNumber={setNumber} onTransientValidityChange={onTransientValidityChange} onPoints={(points) => changeShape({ type: 'polygon', points })} />}
    <details ref={seatsDisclosure} className="loc-inspector-disclosure">
      <summary>Seats ({table.seats.length})</summary>
      <ul className="loc-seat-list" data-location-field="seats.list" tabIndex={-1}>
        {table.seats.map((item, index) => <li key={item.id}>
          <button type="button" className="loc-object-button" data-testid={`location-select-seat-${testToken(item.id)}`} data-location-field={`seat.${item.id}.neighbors`} aria-pressed={selectedSeat === item.id} onClick={() => onSelect({ kind: 'seat', id: item.id })}>Seat {index + 1}</button>
          <div className="loc-pair-fields">
            <Field label={`Seat ${index + 1} X (m)`} fieldPath={`seat.${item.id}.x`} type="number" step={0.01} value={String(cmToMetres(item.x))} onTransientInvalid={(invalid) => onTransientValidityChange(`seat.${item.id}.x`, invalid)} onChange={(value) => {
              const x = metresToCm(Number(value)); if (Number.isFinite(x)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, x } : seat) }));
            }} />
            <Field label={`Seat ${index + 1} Y (m)`} fieldPath={`seat.${item.id}.y`} type="number" step={0.01} value={String(cmToMetres(item.y))} onTransientInvalid={(invalid) => onTransientValidityChange(`seat.${item.id}.y`, invalid)} onChange={(value) => {
              const y = metresToCm(Number(value)); if (Number.isFinite(y)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, y } : seat) }));
            }} />
          </div>
        </li>)}
        {!table.seats.length && <li className="cx-muted">No seats assigned.</li>}
      </ul>
    </details>
  </div>;
}

/** Selects the numeric or vertex controls for a tagged table shape; parent callbacks own all document changes. */
function ShapeFields({ shape, fieldPath, onNumber, onTransientValidityChange, onPoints }: {
  shape: TableShape; fieldPath: string; onNumber(field: string, value: number): void;
  onTransientValidityChange(field: string, invalid: boolean): void; onPoints(points: Point[]): void;
}) {
  if (shape.type === 'rect') return <div className="loc-pair-fields">
    <Numeric label="Table X (m)" fieldPath={`${fieldPath}.x`} value={shape.x} onChange={(value) => onNumber('x', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table Y (m)" fieldPath={`${fieldPath}.y`} value={shape.y} onChange={(value) => onNumber('y', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table width (m)" fieldPath={`${fieldPath}.width`} value={shape.width} onChange={(value) => onNumber('width', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table height (m)" fieldPath={`${fieldPath}.height`} value={shape.height} onChange={(value) => onNumber('height', value)} onTransientValidityChange={onTransientValidityChange} />
  </div>;
  if (shape.type === 'circle') return <div className="loc-pair-fields">
    <Numeric label="Circle center X (m)" fieldPath={`${fieldPath}.cx`} value={shape.cx} onChange={(value) => onNumber('cx', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Circle center Y (m)" fieldPath={`${fieldPath}.cy`} value={shape.cy} onChange={(value) => onNumber('cy', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Circle radius (m)" fieldPath={`${fieldPath}.radius`} value={shape.radius} onChange={(value) => onNumber('radius', value)} onTransientValidityChange={onTransientValidityChange} />
  </div>;
  return <VertexFields label="Table" fieldPath={fieldPath} coordinateFieldPath={fieldPath} points={shape.points} onTransientValidityChange={onTransientValidityChange} onChange={onPoints} />;
}

/** Shared vertex editor for table/zone polygons, with optional keyboard-selectable vertex navigation. */
function VertexFields({ label, points, fieldPath, coordinateFieldPath = fieldPath, selectedIndex, onSelectIndex, onChange, onTransientValidityChange }: {
  label: string; points: Point[]; fieldPath?: string; coordinateFieldPath?: string; selectedIndex?: number; onSelectIndex?(index: number): void; onChange(points: Point[]): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
}) {
  const setPoint = (index: number, axis: 0 | 1, value: string) => {
    const number = metresToCm(Number(value)); if (!Number.isFinite(number)) return;
    onChange(points.map((point, i) => i === index ? axis === 0 ? [number, point[1]] : [point[0], number] : [...point]));
  };
  const add = () => {
    const last = points.at(-1) ?? [0, 0];
    const first = points[0] ?? [0, 0];
    onChange([...points, [(last[0] + first[0]) / 2, (last[1] + first[1]) / 2]]);
  };
  return <div className="loc-vertex-editor" role="group" aria-label={`${label} vertices`} data-location-field={fieldPath} tabIndex={-1}>
    <h3>{label === 'Table' ? 'Table vertices (m)' : 'Zone vertices (m)'}</h3>
    <ol className="loc-vertex-list">
      {points.map(([x, y], index) => <li key={index}>
        {onSelectIndex ? <button type="button" className="loc-vertex-select" data-testid={`location-select-vertex-${testToken(`${coordinateFieldPath ?? label}-${index + 1}`)}`} aria-label={`Select ${label} vertex ${index + 1}`}
          aria-pressed={selectedIndex === index} onClick={() => onSelectIndex(index)}>Vertex {index + 1}</button> : <span>Vertex {index + 1}</span>}
        <div className="loc-pair-fields">
          <Field label={`${label} vertex ${index + 1} X (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.x` : undefined} type="number" step={0.01} value={String(cmToMetres(x))} onTransientInvalid={(invalid) => onTransientValidityChange(`${coordinateFieldPath ?? label}.vertex.${index}.x`, invalid)} onChange={(value) => setPoint(index, 0, value)} />
          <Field label={`${label} vertex ${index + 1} Y (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.y` : undefined} type="number" step={0.01} value={String(cmToMetres(y))} onTransientInvalid={(invalid) => onTransientValidityChange(`${coordinateFieldPath ?? label}.vertex.${index}.y`, invalid)} onChange={(value) => setPoint(index, 1, value)} />
        </div>
        <button type="button" className="btn btn-ghost" data-testid={`location-remove-vertex-${testToken(`${fieldPath ?? label}-${index + 1}`)}`} disabled={points.length <= 3} onClick={() => onChange(points.filter((_, i) => i !== index))}>Remove vertex {index + 1}</button>
      </li>)}
    </ol>
    <button type="button" className="btn btn-secondary" data-testid={`location-add-vertex-${testToken(fieldPath ?? label)}`} onClick={add}>Add vertex</button>
  </div>;
}

/** Inspector input; numeric text remains raw during typing and commits through `onChange` on blur. */
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
    if (globalThis.document.activeElement?.getAttribute('data-location-field') !== fieldPath) {
      setRaw(value); setFieldError(''); onTransientInvalid?.(false);
    }
  }, [value, fieldPath]);
  const rawValid = !deferredNumber || validNumberText(raw, min, max, step);
  return <label className="loc-field"><span>{label}</span><input className="input" aria-label={label} data-testid={`location-field-${testToken(fieldPath ?? label)}`} data-location-field={fieldPath}
    data-local-invalid={fieldError || !rawValid ? 'true' : undefined} aria-invalid={fieldError || !rawValid ? true : undefined} aria-describedby={fieldError ? id : undefined}
    type={deferredNumber ? 'text' : type} inputMode={deferredNumber ? 'decimal' : undefined} value={raw}
    min={deferredNumber ? undefined : min} max={deferredNumber ? undefined : max} step={deferredNumber ? undefined : step}
    onChange={(event) => {
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

/** Displays a canonical centimetre value in metres and converts it once when the inspector field commits. */
function Numeric({ label, value, fieldPath, onChange, onTransientValidityChange }: {
  label: string; value: number; fieldPath: string; onChange(value: number): void; onTransientValidityChange(field: string, invalid: boolean): void;
}) {
  return <Field label={label} fieldPath={fieldPath} type="number" step={0.01} value={String(cmToMetres(value))} onTransientInvalid={(invalid) => onTransientValidityChange(fieldPath, invalid)} onChange={(next) => { const number = metresToCm(Number(next)); if (Number.isFinite(number)) onChange(number); }} />;
}

function importSeats(table: Table): Table['seats'] {
  return generateSeats(table.id, shapeOf(table), table.capacity);
}

function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function validNumberText(text: string, min?: number, max?: number, step?: number): boolean {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return false;
  const parsed = Number(text);
  return Number.isFinite(parsed) && (min === undefined || parsed >= min) && (max === undefined || parsed <= max)
    && (step === undefined || min === undefined || Math.abs((parsed - min) / step - Math.round((parsed - min) / step)) <= 1e-7);
}
