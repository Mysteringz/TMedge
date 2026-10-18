import { Plus, Trash } from '../../../console/icons.tsx';
import { bottomYMetres, canonicalY } from '../../../features/location-editor/model/display-coordinates.ts';
import { useEffect, useId, useRef, useState } from 'react';
import type { FurnitureLibraryItem, FurnitureType, LocationDocument, Point, Table, TableShape, Zone } from '../../../entities/location-config/model/types.ts';
import { changeShapeKind, cmToMetres, metresToCm, setShape, shapeOf, translateTable } from '../../../features/location-editor/index.ts';
import { TableFurnitureOverrides } from '../../../features/location-furniture-models/index.ts';
import type { Selection } from './editor-canvas.tsx';
import { generateSeats } from '../../../../../src/shared/seats.ts';
import { useCompactLayout } from '../model/use-compact-layout.ts';

/** Edit the selected zone, table, or seat; `update` receives immutable document transforms in canonical centimetres. */
export function EditorInspector({ document, selected, onSelect, update, onTransientValidityChange, furnitureItems, furnitureSource, onOpenFurnitureLibrary, onShowCanvas }: {
  document: LocationDocument; selected: Selection | null; onSelect(value: Selection): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
  furnitureSource: 'generated' | 'custom' | 'other';
  furnitureItems: ReadonlyMap<string, FurnitureLibraryItem>; onOpenFurnitureLibrary(type: FurnitureType, tableId: string): void;
  onShowCanvas(): void;
}) {
  const zone = selected?.kind === 'zone' ? document.zones.find((item) => item.id === selected.id) : undefined;
  const table = selected?.kind === 'table' ? document.tables.find((item) => item.id === selected.id)
    : selected?.kind === 'seat' ? document.tables.find((item) => item.seats.some((seat) => seat.id === selected.id)) : undefined;
  const seat = selected?.kind === 'seat' ? table?.seats.find((item) => item.id === selected.id) : undefined;
  return <aside className="loc-inspector">
    <header className="loc-inspector-header">
      <h2 id="loc-inspector-heading" className="loc-inspector-heading">{table ? 'Edit table' : zone ? 'Edit zone' : 'Edit layout'}</h2>
      <p>{zone ? 'Update the zone details and boundary.' : table ? 'Update the table, shape and seats.' : 'Choose a zone or table to edit its details.'}</p>
      <button type="button" className="btn btn-ghost loc-mobile-canvas-link" onClick={onShowCanvas}>Back to canvas</button>
    </header>
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
    {zone && <ZoneFields key={zone.id} zone={zone} roomHeight={document.heightCm} selectedIndex={selected?.kind === 'zone' && selected.id === zone.id ? selected.index : undefined} onTransientValidityChange={onTransientValidityChange}
      onSelectIndex={(index) => onSelect({ kind: 'zone', id: zone.id, index })} update={update} />}
    {table && <TableFields key={table.id} table={table} document={document} selectedSeat={seat?.id ?? null} onSelect={onSelect} update={update} onTransientValidityChange={onTransientValidityChange}
      furnitureItems={furnitureItems} furnitureSource={furnitureSource} onOpenFurnitureLibrary={onOpenFurnitureLibrary} />}
    {!zone && !table && <p className="cx-muted">Select a zone, table, or seat to edit its labelled coordinates.</p>}
    <details className="loc-inspector-disclosure" data-testid="location-room-objects">
      <summary>Room objects · {document.zones.length} {document.zones.length === 1 ? 'zone' : 'zones'}, {document.tables.length} {document.tables.length === 1 ? 'table' : 'tables'}</summary>
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
    </details>
  </aside>;
}

/** Inspector section for one zone; edits are applied through the parent's immutable document updater. */
function ZoneFields({ zone, roomHeight, selectedIndex, onSelectIndex, update, onTransientValidityChange }: {
  zone: Zone; roomHeight: number; selectedIndex?: number; onSelectIndex(index: number): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
}) {
  return <div className="loc-inspector-block loc-inspector-selected-fields">
    <Field label="Zone name" fieldPath={`zone.${zone.id}.name`} value={zone.name} onChange={(value) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, name: value } : item) }))} />
      <VertexFields roomHeight={roomHeight} label={zone.name} fieldPath={`zone.${zone.id}.polygon`} coordinateFieldPath={`zone.${zone.id}`} points={zone.polygon} selectedIndex={selectedIndex} onSelectIndex={onSelectIndex} onTransientValidityChange={onTransientValidityChange}
        onChange={(points) => update((doc) => ({ ...doc, zones: doc.zones.map((item) => item.id === zone.id ? { ...item, polygon: points } : item) }))} />
  </div>;
}

