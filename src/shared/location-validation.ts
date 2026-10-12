import type { Point } from './types.js';

export const LOCATION_GEOMETRY_EPSILON = 1e-7;
export const MAX_LOCATION_POLYGON_POINTS = 256;

export const LOCATION_MODEL_TRANSFORM_LIMITS = {
  scale: { min: 0.000001, max: 10000 },
  rotationDeg: { min: -3600, max: 3600 },
  positionM: { min: -100000, max: 100000 },
} as const;

export function isValidSimpleBoundedPolygon(value: unknown, width: number, height: number): value is Point[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_LOCATION_POLYGON_POINTS) return false;
  const points: Point[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return false;
    const x = point[0], y = point[1];
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return false;
    if (x < 0 || y < 0 || x > width || y > height) return false;
    points.push([x, y]);
  }
  return hasUniquePolygonVertices(points) && polygonHasNonzeroArea(points) && !polygonHasSelfIntersection(points);
}

export function hasUniquePolygonVertices(points: readonly Point[]): boolean {
  return new Set(points.map(([x, y]) => `${x},${y}`)).size === points.length;
}

export function polygonHasNonzeroArea(points: readonly Point[]): boolean {
  return Math.abs(signedArea(points)) > LOCATION_GEOMETRY_EPSILON;
}

export function polygonHasSelfIntersection(points: readonly Point[]): boolean {
  for (let first = 0; first < points.length; first++) {
    const nextFirst = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second++) {
      const nextSecond = (second + 1) % points.length;
      if (nextFirst === second || nextSecond === first) continue;
      if (segmentsIntersect(points[first]!, points[nextFirst]!, points[second]!, points[nextSecond]!)) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  if (Math.abs(abC) <= LOCATION_GEOMETRY_EPSILON && onSegment(a, b, c)) return true;
  if (Math.abs(abD) <= LOCATION_GEOMETRY_EPSILON && onSegment(a, b, d)) return true;
  if (Math.abs(cdA) <= LOCATION_GEOMETRY_EPSILON && onSegment(c, d, a)) return true;
  if (Math.abs(cdB) <= LOCATION_GEOMETRY_EPSILON && onSegment(c, d, b)) return true;
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function orient(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
  return point[0] >= Math.min(a[0], b[0]) - LOCATION_GEOMETRY_EPSILON
    && point[0] <= Math.max(a[0], b[0]) + LOCATION_GEOMETRY_EPSILON
    && point[1] >= Math.min(a[1], b[1]) - LOCATION_GEOMETRY_EPSILON
    && point[1] <= Math.max(a[1], b[1]) + LOCATION_GEOMETRY_EPSILON;
}

function signedArea(points: readonly Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}
