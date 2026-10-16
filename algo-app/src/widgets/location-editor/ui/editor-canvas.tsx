import { canvasMetrics, fitCanvasView } from '../../../features/location-editor/model/canvas-metrics.ts';
import { CanvasGrid, CanvasRulers } from './canvas-rulers.tsx';
import { useEffect, useRef, useState } from 'react';
import type { LocationDocument, Point, Table } from '../../../entities/location-config/model/types.ts';
import { shapeOf } from '../../../features/location-editor/index.ts';

export interface Selection { kind: 'zone' | 'table' | 'seat'; id: string; index?: number }
export interface Drawing { kind: 'zone' | 'polygon-table'; points: Point[] }
export interface DragStart { kind: Selection['kind'] | 'zone-vertex'; id: string; index?: number; x: number; y: number; document: LocationDocument }
export interface SensorMarker { uid: string; label: string; x: number; y: number; stale: boolean; movable: boolean }

/** Controlled geometry canvas in centimetres; `LocationEditor` owns mutations and supplies an authorized plan preview URL. */
export function EditorCanvas({ document, selected, drawing, planUrl, sensors = [], selectedSensorUid, coverageStatus = {}, onSensorSelect, onSensorMove, onSensorNudge, onSelect, onSketchPoint, onDragStart, onDragTo, onDragEnd, onNudge, onFinishDrawing, onCancelDrawing }: {
  document: LocationDocument; selected: Selection | null; drawing: Drawing | null; planUrl: string | null;
  sensors?: SensorMarker[]; selectedSensorUid?: string; coverageStatus?: Record<string, 'none' | 'partial' | 'full' | 'unknown'>;
  onSensorSelect?(uid: string): void; onSensorMove?(uid: string, xCm: number, yCm: number): void; onSensorNudge?(dx: number, dy: number): void;
  onSelect(selection: Selection): void; onSketchPoint(point: Point): void;
  onDragStart(drag: DragStart): void; onDragTo(point: Point): void; onDragEnd(): void;
  onNudge(dx: number, dy: number): void; onFinishDrawing(): void; onCancelDrawing(): void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    // Measure the SVG content box, excluding its border; both rulers and grid
    // must use the renderer's real aspect-ratio scale after every resize.
    const measure = () => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      setCanvasSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const drag = useRef<DragStart | null>(null);
  const sensorDrag = useRef<string | null>(null);
  const pan = useRef<{ clientX: number; clientY: number; x: number; y: number; width: number; height: number; a: number; b: number; c: number; d: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState(() => fitCanvasView(document.widthCm, document.heightCm));
  const [keyboardCursor, setKeyboardCursor] = useState<Point>([document.widthCm / 2, document.heightCm / 2]);
  useEffect(() => {
    setZoom(1);
    setView(fitCanvasView(document.widthCm, document.heightCm));
  }, [document.widthCm, document.heightCm]);
  useEffect(() => {
    if (drawing) setKeyboardCursor(drawing.points.at(-1) ?? [document.widthCm / 2, document.heightCm / 2]);
  }, [drawing?.kind, drawing?.points.length, document.widthCm, document.heightCm]);
  const toFloor = (clientX: number, clientY: number): Point => {
    const element = svg.current;
    const matrix = element?.getScreenCTM();
    if (!element || !matrix) return [0, 0];
    const point = element.createSVGPoint(); point.x = clientX; point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return [round(local.x), round(local.y)];
  };
  const beginDrag = (event: React.PointerEvent<SVGElement>, kind: DragStart['kind'], id: string, index?: number) => {
    if (drawing) return;
    event.preventDefault(); event.stopPropagation();
    const point = toFloor(event.clientX, event.clientY);
    const descriptor = { kind, id, ...(index === undefined ? {} : { index }), x: point[0], y: point[1], document: structuredClone(document) };
    drag.current = descriptor;
    onDragStart(descriptor);
    onSelect(kind === 'zone-vertex' ? { kind: 'zone', id, index } : { kind, id } as Selection);
    svg.current?.focus();
    svg.current?.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (sensorDrag.current) { onSensorMove?.(sensorDrag.current, ...toFloor(event.clientX, event.clientY)); return; }
    if (drag.current) { onDragTo(toFloor(event.clientX, event.clientY)); return; }
    const started = pan.current;
    if (!started) return;
    const deltaX = event.clientX - started.clientX, deltaY = event.clientY - started.clientY;
    const floorDeltaX = started.a * deltaX + started.c * deltaY;
    const floorDeltaY = started.b * deltaX + started.d * deltaY;
    const fit = fitCanvasView(document.widthCm, document.heightCm);
    const x = Math.max(fit.x, Math.min(fit.x + fit.width - started.width, started.x - floorDeltaX));
    const y = Math.max(fit.y, Math.min(fit.y + fit.height - started.height, started.y - floorDeltaY));
    setView((current) => ({ ...current, x, y }));
  };
  const pointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    sensorDrag.current = null;
    if (drag.current) { drag.current = null; onDragEnd(); }
    pan.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  };
  const pointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drawing || (event.target as Element).closest('[data-drag-kind]')) return;
    const matrix = svg.current?.getScreenCTM(); if (!matrix) return;
    const screenToFloor = matrix.inverse();
    event.preventDefault();
    pan.current = { clientX: event.clientX, clientY: event.clientY, ...view, a: screenToFloor.a, b: screenToFloor.b, c: screenToFloor.c, d: screenToFloor.d };
    svg.current?.setPointerCapture(event.pointerId);
  };
  const clickCanvas = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!drawing || (event.target as Element).closest('[data-drag-kind]')) return;
    onSketchPoint(toFloor(event.clientX, event.clientY));
  };
  const keyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    if (drawing) {
      if (event.key === 'Enter') { event.preventDefault(); onFinishDrawing(); return; }
      if (event.key === 'Escape') { event.preventDefault(); onCancelDrawing(); return; }
      if (event.key === ' ') { event.preventDefault(); onSketchPoint(keyboardCursor); return; }
      const amount = event.shiftKey ? 10 : 1;
      const delta: Record<string, Point> = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] };
      const move = delta[event.key];
      if (move) { event.preventDefault(); setKeyboardCursor(([x, y]) => [clampView(x + move[0], document.widthCm), clampView(y + move[1], document.heightCm)]); }
      return;
    }
    if (event.key === 'Escape') { onCancelDrawing(); return; }
    const amount = event.shiftKey ? 10 : 1;
    const delta: Record<string, Point> = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] };
    const move = delta[event.key];
    if (move && selectedSensorUid && onSensorNudge) { event.preventDefault(); onSensorNudge(move[0], move[1]); return; }
    if (move) { event.preventDefault(); onNudge(move[0], move[1]); }
  };
  const beginSensorDrag = (event: React.PointerEvent<SVGCircleElement>, sensor: SensorMarker) => {
    event.preventDefault(); event.stopPropagation();
    onSensorSelect?.(sensor.uid);
    if (!sensor.movable) return;
    sensorDrag.current = sensor.uid;
    svg.current?.focus(); svg.current?.setPointerCapture(event.pointerId);
  };
  const metrics = canvasMetrics(view, { width: document.widthCm, height: document.heightCm }, canvasSize);
  const selectedZone = selected?.kind === 'zone' ? document.zones.find((zone) => zone.id === selected.id) : undefined;
  const tableZoneIds = new Set(document.zones.map((zone) => zone.id));
  const drawingPoints = drawing?.points.map(([x, y]) => `${x},${y}`).join(' ') ?? '';
  const zoomBy = (factor: number) => {
    const nextZoom = Math.max(1, Math.min(5, round(zoom * factor)));
    const fit = fitCanvasView(document.widthCm, document.heightCm);
    const width = fit.width / nextZoom, height = fit.height / nextZoom;
    const centerX = view.x + view.width / 2, centerY = view.y + view.height / 2;
    setZoom(nextZoom);
    setView({ x: Math.max(fit.x, Math.min(fit.x + fit.width - width, centerX - width / 2)), y: Math.max(fit.y, Math.min(fit.y + fit.height - height, centerY - height / 2)), width, height });
  };
  return <div className="loc-canvas-frame">
    <div className="loc-canvas-controls" aria-label="Canvas zoom controls">
      <button type="button" className="btn btn-secondary" data-testid="location-canvas-zoom-out" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomBy(1 / 1.25)}>−</button>
      <span aria-live="polite">Zoom {zoom.toFixed(2).replace(/\.00$/, '')}×</span>
      <button type="button" className="btn btn-secondary" data-testid="location-canvas-zoom-in" aria-label="Zoom in" disabled={zoom >= 5} onClick={() => zoomBy(1.25)}>+</button>
      <button type="button" className="btn btn-ghost" data-testid="location-canvas-reset" onClick={() => { setZoom(1); setView(fitCanvasView(document.widthCm, document.heightCm)); }}>Reset view</button>
      <span className="loc-grid-scale" data-testid="location-grid-scale">Grid · {metrics.minorStepCm / 100} m</span>
    </div>
    <div className="loc-canvas-surface">
      <CanvasRulers metrics={metrics} width={canvasSize.width} height={canvasSize.height} />
      <svg ref={svg} className="loc-canvas" data-testid="location-floor-canvas" data-location-field="floor.outline" viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet" role="application" aria-label={selectedSensorUid ? 'Sensor placement map. Use arrow keys to move the selected sensor; hold Shift for larger steps.' : 'Floor plan editor. Use the arrow keys to adjust the selected item. Drag the blank canvas to pan.'} tabIndex={0}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onClick={clickCanvas} onKeyDown={keyDown}>
        <rect width={document.widthCm} height={document.heightCm} className="loc-floor" />
        {planUrl && <image href={planUrl} x="0" y="0" width={document.widthCm} height={document.heightCm} preserveAspectRatio="none" className="loc-plan" />}
        <CanvasGrid metrics={metrics} heightCm={document.heightCm} />
        <polygon points={pointString(document.outline)} className="loc-outline" />
        {document.zones.map((zone, index) => <g key={zone.id}>
          <polygon points={pointString(zone.polygon)} className={`loc-zone ${selectedZone?.id === zone.id ? 'is-selected' : ''}`} pointerEvents="none" />
          <text x={zone.polygon[0]?.[0] ?? 0} y={zone.polygon[0]?.[1] ?? 0} className="loc-zone-label">{zone.name}</text>
          {selectedZone?.id === zone.id && zone.polygon.map((point, vertex) => <circle key={`${zone.id}-${vertex}`} data-testid={`location-canvas-vertex-${testToken(zone.id)}-${vertex + 1}`} cx={point[0]} cy={point[1]} r={Math.max(12, document.widthCm / 120)} className={`loc-vertex ${selected?.index === vertex ? 'is-selected' : ''}`} data-drag-kind="zone-vertex" data-id={zone.id} data-index={vertex}
            onPointerDown={(event) => beginDrag(event, 'zone-vertex', zone.id, vertex)}><title>{`${zone.name} vertex ${vertex + 1}`}</title></circle>)}
        </g>)}
        {document.tables.map((table) => <TableDrawing key={table.id} table={table} selected={selected?.kind === 'table' && selected.id === table.id} coverageStatus={coverageStatus[table.id]}
          seatsSelected={selected?.kind === 'seat' && table.seats.some((seat) => seat.id === selected.id)} floorWidth={document.widthCm}
          zoneExists={tableZoneIds.has(table.zoneId)} onStartTable={(event) => beginDrag(event, 'table', table.id)} onStartSeat={(event, seatId) => beginDrag(event, 'seat', seatId)} onSelectTable={() => onSelect({ kind: 'table', id: table.id })} />)}
        {sensors.map((sensor) => <circle key={sensor.uid} data-testid={`location-canvas-sensor-${testToken(sensor.uid)}`} data-drag-kind="sensor" cx={sensor.x} cy={sensor.y}
          r={Math.max(16, document.widthCm / 100)} className={`loc-sensor-marker ${sensor.stale ? 'is-stale' : ''} ${selectedSensorUid?.toLowerCase() === sensor.uid.toLowerCase() ? 'is-selected' : ''}`}
          onPointerDown={(event) => beginSensorDrag(event, sensor)}><title>{sensor.stale ? 'Previously assigned sensor; no longer eligible' : `${sensor.label} sensor position`}</title></circle>)}
        {drawing && <g className="loc-sketch" aria-label="Polygon in progress">
          {drawing.points.length > 1 && <polyline points={drawingPoints} />}
          {drawing.points.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={Math.max(10, document.widthCm / 150)} />)}
          <circle className="loc-sketch-cursor" cx={keyboardCursor[0]} cy={keyboardCursor[1]} r={Math.max(12, document.widthCm / 130)} />
        </g>}
      </svg>
    </div>
    <p className="loc-canvas-caption">Bottom-left origin · {cmLabel(document.widthCm / 100)} × {cmLabel(document.heightCm / 100)} m · select an item, then drag or edit its labelled coordinates.</p>
    <span className="loc-sr" aria-live="polite">{announceText(selected, drawing)}</span>
  </div>;
}