/** Inspector section for a table and its seats; geometry stays canonical in centimetres until displayed as metres. */
function TableFields({ table, document, selectedSeat, onSelect, update, onTransientValidityChange, furnitureItems, furnitureSource, onOpenFurnitureLibrary }: {
  table: Table; document: LocationDocument; selectedSeat: string | null; onSelect(value: Selection): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
  update(change: (current: LocationDocument) => LocationDocument): void;
  furnitureItems: ReadonlyMap<string, FurnitureLibraryItem>; furnitureSource: 'generated' | 'custom' | 'other'; onOpenFurnitureLibrary(type: FurnitureType, tableId: string): void;
}) {
  const shape = shapeOf(table);
  const compact = useCompactLayout();
  const prefix = `table.${table.id}`;
  const verticesDisclosure = useRef<HTMLDetailsElement>(null);
  const seatsDisclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (shape.type === 'polygon' && verticesDisclosure.current) verticesDisclosure.current.open = true; }, [shape.type, table.id]);
  useEffect(() => { if (selectedSeat && seatsDisclosure.current) seatsDisclosure.current.open = true; }, [selectedSeat, table.id]);
  const patchTable = (change: (table: Table) => Table) => update((doc) => ({ ...doc, tables: doc.tables.map((item) => item.id === table.id ? change(item) : item) }));
  const changeShape = (next: TableShape) => patchTable((item) => setShape(item, next));
  const setNumber = (field: string, value: number) => {
    if (!Number.isFinite(value)) return;
    if (shape.type === 'rect' && (field === 'x' || field === 'y')) {
      patchTable((item) => translateTable(item, field === 'x' ? value - shape.x : 0, field === 'y' ? value - shape.y : 0));
      return;
    }
    if (shape.type === 'circle' && (field === 'cx' || field === 'cy')) {
      patchTable((item) => translateTable(item, field === 'cx' ? value - shape.cx : 0, field === 'cy' ? value - shape.cy : 0));
      return;
    }
    const next = { ...shape, [field]: value, ...(shape.type === 'rect' && field === 'height' ? { y: shape.y + shape.height - value } : {}) } as TableShape;
    changeShape(next);
  };
  return <div className="loc-inspector-block loc-inspector-selected-fields">
    <div className="loc-table-basics">
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
    </div>
    <div className="loc-inline-actions"><button type="button" className="btn btn-secondary" data-testid={`location-generate-seats-${testToken(table.id)}`} onClick={() => patchTable((item) => ({ ...item, seats: importSeats(item) }))}>Generate seats</button></div>
    {shape.type === 'polygon' && <details ref={verticesDisclosure} className="loc-inspector-disclosure">
      <summary>Polygon vertices ({shape.points.length})</summary>
      <ShapeFields roomHeight={document.heightCm} shape={shape} fieldPath={`${prefix}.shape`} onNumber={setNumber} onTransientValidityChange={onTransientValidityChange} onPoints={(points) => changeShape({ type: 'polygon', points })} />
    </details>}
    {shape.type !== 'polygon' && <details className="loc-inspector-disclosure" open={!compact} data-testid="location-table-position">
      <summary>Position &amp; size</summary>
      <ShapeFields roomHeight={document.heightCm} shape={shape} fieldPath={`${prefix}.shape`} onNumber={setNumber} onTransientValidityChange={onTransientValidityChange} onPoints={(points) => changeShape({ type: 'polygon', points })} />
    </details>}
    <details ref={seatsDisclosure} className="loc-inspector-disclosure">
      <summary>Seats ({table.seats.length})</summary>
      <ul className="loc-seat-list" data-location-field="seats.list" tabIndex={-1}>
        {table.seats.map((item, index) => <li key={item.id}>
          <button type="button" className="loc-object-button" data-testid={`location-select-seat-${testToken(item.id)}`} data-location-field={`seat.${item.id}.neighbors`} aria-pressed={selectedSeat === item.id} onClick={() => onSelect({ kind: 'seat', id: item.id })}>Seat {index + 1}</button>
          <div className="loc-pair-fields">
            <Field label={`Seat ${index + 1} X (m)`} fieldPath={`seat.${item.id}.x`} type="number" step={0.01} value={String(cmToMetres(item.x))} onTransientInvalid={(invalid) => onTransientValidityChange(`seat.${item.id}.x`, invalid)} onChange={(value) => {
              const x = metresToCm(Number(value)); if (Number.isFinite(x)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, x } : seat) }));
            }} />
            <Field label={`Seat ${index + 1} Y (m)`} fieldPath={`seat.${item.id}.y`} type="number" step={0.01} value={String(bottomYMetres(item.y, document.heightCm))} onTransientInvalid={(invalid) => onTransientValidityChange(`seat.${item.id}.y`, invalid)} onChange={(value) => {
              const y = canonicalY(Number(value), document.heightCm, item.y); if (Number.isFinite(y)) patchTable((current) => ({ ...current, seats: current.seats.map((seat) => seat.id === item.id ? { ...seat, y } : seat) }));
            }} />
          </div>
        </li>)}
        {!table.seats.length && <li className="cx-muted">No seats assigned.</li>}
      </ul>
    </details>
    <details className="loc-inspector-disclosure" data-testid="location-table-furniture-options">
      <summary>3D furniture · optional</summary>
      <TableFurnitureOverrides document={document} table={table} items={furnitureItems} disabled={false} source={furnitureSource} onUpdate={update}
        onOpenLibrary={(type) => onOpenFurnitureLibrary(type, table.id)} />
    </details>
  </div>;
}

