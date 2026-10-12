import type { Point, Rect, TableShape } from './types.js';

export function tableBounds(shape: TableShape): Rect {
  if (shape.type === 'rect') return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  if (shape.type === 'circle') return { x: shape.cx - shape.radius, y: shape.cy - shape.radius, width: shape.radius * 2, height: shape.radius * 2 };
  const xs = shape.points.map(([x]) => x);
  const ys = shape.points.map(([, y]) => y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function tableCenter(shape: TableShape): Point {
  if (shape.type === 'circle') return [shape.cx, shape.cy];
  const bounds = tableBounds(shape);
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
}

export function tableContainsPoint(shape: TableShape, point: Point): boolean {
  if (shape.type === 'circle') return Math.hypot(point[0] - shape.cx, point[1] - shape.cy) <= shape.radius;
  if (shape.type === 'rect') return point[0] >= shape.x && point[0] <= shape.x + shape.width
    && point[1] >= shape.y && point[1] <= shape.y + shape.height;
  return pointInPolygon(point, shape.points);
}

/** Distance between the actual table surfaces, with touching shapes at zero. */
export function tableSurfaceDistance(a: TableShape, b: TableShape): number {
  if (a.type === 'circle' && b.type === 'circle') return Math.max(0, Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.radius - b.radius);
  if (a.type === 'circle') return tableContainsPoint(b, [a.cx, a.cy]) ? 0 : Math.max(0, distanceToShapeBoundary([a.cx, a.cy], b) - a.radius);
  if (b.type === 'circle') return tableContainsPoint(a, [b.cx, b.cy]) ? 0 : Math.max(0, distanceToShapeBoundary([b.cx, b.cy], a) - b.radius);
  const aPoints = shapeVertices(a), bPoints = shapeVertices(b);
  if (tableContainsPoint(a, bPoints[0]!) || tableContainsPoint(b, aPoints[0]!)) return 0;
  let best = Infinity;
  for (const [a0, a1] of edges(aPoints)) {
    for (const [b0, b1] of edges(bPoints)) {
      if (segmentsIntersect(a0, a1, b0, b1)) return 0;
      best = Math.min(best, pointSegmentDistance(a0, b0, b1), pointSegmentDistance(a1, b0, b1), pointSegmentDistance(b0, a0, a1), pointSegmentDistance(b1, a0, a1));
    }
  }
  return best;
}

export function distanceToShapeBoundary(point: Point, shape: TableShape): number {
  if (shape.type === 'circle') return Math.abs(Math.hypot(point[0] - shape.cx, point[1] - shape.cy) - shape.radius);
  let best = Infinity;
  for (const [a, b] of edges(shapeVertices(shape))) best = Math.min(best, pointSegmentDistance(point, a, b));
  return best;
}

function shapeVertices(shape: Exclude<TableShape, { type: 'circle' }>): Point[] {
  if (shape.type === 'polygon') return shape.points;
  return [[shape.x, shape.y], [shape.x + shape.width, shape.y], [shape.x + shape.width, shape.y + shape.height], [shape.x, shape.y + shape.height]];
}

function edges(points: Point[]): [Point, Point][] { return points.map((point, i) => [point, points[(i + 1) % points.length]!]); }

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (pointSegmentDistance(point, a, b) < 1e-8) return true;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  const onSegment = (p: Point, q: Point, r: Point) => r[0] >= Math.min(p[0], q[0]) - 1e-8 && r[0] <= Math.max(p[0], q[0]) + 1e-8
    && r[1] >= Math.min(p[1], q[1]) - 1e-8 && r[1] <= Math.max(p[1], q[1]) + 1e-8;
  if (Math.abs(abC) <= 1e-8 && onSegment(a, b, c)) return true;
  if (Math.abs(abD) <= 1e-8 && onSegment(a, b, d)) return true;
  if (Math.abs(cdA) <= 1e-8 && onSegment(c, d, a)) return true;
  if (Math.abs(cdB) <= 1e-8 && onSegment(c, d, b)) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}
