/**
 * How many of something happened in each step of time: one column per step,
 * one colour, the baseline square and the top rounded (Bluegrid bar anatomy,
 * stood upright because the axis is time).
 *
 * `known` marks where counting began. Columns before it are not drawn as
 * zero -- nothing was being counted then -- and the table says "–".
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { axis, compact, formatNumber, pointLabel, tickLabel, useWidth, withUnit } from '../lib/scale.ts';
import { ChartFrame, ChartTip, type ChartTable } from './chart-frame.tsx';

export interface ColumnChartProps {
  title: string;
  subtitle?: string;
  /** Start of each step, or a `YYYY-MM-DD` label when the steps are named days. */
  times: number[];
  labels?: string[];
  stepMs: number;
  values: number[];
  seriesName: string;
  unit?: string;
  /** Steps that start before this are before counting began. */
  knownFrom?: number | null;
  colorSlot?: number;
  height?: number;
  loading?: boolean;
  daily?: boolean;
}

export function ColumnChart({ title, subtitle, times, labels, stepMs, values, seriesName, unit = '', knownFrom = null, colorSlot = 2, height = 200, loading, daily }: ColumnChartProps) {
  const plot = useRef<HTMLDivElement>(null);
  const W = useWidth(plot);
  const [hover, setHover] = useState(-1);
  const n = values.length;
  const span = n > 0 ? (times[n - 1] ?? 0) - (times[0] ?? 0) + stepMs : stepMs;
  const step = daily ? 86_400_000 : stepMs;
  const known = (i: number) => knownFrom === null || (times[i] ?? 0) + step > knownFrom;
  const label = (i: number) => (labels?.[i] ? formatDay(labels[i] ?? '', true) : pointLabel(times[i] ?? 0, step, span));
  const tick = (i: number) => (labels?.[i] ? formatDay(labels[i] ?? '', false) : daily ? tickLabel(times[i] ?? 0, 7 * 86_400_000) : tickLabel(times[i] ?? 0, span));
  const fmt = (v: number) => withUnit(formatNumber(v), unit);
  const hasData = values.some((v, i) => known(i) && v > 0);
  const anyKnown = values.some((_, i) => known(i));

  const table: ChartTable = {
    headers: [daily || labels ? 'Day' : 'Time', `${seriesName}${unit ? ` (${unit})` : ''}`],
    rows: values.map((v, i) => [label(i), known(i) ? formatNumber(v) : '–']).reverse(),
  };

  const m = { l: 48, r: 16, t: 8, b: 28 };
  const iw = Math.max(40, W - m.l - m.r), ih = height - m.t - m.b;
  const { top, ticks } = axis(Math.max(1, ...values) * 1.05, true);
  const band = n > 0 ? iw / n : iw;
  // At most 24px thick, and always a visible gap of surface between neighbours.
  const bar = Math.max(1, Math.min(24, band - Math.max(2, band * 0.25)));
  const cx = (i: number) => m.l + band * (i + 0.5);
  const y = (v: number) => m.t + ih * (1 - v / top);
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 72))));

  const show = (index: number) => setHover(Math.max(0, Math.min(n - 1, index)));
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - box.left) * W / box.width;
    if (px < m.l || px > m.l + iw || n === 0) { setHover(-1); return; }
    show(Math.floor((px - m.l) / band));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); show(hover < 0 ? n - 1 : hover + (event.key === 'ArrowRight' ? 1 : -1)); }
    else if (event.key === 'Home') { event.preventDefault(); show(0); }
    else if (event.key === 'End') { event.preventDefault(); show(n - 1); }
    else if (event.key === 'Escape') setHover(-1);
  };
  const fill = `var(--viz-0${colorSlot})`;

  return (
    <ChartFrame title={title} subtitle={subtitle} loading={loading} table={table}>
      <div className="an-chart__plot" ref={plot} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(-1)}
        role="group" aria-label={`${title}. Use the left and right arrow keys to read values, or view as table.`}>
        {!anyKnown ? <p className="an-chart__empty" style={{ height }}>No data in this range yet.</p> : (
          <svg viewBox={`0 0 ${W} ${height}`} height={height} role="img" aria-label={`${title}. Use the table view for exact values.`}
            onPointerMove={onMove} onPointerLeave={() => setHover(-1)}>
            <g className="grid">
              {ticks.slice(1).map((v) => { const yy = Math.round(y(v)) + 0.5; return <line key={v} x1={m.l} x2={m.l + iw} y1={yy} y2={yy} />; })}
            </g>
            {ticks.map((v) => <text key={v} x={m.l - 8} y={Math.round(y(v)) + 4} textAnchor="end">{compact(v)}</text>)}
            {values.map((v, i) => {
              if (!known(i) || v <= 0) return null;
              const h = Math.max(2, y(0) - y(v)), x0 = cx(i) - bar / 2, r = Math.min(4, bar / 2, h);
              return <path key={i} className={`bar ${hover === i ? 'is-hot' : ''}`} fill={fill}
                d={`M${x0},${y(0)}V${y(0) - h + r}Q${x0},${y(0) - h} ${x0 + r},${y(0) - h}H${x0 + bar - r}Q${x0 + bar},${y(0) - h} ${x0 + bar},${y(0) - h + r}V${y(0)}Z`} />;
            })}
            <g className="axis"><line x1={m.l} x2={m.l + iw} y1={Math.round(y(0)) + 0.5} y2={Math.round(y(0)) + 0.5} /></g>
            {values.map((_, i) => (i % tickEvery === 0 ? <text key={i} x={cx(i)} y={height - 8} textAnchor="middle">{tick(i)}</text> : null))}
            {!hasData && <text x={m.l + iw / 2} y={m.t + ih / 2} textAnchor="middle">None in this range</text>}
          </svg>
        )}
        {hover >= 0 && anyKnown && (
          <ChartTip x={cx(hover)} width={W} head={label(hover)}
            rows={[{ color: fill, value: known(hover) ? fmt(values[hover] ?? 0) : 'No data', name: seriesName, box: true }]} />
        )}
      </div>
    </ChartFrame>
  );
}

/** `2026-10-10` as "10 Oct" (or "Sat 10 Oct"), without passing it through the browser's own time zone. */
export function formatDay(day: string, weekday: boolean): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat(undefined, { ...(weekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, date));
}
