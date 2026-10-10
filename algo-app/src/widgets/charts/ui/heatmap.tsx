/**
 * A measure across two dimensions -- here weekday by hour -- in five steps of
 * one blue (Bluegrid Heatmap). In this dark theme the ramp runs dark to
 * bright, so busier is brighter.
 *
 * A cell with no measurement is drawn in the surface's own grey and named in
 * the legend. It is not the lowest step: "we do not know" and "nearly empty"
 * are different answers.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { formatNumber, useWidth } from '../lib/scale.ts';
import { ChartFrame, ChartTip, type ChartTable } from './chart-frame.tsx';

export interface HeatmapProps {
  title: string;
  subtitle?: string;
  rows: string[];
  cols: string[];
  values: (number | null)[][];
  seriesName: string;
  unit?: string;
  decimals?: number;
  loading?: boolean;
}

const STEPS = 5;

export function Heatmap({ title, subtitle, rows, cols, values, seriesName, unit = '', decimals = 0, loading }: HeatmapProps) {
  const plot = useRef<HTMLDivElement>(null);
  const W = useWidth(plot);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const all = values.flat().filter((v): v is number => v !== null);
  const min = all.length ? Math.min(...all) : 0, max = all.length ? Math.max(...all) : 0;
  const bin = (v: number) => Math.min(STEPS - 1, Math.floor((v - min) / ((max - min) || 1) * STEPS));
  const fmt = (v: number | null) => (v === null ? 'No data' : `${formatNumber(v, decimals)}${unit}`);
  const hasGaps = values.some((row) => row.some((v) => v === null));
  const table: ChartTable = { headers: ['', ...cols], rows: rows.map((r, ri) => [r, ...cols.map((_, ci) => { const v = values[ri]?.[ci] ?? null; return v === null ? '–' : formatNumber(v, decimals); })]) };

  const m = { l: 40, r: 0, t: 0, b: 22 };
  const cw = (W - m.l - m.r) / Math.max(1, cols.length), ch = Math.max(16, Math.min(28, cw)), H = m.t + rows.length * ch + m.b;
  const every = Math.max(1, Math.ceil(cols.length / Math.max(2, Math.floor((W - m.l) / 44))));
  const fill = (v: number | null) => (v === null ? 'var(--layer-02)' : `var(--viz-seq-0${bin(v) + 1})`);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    const move = moves[event.key];
    if (event.key === 'Escape') { setHover(null); return; }
    if (!move) return;
    event.preventDefault();
    setHover((current) => {
      const at = current ?? { r: 0, c: -move[1] };
      return { r: Math.max(0, Math.min(rows.length - 1, at.r + move[0])), c: Math.max(0, Math.min(cols.length - 1, at.c + move[1])) };
    });
  };
  const hot = hover ? values[hover.r]?.[hover.c] ?? null : null;

  return (
    <ChartFrame title={title} subtitle={subtitle} loading={loading} table={table}>
      <div className="an-chart__plot" ref={plot} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}
        role="group" aria-label={`${title}. Use the arrow keys to read cells, or view as table.`}>
        {all.length === 0 ? <p className="an-chart__empty" style={{ height: H }}>No data yet. The pattern fills in as days are recorded.</p> : (
          <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={`${title}. Use the table view for exact values.`} onPointerLeave={() => setHover(null)}>
            {rows.map((r, ri) => (
              <g key={r}>
                <text x={m.l - 8} y={m.t + ri * ch + ch / 2 + 4} textAnchor="end">{r}</text>
                {cols.map((c, ci) => {
                  const v = values[ri]?.[ci] ?? null;
                  return <rect key={c} className={`cell ${hover?.r === ri && hover.c === ci ? 'is-hot' : ''}`} x={m.l + ci * cw} y={m.t + ri * ch} width={cw} height={ch}
                    fill={fill(v)} onPointerEnter={() => setHover({ r: ri, c: ci })} />;
                })}
              </g>
            ))}
            {cols.map((c, ci) => (ci % every === 0 ? <text key={c} x={m.l + ci * cw + cw / 2} y={H - 6} textAnchor="middle">{c}</text> : null))}
          </svg>
        )}
        {hover && all.length > 0 && (
          <ChartTip x={m.l + (hover.c + 1) * cw} width={W} head={`${rows[hover.r] ?? ''} ${cols[hover.c] ?? ''}:00`}
            rows={[{ color: fill(hot), value: fmt(hot), name: seriesName, box: true }]} />
        )}
      </div>
      {all.length > 0 && (
        <div className="an-chart__scale">
          <span>{fmt(min)}</span>
          {Array.from({ length: STEPS }, (_, s) => <span key={s} className="sw" style={{ background: `var(--viz-seq-0${s + 1})` }} />)}
          <span>{fmt(max)}</span>
          {hasGaps && <><span className="sw an-chart__scale-gap" style={{ background: 'var(--layer-02)' }} /><span>No data</span></>}
        </div>
      )}
    </ChartFrame>
  );
}
