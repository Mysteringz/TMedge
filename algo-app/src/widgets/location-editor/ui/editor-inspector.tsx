import { useEffect, useId, useState } from 'react';
import type { LocationDocument, Point, Table, TableShape, Zone } from '../../../entities/location-config/model/types.ts';
import { changeShapeKind, cmToMetres, metresToCm, setShape, shapeOf } from '../../../features/location-editor/index.ts';
import type { Selection } from './editor-canvas.tsx';
import { generateSeats } from '../../../../../src/shared/seats.ts';

/** Edit the selected zone, table, or seat; `update` receives immutable document transforms in canonical centimetres. */
export function EditorInspector({ document, selected, onSelect, update }: {
  document: LocationDocument; selected: Selection | null; onSelect(value: Selection): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  const zone = selected?.kind === 'zone' ? document.zones.find((item) => item.id === selected.id) : undefined;
  const table = selected?.kind === 'table' ? document.tables.find((item) => item.id === selected.id)
    : selected?.kind === 'seat' ? document.tables.find((item) => item.seats.some((seat) => seat.id === selected.id)) : undefined;
  const seat = selected?.kind === 'seat' ? table?.seats.find((item) => item.id === selected.id) : undefined;
  return <aside className="loc-inspector" aria-label="Selected item editor">
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
    {zone && <ZoneFields zone={zone} selectedIndex={selected?.kind === 'zone' && selected.id === zone.id ? selected.index : undefined}
      onSelectIndex={(index) => onSelect({ kind: 'zone', id: zone.id, index })} update={update} />}
    {table && <TableFields table={table} document={document} selectedSeat={seat?.id ?? null} onSelect={onSelect} update={update} />}
    {!zone && !table && <p className="cx-muted">Select a zone, table, or seat to edit its labelled coordinates.</p>}
  </aside>;
}

/** Inspector section for one zone; edits are applied through the parent's immutable document updater. */
function ZoneFields({ zone, selectedIndex, onSelectIndex, update }: {
  zone: Zone; selectedIndex?: number; onSelectIndex(index: number): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  return <div className="loc-inspector-block">
    <h2>Zone details</h2>
    <Field label="Zone name" fieldPath={`zone.${zone.id}.name`} value={zone.name} onChange={(value) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, name: value } : item) }))} />
    <h3>Zone vertices (m)</h3>
    <VertexFields label={zone.name} fieldPath={`zone.${zone.id}.polygon`} coordinateFieldPath={`zone.${zone.id}`} points={zone.polygon} selectedIndex={selectedIndex} onSelectIndex={onSelectIndex}
      onChange={(points) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, polygon: points } : item) }))} />
  </div>;
}

