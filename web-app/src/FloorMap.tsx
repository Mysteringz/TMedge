import type { CampusFloor, TableState } from './data.ts';
import type { KeyboardEvent } from 'react';

/**
 * Coordinate-accurate student floor map. Parent: `Spaces`; inputs are the
 * normalized public CampusFloor plus selected table and a live-state-safe
 * selection callback. Shape-less v1/legacy tables use their existing rect.
 */
export default function FloorMap({ floor, selected, canSelect, onTable }: {
  floor: CampusFloor;
  selected: string | null;
  canSelect(table: TableState): boolean;
  onTable(id: string): void;
}) {
  const pointList = (points: readonly (readonly [number, number])[]) => points.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg data-testid={`student-floor-map-${encodeURIComponent(floor.siteId)}-${encodeURIComponent(floor.id)}`} className="floor-map" viewBox={`0 0 ${floor.width} ${floor.height}`} role="group" aria-label={`${floor.name} floor map`} preserveAspectRatio="xMidYMid meet">
      <polygon className="floor-outline" points={pointList(floor.outline)} />
      {floor.zones.map((zone) => {
        const bounds = boundsOf(zone.polygon);
        return <g key={zone.id} className="floor-zone">
          <polygon points={pointList(zone.polygon)} />
          <text x={bounds.x + bounds.width / 2} y={bounds.y + 22} textAnchor="middle">{zone.name}</text>
        </g>;
      })}
      {floor.tables.map((table) => {
        const active = canSelect(table);
        const status = table.status === 'unknown' || table.free === null ? 'unknown'
          : table.free > 0 ? 'free' : 'full';
        const cls = `floor-table floor-table-${status}${selected === table.id ? ' floor-table-selected' : ''}`;
        const common = {
          className: cls,
          'data-testid': `student-map-table-${encodeURIComponent(floor.siteId)}-${encodeURIComponent(floor.id)}-${encodeURIComponent(table.id)}`,
          role: 'button' as const,
          tabIndex: active || selected === table.id ? 0 : -1,
          'aria-label': `${table.name}: ${statusLabel(table)}`,
          'aria-pressed': selected === table.id,
          'aria-disabled': !active && selected !== table.id,
          onClick: () => { if (active || selected === table.id) onTable(table.id); },
          onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
            if ((active || selected === table.id) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onTable(table.id); }
          },
        };
        const shape = table.shape ?? { type: 'rect' as const, ...table.rect };
        return <g key={table.id} {...common}>
          {shape.type === 'circle'
            ? <circle className="floor-table-shape" cx={shape.cx} cy={shape.cy} r={shape.radius} />
            : shape.type === 'polygon'
              ? <polygon className="floor-table-shape" points={pointList(shape.points)} />
              : <rect className="floor-table-shape" x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={8} />}
          {table.seats.map((seat) => <circle key={seat.id} className={`floor-seat${seat.occupied === null ? ' floor-seat-unknown' : seat.occupied ? ' floor-seat-occupied' : ' floor-seat-free'}`} cx={seat.x} cy={seat.y} r={8} />)}
          <text className="floor-table-label" x={table.rect.x + table.rect.width / 2} y={table.rect.y + table.rect.height / 2} textAnchor="middle">{table.name}</text>
        </g>;
      })}
    </svg>
  );
}

function statusLabel(table: TableState): string {
  if (table.status === 'unknown' || table.free === null) return 'live data unavailable';
  return `${table.free} of ${table.capacity} seats free`;
}

function boundsOf(points: readonly (readonly [number, number])[]) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
