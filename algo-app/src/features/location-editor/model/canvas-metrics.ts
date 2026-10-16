export interface CanvasView { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface Tick { valueCm: number; label: string; position: number }

/** Match SVG xMidYMid meet scaling; tick values always remain in room coordinates. */
export function canvasMetrics(view: CanvasView, room: Size, pixels: Size) {
  const scale = Math.min(Math.max(1, pixels.width) / view.width, Math.max(1, pixels.height) / view.height);
  // 1/2/5 metric intervals keep labels at least 64 screen pixels apart.
  const desired = 64 / scale;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const stepCm = [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= desired)!;
  const minorStepCm = stepCm / 5;
  const xOffset = (pixels.width - view.width * scale) / 2;
  const yOffset = (pixels.height - view.height * scale) / 2;
  // SVG meet scaling can expose room geometry beyond the viewBox inside
  // letterboxed margins. Cover the actual viewport, not just the viewBox.
  const xMin = view.x - xOffset / scale, xMax = view.x + (pixels.width - xOffset) / scale;
  const yMin = view.y - yOffset / scale, yMax = view.y + (pixels.height - yOffset) / scale;
  const xGrid = positions(xMin, xMax, minorStepCm);
  const bottomMin = room.height - yMax, bottomMax = room.height - yMin;
  const yGrid = positions(bottomMin, bottomMax, minorStepCm).map(value => room.height - value);
  return {
    scale, stepCm, minorStepCm, xGrid, yGrid,
    bounds: { left: xMin, top: yMin, right: xMax, bottom: yMax },
    xTicks: ticks(xMin, xMax, stepCm, view.x, xOffset, scale),
    yTicks: positions(bottomMin, bottomMax, stepCm).map(bottomY => ({
      valueCm: room.height - bottomY, label: String(Number((bottomY / 100).toFixed(4))),
      position: yOffset + (room.height - bottomY - view.y) * scale,
    })),
  };
}

/** Enumerate only visible multiples; work stays bounded when rooms are large or zoomed. */
function positions(min: number, max: number, step: number): number[] {
  const first = Math.ceil((min - step * 1e-8) / step);
  const last = Math.floor((max + step * 1e-8) / step);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => Number(((first + index) * step).toFixed(6)));
}

function ticks(min: number, max: number, step: number, viewStart: number, offset: number, scale: number): Tick[] {
  return positions(min, max, step).map(valueCm => ({ valueCm, label: String(Number((valueCm / 100).toFixed(4))), position: offset + (valueCm - viewStart) * scale }));
}

/** Give reset/fit view a border around the room without changing authored coordinates. */
export function fitCanvasView(width: number, height: number): CanvasView {
  const margin = Math.max(width, height) * 0.08;
  return { x: -margin, y: -margin, width: width + margin * 2, height: height + margin * 2 };
}