/** Inspector section for a table and its seats; geometry stays canonical in centimetres until displayed as metres. */
function TableFields({ table, document, selectedSeat, onSelect, update }: {
  table: Table; document: LocationDocument; selectedSeat: string | null; onSelect(value: Selection): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  const shape = shapeOf(table);
  const prefix = `table.${table.id}`;
  const patchTable = (change: (table: Table) => Table) => update((doc) => ({ ...doc, tables: doc.tables.map((item) => item.id === table.id ? change(item) : item) }));
  const changeShape = (next: TableShape) => patchTable((item) => setShape(item, next));
  const setNumber = (field: string, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...shape, [field]: value } as TableShape;
    changeShape(next);
  };
  return <div className="loc-inspector-block">
    <h2>Table details</h2>
    <Field label="Table name" fieldPath={`${prefix}.name`} value={table.name} onChange={(value) => patchTable((item) => ({ ...item, name: value }))} />
    <label className="loc-field"><span>Table zone</span><select className="input" aria-label="Table zone" data-testid={`location-field-${testToken(`${prefix}.zone`)}`} data-location-field={`${prefix}.zone`} value={table.zoneId} onChange={(event) => patchTable((item) => ({ ...item, zoneId: event.target.value }))}>
      {document.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
    </select></label>
    <label className="loc-field"><span>Table shape</span><select className="input" aria-label="Table shape" data-testid={`location-field-${testToken(`${prefix}.shape`)}`} value={shape.type} onChange={(event) => patchTable((item) => changeShapeKind(item, event.target.value as TableShape['type'], document.widthCm, document.heightCm))}>
      <option value="rect">Rectangle</option><option value="circle">Round</option><option value="polygon">Polygon</option>
    </select></label>
    <Field label="Capacity" fieldPath={`${prefix}.capacity`} type="number" min={1} max={20} step={1} value={String(table.capacity)} onChange={(value) => {
      const capacity = Number(value); if (Number.isInteger(capacity) && capacity >= 1 && capacity <= 20) patchTable((item) => ({ ...item, capacity }));
    }} />
    <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" data-testid={`location-generate-seats-${testToken(table.id)}`} onClick={() => patchTable((item) => ({ ...item, seats: importSeats(item) }))}>Generate seats</button></div>
    <ShapeFields shape={shape} fieldPath={`${prefix}.shape`} onNumber={setNumber} onPoints={(points) => changeShape({ type: 'polygon', points })} />
    <h3>Seats · metres</h3>
    <ul className="loc-seat-list" data-location-field="seats.list" tabIndex={-1}>
      {table.seats.map((item, index) => <li key={item.id}>
        <button type="button" className="loc-object-button" data-testid={`location-select-seat-${testToken(item.id)}`} data-location-field={`seat.${item.id}.neighbors`} aria-pressed={selectedSeat === item.id} onClick={() => onSelect({ kind: 'seat', id: item.id })}>Seat {index + 1}</button>
        <div className="loc-pair-fields">
          <Field label={`Seat ${index + 1} X (m)`} fieldPath={`seat.${item.id}.x`} type="number" step={0.01} value={String(cmToMetres(item.x))} onChange={(value) => {
            const x = metresToCm(Number(value)); if (Number.isFinite(x)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, x } : seat) }));
          }} />
          <Field label={`Seat ${index + 1} Y (m)`} fieldPath={`seat.${item.id}.y`} type="number" step={0.01} value={String(cmToMetres(item.y))} onChange={(value) => {
            const y = metresToCm(Number(value)); if (Number.isFinite(y)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, y } : seat) }));
          }} />
        </div>
      </li>)}
    </ul>
  </div>;
}

/** Selects the numeric or vertex controls for a tagged table shape; parent callbacks own all document changes. */
function ShapeFields({ shape, fieldPath, onNumber, onPoints }: { shape: TableShape; fieldPath: string; onNumber(field: string, value: number): void; onPoints(points: Point[]): void }) {
  if (shape.type === 'rect') return <div className="loc-pair-fields">
    <Numeric label="Table X (m)" fieldPath={`${fieldPath}.x`} value={shape.x} onChange={(value) => onNumber('x', value)} />
    <Numeric label="Table Y (m)" fieldPath={`${fieldPath}.y`} value={shape.y} onChange={(value) => onNumber('y', value)} />
    <Numeric label="Table width (m)" fieldPath={`${fieldPath}.width`} value={shape.width} onChange={(value) => onNumber('width', value)} />
    <Numeric label="Table height (m)" fieldPath={`${fieldPath}.height`} value={shape.height} onChange={(value) => onNumber('height', value)} />
  </div>;
  if (shape.type === 'circle') return <div className="loc-pair-fields">
    <Numeric label="Circle center X (m)" fieldPath={`${fieldPath}.cx`} value={shape.cx} onChange={(value) => onNumber('cx', value)} />
    <Numeric label="Circle center Y (m)" fieldPath={`${fieldPath}.cy`} value={shape.cy} onChange={(value) => onNumber('cy', value)} />
    <Numeric label="Circle radius (m)" fieldPath={`${fieldPath}.radius`} value={shape.radius} onChange={(value) => onNumber('radius', value)} />
  </div>;
  return <VertexFields label="Table" fieldPath={fieldPath} coordinateFieldPath={fieldPath} points={shape.points} onChange={onPoints} />;
}

