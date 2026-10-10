/**
 * One measure across named things (Bluegrid BarChart): horizontal bars in a
 * single colour, the value at each bar's tip. Sorted largest first unless the
 * order itself means something (party of 1, 2, 3 …), which the caller says.
 */
import { useRef, useState } from 'react';
import { axis, compact, formatNumber, useWidth, withUnit } from '../lib/scale.ts';
import { ChartFrame, ChartTip, type ChartTable } from './chart-frame.tsx';

export interface BarItem { label: string; value: number; note?: string }

export interface BarChartProps {
  title: string;
  subtitle?: string;
  items: BarItem[];
  seriesName: string;
  /** Heading of the label column in the table view. */
  itemName: string;
  unit?: string;
  /** Keep the given order instead of sorting by value. */
  ordered?: boolean;
  labelWidth?: number;
  colorSlot?: number;
  loading?: boolean;
  empty?: string;
}

export function BarChart({ title, subtitle, items, seriesName, itemName, unit = '', ordered, labelWidth = 120, colorSlot = 2, loading, empty = 'None in this range.' }: BarChartProps) {
  const plot = useRef<HTMLDivElement>(null);
  const W = useWidth(plot);
  const [hover, setHover] = useState(-1);
  const rows = ordered ? items : [...items].sort((a, b) => b.value - a.value);
  const fmt = (v: number) => withUnit(formatNumber(v), unit);
  const table: ChartTable = { headers: [itemName, `${seriesName}${unit ? ` (${unit})` : ''}`], rows: rows.map((d) => [d.label, formatNumber(d.value)]) };
  const hasData = rows.some((d) => d.value > 0);

  const band = 32, bar = 20;
  // A long name gives way before the bars do on a narrow screen.
  const lw = Math.min(labelWidth, Math.max(64, W * 0.34));
  const m = { l: lw + 8, r: 56, t: 4, b: 24 };
  const iw = Math.max(40, W - m.l - m.r), H = m.t + rows.length * band + m.b;
  const { top, ticks } = axis(Math.max(1, ...rows.map((d) => d.value)) * 1.05, true);
  const x = (v: number) => m.l + iw * v / top;
  const fill = `var(--viz-0${colorSlot})`;
  // About 6.6px a character at 12px Plex Sans; cut the label rather than let it run under the bars.
  const fit = (text: string) => { const chars = Math.max(4, Math.floor(lw / 6.6)); return text.length > chars ? `${text.slice(0, chars - 1)}…` : text; };
  const hot = rows[hover];

  return (
    <ChartFrame title={title} subtitle={subtitle} loading={loading} table={table}>
      <div className="an-chart__plot" ref={plot}>
        {!hasData ? <p className="an-chart__empty" style={{ height: Math.max(96, H) }}>{empty}</p> : (
          <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={`${title}. Use the table view for exact values.`}>
            <g className="grid">
              {ticks.slice(1).map((v) => { const xx = Math.round(x(v)) + 0.5; return <line key={v} x1={xx} x2={xx} y1={m.t} y2={H - m.b} />; })}
            </g>
            {ticks.map((v) => <text key={v} x={x(v)} y={H - 6} textAnchor={v ? 'middle' : 'start'}>{compact(v)}</text>)}
            <g className="axis"><line x1={m.l + 0.5} x2={m.l + 0.5} y1={m.t} y2={H - m.b} /></g>
            {rows.map((d, i) => {
              const yy = m.t + i * band + (band - bar) / 2, w = d.value > 0 ? Math.max(2, x(d.value) - m.l) : 0, r = Math.min(4, w / 2);
              return (
                <g key={d.label} tabIndex={0} role="img" aria-label={`${d.label}: ${fmt(d.value)}`} className="an-bar-row"
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(-1)} onFocus={() => setHover(i)} onBlur={() => setHover(-1)}>
                  {/* The whole band is the target, not just the ink. */}
                  <rect x={0} y={m.t + i * band} width={W} height={band} fill="transparent" />
                  <text x={m.l - 8} y={yy + bar / 2 + 4} textAnchor="end"><title>{d.label}</title>{fit(d.label)}</text>
                  {w > 0 && <path className={`bar ${hover === i ? 'is-hot' : ''}`} fill={fill}
                    d={`M${m.l},${yy}H${m.l + w - r}Q${m.l + w},${yy} ${m.l + w},${yy + r}V${yy + bar - r}Q${m.l + w},${yy + bar} ${m.l + w - r},${yy + bar}H${m.l}Z`} />}
                  <text className="value" x={m.l + w + 6} y={yy + bar / 2 + 4}>{formatNumber(d.value)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hot && hasData && (
          <ChartTip x={x(hot.value)} width={W} head={hot.label}
            rows={[{ color: fill, value: fmt(hot.value), name: seriesName, box: true }, ...(hot.note ? [{ color: 'transparent', value: '', name: hot.note }] : [])]} />
        )}
      </div>
    </ChartFrame>
  );
}
