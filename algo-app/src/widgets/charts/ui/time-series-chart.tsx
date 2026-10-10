/**
 * One measure over time, for up to four series (Bluegrid TimeSeriesChart):
 * 2px lines in the viz colours, a crosshair that snaps to the nearest step
 * and lists every series, and a label at each line's end.
 *
 * A step with no measurement breaks the line. That gap is information -- the
 * edge was down, a sensor was silent -- and joining across it would draw a
 * reading nobody took.
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { axis, compact, fixedAxis, formatNumber, pointLabel, runs, tickLabel, useWidth, withUnit } from '../lib/scale.ts';
import { ChartFrame, ChartTip, type ChartTable } from './chart-frame.tsx';

export interface ChartSeries { key: string; label: string; values: (number | null)[] }

export interface TimeSeriesChartProps {
  title: string;
  subtitle?: string;
  times: number[];
  stepMs: number;
  series: ChartSeries[];
  /** Printed after a value in the tooltip and in the table header. */
  unit?: string;
  decimals?: number;
  /** Fix the top of the axis (100 for a percentage) instead of fitting it to the data. */
  max?: number;
  /** First palette slot to use, 1-4, when a lone series should not be magenta. */
  colorStart?: number;
  height?: number;
  loading?: boolean;
  /** Steps are whole days in the site's zone: label them as dates. */
  daily?: boolean;
}

const color = (slot: number) => `var(--viz-0${((slot - 1) % 4) + 1})`;

