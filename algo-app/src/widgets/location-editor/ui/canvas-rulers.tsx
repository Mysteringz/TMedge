import type { canvasMetrics } from '../../../features/location-editor/model/canvas-metrics.ts';

type Metrics = ReturnType<typeof canvasMetrics>;

/** Fixed-size labels aligned to the same letterboxed SVG transform as the room. */
export function CanvasRulers({ metrics, width, height }: { metrics: Metrics; width: number; height: number }) {
  return <>
    <div className="loc-ruler-corner" aria-hidden="true">m</div>
    <div className="loc-ruler-x" role="img" aria-label="X axis in metres, increasing to the right" data-testid="location-ruler-x">
      {metrics.xTicks.map(tick => <span className="loc-ruler-x-tick" key={tick.valueCm} style={{ left: tick.position + 1 }} aria-hidden="true">
        <i /><b style={{ left: Math.max(18, Math.min(width - 18, tick.position)) - tick.position }}>{tick.label}</b>
      </span>)}
    </div>
    <div className="loc-ruler-y" role="img" aria-label="Y axis in metres, increasing upwards" data-testid="location-ruler-y">
      {metrics.yTicks.map(tick => <span className="loc-ruler-y-tick" key={tick.valueCm} style={{ top: tick.position + 1 }} aria-hidden="true">
        <i /><b style={{ top: Math.max(8, Math.min(height - 8, tick.position)) - tick.position }}>{tick.label}</b>
      </span>)}
    </div>
  </>;
}

/** Non-interactive viewport grid: minor subdivisions and stronger labelled intervals. */
export function CanvasGrid({ metrics, heightCm }: { metrics: Metrics; heightCm: number }) {
  const isMajor = (value: number) => Math.abs(value / metrics.stepCm - Math.round(value / metrics.stepCm)) < 1e-6;
  const path = (major: boolean) => [
    ...metrics.xGrid.filter(value => isMajor(value) === major).map(x => `M ${x} ${metrics.bounds.top} V ${metrics.bounds.bottom}`),
    ...metrics.yGrid.filter(value => isMajor(heightCm - value) === major).map(y => `M ${metrics.bounds.left} ${y} H ${metrics.bounds.right}`),
  ].join(' ');
  return <g className="loc-metric-grid" pointerEvents="none" aria-hidden="true" data-testid="location-metric-grid">
    <path className="loc-grid-minor" d={path(false)} />
    <path className="loc-grid-major" d={path(true)} />
  </g>;
}