/** Selects the numeric or vertex controls for a tagged table shape; parent callbacks own all document changes. */
function ShapeFields({ shape, roomHeight, fieldPath, onNumber, onTransientValidityChange, onPoints }: {
  shape: TableShape; roomHeight: number; fieldPath: string; onNumber(field: string, value: number): void;
  onTransientValidityChange(field: string, invalid: boolean): void; onPoints(points: Point[]): void;
}) {
  if (shape.type === 'rect') return <div className="loc-pair-fields">
    <Numeric label="Table X (m)" fieldPath={`${fieldPath}.x`} value={shape.x} onChange={(value) => onNumber('x', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table Y (m)" fieldPath={`${fieldPath}.y`} value={shape.y} roomHeight={roomHeight} objectHeight={shape.height} onChange={(value) => onNumber('y', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table width (m)" fieldPath={`${fieldPath}.width`} value={shape.width} onChange={(value) => onNumber('width', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Table height (m)" fieldPath={`${fieldPath}.height`} value={shape.height} onChange={(value) => onNumber('height', value)} onTransientValidityChange={onTransientValidityChange} />
  </div>;
  if (shape.type === 'circle') return <div className="loc-pair-fields">
    <Numeric label="Circle center X (m)" fieldPath={`${fieldPath}.cx`} value={shape.cx} onChange={(value) => onNumber('cx', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Circle center Y (m)" fieldPath={`${fieldPath}.cy`} value={shape.cy} roomHeight={roomHeight} onChange={(value) => onNumber('cy', value)} onTransientValidityChange={onTransientValidityChange} />
    <Numeric label="Circle radius (m)" fieldPath={`${fieldPath}.radius`} value={shape.radius} onChange={(value) => onNumber('radius', value)} onTransientValidityChange={onTransientValidityChange} />
  </div>;
  return <VertexFields roomHeight={roomHeight} label="Table" fieldPath={fieldPath} coordinateFieldPath={fieldPath} points={shape.points} onTransientValidityChange={onTransientValidityChange} onChange={onPoints} />;
}

/** Shared vertex editor for table/zone polygons, with optional keyboard-selectable vertex navigation. */
function VertexFields({ label, points, roomHeight, fieldPath, coordinateFieldPath = fieldPath, selectedIndex, onSelectIndex, onChange, onTransientValidityChange }: {
  label: string; points: Point[]; roomHeight: number; fieldPath?: string; coordinateFieldPath?: string; selectedIndex?: number; onSelectIndex?(index: number): void; onChange(points: Point[]): void;
  onTransientValidityChange(field: string, invalid: boolean): void;
}) {
  const setPoint = (index: number, axis: 0 | 1, value: string) => {
    const number = axis === 1 ? canonicalY(Number(value), roomHeight, points[index]?.[1]) : metresToCm(Number(value)); if (!Number.isFinite(number)) return;
    onChange(points.map((point, i) => i === index ? axis === 0 ? [number, point[1]] : [point[0], number] : [...point]));
  };
  const add = () => {
    const last = points.at(-1) ?? [0, 0];
    const first = points[0] ?? [0, 0];
    onChange([...points, [(last[0] + first[0]) / 2, (last[1] + first[1]) / 2]]);
  };
  return <div className="loc-vertex-editor" role="group" aria-label={`${label} vertices`} data-location-field={fieldPath} tabIndex={-1}>
    <div className="loc-boundary-heading"><h3>Boundary</h3><span>{points.length} corners</span></div>
    <p className="loc-boundary-help">Enter coordinates in metres, in order around the boundary.</p>
    <table className="loc-boundary-table">
      <caption className="loc-sr">{label} boundary coordinates</caption>
      <colgroup><col className="loc-boundary-index-col" /><col /><col /><col className="loc-boundary-action-col" /></colgroup>
      <thead><tr><th scope="col">Corner</th><th scope="col">X (m)</th><th scope="col">Y (m)</th><th scope="col"><span className="loc-sr">Actions</span></th></tr></thead>
      <tbody>
        {points.map(([x, y], index) => <tr key={index}>
          <th scope="row">{onSelectIndex ? <button type="button" className="loc-vertex-select" data-testid={`location-select-vertex-${testToken(`${coordinateFieldPath ?? label}-${index + 1}`)}`} aria-label={`Select ${label} vertex ${index + 1}`}
            aria-pressed={selectedIndex === index} onClick={() => onSelectIndex(index)}>{index + 1}</button> : <span className="loc-corner-number">{index + 1}</span>}</th>
          <td><Field hideLabel label={`${label} vertex ${index + 1} X (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.x` : undefined} type="number" step={0.01} value={String(cmToMetres(x))} onTransientInvalid={(invalid) => onTransientValidityChange(`${coordinateFieldPath ?? label}.vertex.${index}.x`, invalid)} onChange={(value) => setPoint(index, 0, value)} /></td>
          <td><Field hideLabel label={`${label} vertex ${index + 1} Y (m)`} fieldPath={coordinateFieldPath ? `${coordinateFieldPath}.vertex.${index}.y` : undefined} type="number" step={0.01} value={String(bottomYMetres(y, roomHeight))} onTransientInvalid={(invalid) => onTransientValidityChange(`${coordinateFieldPath ?? label}.vertex.${index}.y`, invalid)} onChange={(value) => setPoint(index, 1, value)} /></td>
          <td><button type="button" className="btn btn-ghost loc-boundary-remove" aria-label={`Remove corner ${index + 1}`} title={points.length <= 3 ? 'A boundary needs at least three corners' : `Remove corner ${index + 1}`} data-testid={`location-remove-vertex-${testToken(`${fieldPath ?? label}-${index + 1}`)}`} disabled={points.length <= 3} onClick={() => onChange(points.filter((_, i) => i !== index))}><Trash /></button></td>
        </tr>)}
      </tbody>
    </table>
    <button type="button" className="btn btn-secondary loc-boundary-add" data-testid={`location-add-vertex-${testToken(fieldPath ?? label)}`} onClick={add}><Plus /> Add corner</button>
  </div>;
}

/** Inspector input; numeric text remains raw during typing and commits through `onChange` on blur. */
function Field({ label, value, onChange, type = 'text', min, max, step, fieldPath, onTransientInvalid, hideLabel = false }: {
  label: string; value: string; onChange(value: string): void; type?: string; min?: number; max?: number; step?: number; fieldPath?: string;
  onTransientInvalid?(invalid: boolean): void; hideLabel?: boolean;
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
  return <label className="loc-field"><span className={hideLabel ? 'loc-sr' : undefined}>{label}</span><input className="input" aria-label={label} data-testid={`location-field-${testToken(fieldPath ?? label)}`} data-location-field={fieldPath}
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
function Numeric({ label, value, roomHeight, objectHeight = 0, fieldPath, onChange, onTransientValidityChange }: {
  label: string; value: number; roomHeight?: number; objectHeight?: number; fieldPath: string; onChange(value: number): void; onTransientValidityChange(field: string, invalid: boolean): void;
}) {
  return <Field label={label} fieldPath={fieldPath} type="number" step={0.01} value={String(roomHeight === undefined ? cmToMetres(value) : bottomYMetres(value, roomHeight, objectHeight))} onTransientInvalid={(invalid) => onTransientValidityChange(fieldPath, invalid)} onChange={(next) => { const number = roomHeight === undefined ? metresToCm(Number(next)) : canonicalY(Number(next), roomHeight, value, objectHeight); if (Number.isFinite(number)) onChange(number); }} />;
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
