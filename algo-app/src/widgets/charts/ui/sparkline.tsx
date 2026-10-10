/** The quiet trend under a metric tile (Bluegrid): shape only, no axis, the newest point marked. */
import { useRef } from 'react';
import { runs, useWidth } from '../lib/scale.ts';

export function Sparkline({ values }: { values: (number | null)[] }) {
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box, 200), H = 32;
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) return <div className="an-spark" ref={box} aria-hidden="true" />;
  const min = Math.min(...present), range = (Math.max(...present) - min) || 1;
  // Four pixels clear at each end and edge so the marker is never clipped.
  const x = (i: number) => 4 + i * (W - 8) / (values.length - 1);
  const y = (v: number) => 4 + (H - 8) * (1 - (v - min) / range);
  let last = values.length - 1;
  while (last >= 0 && (values[last] ?? null) === null) last--;
  const lastValue = values[last] ?? null;
  return (
    <div className="an-spark" ref={box} aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        {runs(values).filter((seg) => seg.length > 1).map((seg) => (
          <path key={seg[0]} d={`M${seg.map((i) => `${x(i).toFixed(1)},${y(values[i] ?? 0).toFixed(1)}`).join('L')}`} />
        ))}
        {lastValue !== null && <circle cx={x(last)} cy={y(lastValue)} r={4} />}
      </svg>
    </div>
  );
}