/** Shared vertex editor for table/zone polygons, with optional keyboard-selectable vertex navigation. */
function VertexFields({ label, points, fieldPath, coordinateFieldPath = fieldPath, selectedIndex, onSelectIndex, onChange }: {
  label: string; points: Point[]; fieldPath?: string; coordinateFieldPath?: string; selectedIndex?: number; onSelectIndex?(index: number): void; onChange(points: Point[]): void;
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
          <Field label={`${label} vertex ${index + 1} X (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.x` : undefined} type="number" step={0.01} value={String(cmToMetres(x))} onChange={(value) => setPoint(index, 0, value)} />
          <Field label={`${label} vertex ${index + 1} Y (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.y` : undefined} type="number" step={0.01} value={String(cmToMetres(y))} onChange={(value) => setPoint(index, 1, value)} />
        </div>
        <button type="button" className="btn btn-ghost" data-testid={`location-remove-vertex-${testToken(`${fieldPath ?? label}-${index + 1}`)}`} disabled={points.length <= 3} onClick={() => onChange(points.filter((_, i) => i !== index))}>Remove vertex {index + 1}</button>
      </li>)}
    </ol>
    <button type="button" className="btn btn-secondary" data-testid={`location-add-vertex-${testToken(fieldPath ?? label)}`} onClick={add}>Add vertex</button>
  </div>;
}

/** Inspector input; numeric text remains raw during typing and commits through `onChange` on blur. */
function Field({ label, value, onChange, type = 'text', min, max, step, fieldPath }: {
  label: string; value: string; onChange(value: string): void; type?: string; min?: number; max?: number; step?: number; fieldPath?: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value);
  const [fieldError, setFieldError] = useState('');
  useEffect(() => { setRaw(value); setFieldError(''); }, [value]);
  const deferredNumber = type === 'number';
  return <label className="loc-field"><span>{label}</span><input className="input" aria-label={label} data-testid={`location-field-${testToken(fieldPath ?? label)}`} data-location-field={fieldPath} aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? id : undefined}
    type={deferredNumber ? 'text' : type} inputMode={deferredNumber ? 'decimal' : undefined} value={raw}
    min={deferredNumber ? undefined : min} max={deferredNumber ? undefined : max} step={deferredNumber ? undefined : step}
    onChange={(event) => { setRaw(event.target.value); setFieldError(''); if (!deferredNumber) onChange(event.target.value); }}
    onBlur={() => {
      if (!deferredNumber) return;
      const parsed = Number(raw);
      if (!raw.trim() || !Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)
        || (step !== undefined && min !== undefined && Math.abs((parsed - min) / step - Math.round((parsed - min) / step)) > 1e-7)) {
        setFieldError(min !== undefined && max !== undefined ? `Enter a number from ${min} to ${max}.` : 'Enter a valid number.');
        return;
      }
      setFieldError(''); onChange(raw);
    }} />{fieldError && <small className="loc-field-error" id={id} role="alert">{fieldError}</small>}</label>;
}

/** Displays a canonical centimetre value in metres and converts it once when the inspector field commits. */
function Numeric({ label, value, fieldPath, onChange }: { label: string; value: number; fieldPath: string; onChange(value: number): void }) {
  return <Field label={label} fieldPath={fieldPath} type="number" step={0.01} value={String(cmToMetres(value))} onChange={(next) => { const number = metresToCm(Number(next)); if (Number.isFinite(number)) onChange(number); }} />;
}

function importSeats(table: Table): Table['seats'] {
  return generateSeats(table.id, shapeOf(table), table.capacity);
}

function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