/** Canvas child for one table and its seats; the parent supplies selection and pointer handlers. */
function TableDrawing({ table, selected, seatsSelected, floorWidth, zoneExists, coverageStatus, onStartTable, onStartSeat, onSelectTable }: {
  table: Table; selected: boolean; seatsSelected: boolean; floorWidth: number; zoneExists: boolean; coverageStatus?: 'none' | 'partial' | 'full' | 'unknown';
  onStartTable(event: React.PointerEvent<SVGElement>): void; onStartSeat(event: React.PointerEvent<SVGCircleElement>, id: string): void; onSelectTable(): void;
}) {
  const shape = shapeOf(table);
  const stroke = `loc-table${selected ? ' is-selected' : ''}${coverageStatus ? ` is-coverage-${coverageStatus}` : ''}`;
  const radius = Math.max(9, floorWidth / 200);
  return <g className={!zoneExists ? 'is-invalid' : undefined}>
    {shape.type === 'rect' ? <rect {...{ x: shape.x, y: shape.y, width: shape.width, height: shape.height }} data-testid={`location-canvas-table-${testToken(table.id)}`} data-coverage-status={coverageStatus} className={stroke} data-drag-kind="table" data-id={table.id} onPointerDown={onStartTable} onClick={onSelectTable} />
      : shape.type === 'circle' ? <circle data-testid={`location-canvas-table-${testToken(table.id)}`} data-coverage-status={coverageStatus} cx={shape.cx} cy={shape.cy} r={shape.radius} className={stroke} data-drag-kind="table" data-id={table.id} onPointerDown={onStartTable} onClick={onSelectTable} />
        : <polygon data-testid={`location-canvas-table-${testToken(table.id)}`} data-coverage-status={coverageStatus} points={pointString(shape.points)} className={stroke} data-drag-kind="table" data-id={table.id} onPointerDown={onStartTable} onClick={onSelectTable} />}
    <text className="loc-table-label" x={shape.type === 'circle' ? shape.cx : shape.type === 'rect' ? shape.x + shape.width / 2 : center(shape.points)[0]}
      y={shape.type === 'circle' ? shape.cy : shape.type === 'rect' ? shape.y + shape.height / 2 : center(shape.points)[1]}>{table.name}</text>
    {table.seats.map((seat) => <circle key={seat.id} data-testid={`location-canvas-seat-${testToken(seat.id)}`} cx={seat.x} cy={seat.y} r={radius} className={`loc-seat ${selected && seatsSelected ? 'is-selected' : ''}`}
      data-drag-kind="seat" data-id={seat.id} onPointerDown={(event) => onStartSeat(event, seat.id)}><title>{`Seat ${seat.id}`}</title></circle>)}
  </g>;
}

function pointString(points: readonly Point[]): string { return points.map(([x, y]) => `${x},${y}`).join(' '); }
function center(points: Point[]): Point { return points.reduce((result, [x, y]) => [result[0] + x / points.length, result[1] + y / points.length] as Point, [0, 0] as Point); }
function round(value: number): number { return Number(value.toFixed(2)); }
function cmLabel(value: number): string { return Number(value.toFixed(2)).toString(); }
function announceText(selected: Selection | null, drawing: Drawing | null): string { return drawing ? `${drawing.kind} polygon in progress. Use the arrow keys to position the cursor, Space to add a vertex, Enter to finish, and Escape to cancel.` : selected?.kind === 'zone' && selected.index !== undefined ? `Zone vertex ${selected.index + 1} selected. Use the arrow keys to move it; hold Shift to move ten centimetres.` : selected ? `${selected.kind} selected.` : 'No geometry selected.'; }
function clampView(value: number, max: number): number { return Math.max(0, Math.min(max, value)); }
function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
