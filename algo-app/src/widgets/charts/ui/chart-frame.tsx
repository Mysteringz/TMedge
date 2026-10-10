/**
 * What every chart shares: a title that names the measure, a line saying
 * what period it covers, and a switch to the same numbers as a table -- so
 * no value is reachable only by hovering.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChartLine, TableSplit } from './icons.tsx';

export interface ChartTable { headers: string[]; rows: string[][] }

export function ChartFrame({ title, subtitle, loading, table, children, className = '' }: {
  title: string; subtitle?: ReactNode; loading?: boolean; table: ChartTable; children: ReactNode; className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();
  return (
    <section className={`an-chart ${loading ? 'is-loading' : ''} ${className}`} aria-labelledby={titleId}>
      <div className="an-chart__head">
        <div>
          <h3 className="an-chart__title" id={titleId}>{title}</h3>
          {subtitle && <p className="an-chart__sub">{subtitle}</p>}
        </div>
        <div className="an-chart__tools">
          <button type="button" className="an-chart__toggle" onClick={() => setAsTable((on) => !on)}>
            {asTable ? <ChartLine /> : <TableSplit />}<span>{asTable ? 'View as chart' : 'View as table'}</span>
          </button>
        </div>
      </div>
      {asTable ? <DataTable table={table} /> : children}
    </section>
  );
}

function DataTable({ table }: { table: ChartTable }) {
  if (table.rows.length === 0) return <p className="an-chart__empty">No data in this range yet.</p>;
  return (
    <div className="an-chart__table" tabIndex={0} role="region" aria-label="Chart data">
      <table className="table an-table">
        <thead><tr>{table.headers.map((header, i) => <th key={i} className={i ? 'an-num' : ''} scope="col">{header}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => (i ? <td key={i} className="an-num">{cell}</td> : <th key={i} scope="row">{cell}</th>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

export interface TipRow { color: string; value: string; name: string; box?: boolean }

/** The readout beside the pointer. Left or right of it, whichever side has the room. */
export function ChartTip({ x, width, head, rows }: { x: number; width: number; head: string; rows: TipRow[] }) {
  const right = x > width / 2;
  return (
    <div className="an-chart__tip" role="status" style={right ? { right: Math.max(8, width - x + 16) } : { left: Math.max(8, x + 16) }}>
      <div className="an-chart__tip-head">{head}</div>
      {rows.map((row, i) => (
        <div className="an-chart__tip-row" key={i}>
          <span className={`an-chart__swatch ${row.box ? 'an-chart__swatch--box' : ''}`} style={{ '--c': row.color } as React.CSSProperties} />
          <strong>{row.value}</strong><span>{row.name}</span>
        </div>
      ))}
    </div>
  );
}