export function TimeSeriesChart({ title, subtitle, times, stepMs, series, unit = '', decimals = 0, max, colorStart = 1, height = 220, loading, daily }: TimeSeriesChartProps) {
  const plot = useRef<HTMLDivElement>(null);
  const W = useWidth(plot);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState(-1);
  const span = times.length > 1 ? (times[times.length - 1] ?? 0) - (times[0] ?? 0) + stepMs : stepMs;
  const step = daily ? 86_400_000 : stepMs;
  const fmt = (value: number | null) => (value === null ? 'No data' : withUnit(formatNumber(value, decimals), unit));
  const visible = series.filter((s) => !hidden.has(s.key));
  const hasData = series.some((s) => s.values.some((v) => v !== null));
  const multi = series.length > 1;

  const table: ChartTable = useMemo(() => ({
    headers: [daily ? 'Day' : 'Time', ...series.map((s) => `${s.label}${unit ? ` (${unit})` : ''}`)],
    // Newest first: the row most often wanted is the latest.
    rows: times.map((t, i) => [pointLabel(t, step, span), ...series.map((s) => { const v = s.values[i] ?? null; return v === null ? '–' : formatNumber(v, decimals); })]).reverse(),
  }), [times, series, unit, decimals, step, span, daily]);

  const peak = Math.max(0, ...visible.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const { top, ticks } = max !== undefined ? fixedAxis(max) : axis(peak * 1.05, decimals === 0);
  const mt = 8, mb = 28, ih = height - mt - mb;
  const y = (v: number) => mt + ih * (1 - Math.min(v, top) / top);
  // Where each line ends, by height alone: that decides whether the labels
  // fit before any room is set aside for them.
  const lastOf = (values: (number | null)[]) => { let i = values.length - 1; while (i >= 0 && (values[i] ?? null) === null) i--; return i; };
  const endYs = visible.map((s) => { const i = lastOf(s.values); return i < 0 ? null : y(s.values[i] ?? 0); }).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const endsFit = multi && series.length <= 4 && W >= 520 && endYs.length > 0 && endYs.every((v, i) => i === 0 || v - (endYs[i - 1] ?? 0) >= 14);
  const m = { l: 48, r: endsFit ? 96 : 16, t: mt, b: mb };
  const iw = Math.max(40, W - m.l - m.r);
  const x = (i: number) => m.l + (times.length > 1 ? i * iw / (times.length - 1) : iw / 2);
  const tickEvery = Math.max(1, Math.ceil(times.length / Math.max(2, Math.floor(iw / 84))));

  const show = (index: number) => setHover(Math.max(0, Math.min(times.length - 1, index)));
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - box.left) * W / box.width;
    if (px < m.l - 8 || px > m.l + iw + 8 || times.length === 0) { setHover(-1); return; }
    show(times.length > 1 ? Math.round((px - m.l) / iw * (times.length - 1)) : 0);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(hover < 0 ? times.length - 1 : hover + (event.key === 'ArrowRight' ? 1 : -1));
    } else if (event.key === 'Home') { event.preventDefault(); show(0); }
    else if (event.key === 'End') { event.preventDefault(); show(times.length - 1); }
    else if (event.key === 'Escape') setHover(-1);
  };

  const ends = visible.flatMap((s) => {
    const last = lastOf(s.values);
    const value = last < 0 ? null : s.values[last] ?? null;
    return value === null ? [] : [{ key: s.key, label: s.label, x: x(last), y: y(value), slot: series.indexOf(s) + colorStart }];
  });
  const hoverRows = hover < 0 ? [] : visible
    .map((s) => ({ color: color(series.indexOf(s) + colorStart), raw: s.values[hover] ?? null, name: s.label }))
    .sort((a, b) => (b.raw ?? -Infinity) - (a.raw ?? -Infinity))
    .map((row) => ({ color: row.color, value: fmt(row.raw), name: row.name }));
  const hoverTime = hover >= 0 ? pointLabel(times[hover] ?? 0, step, span) : '';

  return (
    <ChartFrame title={title} subtitle={subtitle} loading={loading} table={table}>
      {multi && (
        <ul className="an-chart__legend">
          {series.map((s, i) => {
            const on = !hidden.has(s.key);
            return (
              <li key={s.key}>
                <button type="button" className="an-chart__key" aria-pressed={on} title={on ? `Hide ${s.label}` : `Show ${s.label}`}
                  onClick={() => setHidden((current) => {
                    const next = new Set(current);
                    // The last visible line stays: an empty chart explains nothing.
                    if (on && visible.length > 1) next.add(s.key); else next.delete(s.key);
                    return next;
                  })}>
                  <span className="an-chart__swatch" style={{ '--c': color(i + colorStart) } as CSSProperties} />{s.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="an-chart__plot" ref={plot} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(-1)}
        role="group" aria-label={`${title}. Use the left and right arrow keys to read values, or view as table.`}>
        {!hasData ? <p className="an-chart__empty" style={{ height }}>No data in this range yet.</p> : (
          <svg viewBox={`0 0 ${W} ${height}`} height={height} role="img" aria-label={`${title}. Use the table view for exact values.`}
            onPointerMove={onMove} onPointerLeave={() => setHover(-1)}>
            <g className="grid">
              {ticks.slice(1).map((v) => { const yy = Math.round(y(v)) + 0.5; return <line key={v} x1={m.l} x2={m.l + iw} y1={yy} y2={yy} />; })}
            </g>
            {ticks.map((v) => <text key={v} x={m.l - 8} y={Math.round(y(v)) + 4} textAnchor="end">{compact(v)}</text>)}
            <g className="axis"><line x1={m.l} x2={m.l + iw} y1={Math.round(y(0)) + 0.5} y2={Math.round(y(0)) + 0.5} /></g>
            {times.map((t, i) => {
              const last = i === times.length - 1;
              if (i % tickEvery !== 0 && !last) return null;
              // The final label is dropped when it would sit on top of the one before it.
              if (last && i % tickEvery !== 0 && (i % tickEvery) < tickEvery * 0.6) return null;
              return <text key={t} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : last ? 'end' : 'middle'}>{daily ? tickLabel(t, 7 * 86_400_000) : tickLabel(t, span)}</text>;
            })}
            {visible.map((s) => {
              const slot = series.indexOf(s) + colorStart;
              const segments = runs(s.values);
              const point = (i: number) => `${x(i).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`;
              return (
                <g className="series" key={s.key}>
                  {!multi && segments.filter((seg) => seg.length > 1).map((seg) => (
                    <path key={`a${seg[0]}`} className="area" fill={color(slot)}
                      d={`M${seg.map(point).join('L')}L${x(seg[seg.length - 1] ?? 0).toFixed(1)},${y(0)}L${x(seg[0] ?? 0).toFixed(1)},${y(0)}Z`} />
                  ))}
                  {segments.map((seg) => (seg.length > 1
                    ? <path key={`l${seg[0]}`} className="line" stroke={color(slot)} d={`M${seg.map(point).join('L')}`} />
                    // One reading between two gaps has no line to draw; it is still a reading.
                    : <circle key={`p${seg[0]}`} className="lone" cx={x(seg[0] ?? 0)} cy={y(s.values[seg[0] ?? 0] ?? 0)} r={2} fill={color(slot)} />))}
                </g>
              );
            })}
            <g className="series">{ends.map((e) => <circle key={e.key} cx={e.x} cy={e.y} r={4} fill={color(e.slot)} />)}</g>
            {endsFit && ends.map((e) => <text key={e.key} className="end-label" x={m.l + iw + 10} y={e.y + 4}>{e.label}</text>)}
            {hover >= 0 && (
              <>
                <line className="crosshair" x1={Math.round(x(hover)) + 0.5} x2={Math.round(x(hover)) + 0.5} y1={m.t} y2={m.t + ih} />
                <g className="series">
                  {visible.map((s) => { const v = s.values[hover] ?? null; return v === null ? null : <circle key={s.key} cx={x(hover)} cy={y(v)} r={4} fill={color(series.indexOf(s) + colorStart)} />; })}
                </g>
              </>
            )}
          </svg>
        )}
        {hover >= 0 && hasData && <ChartTip x={x(hover)} width={W} head={hoverTime} rows={hoverRows} />}
      </div>
    </ChartFrame>
  );
}
