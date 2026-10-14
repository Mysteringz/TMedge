import type { Rect, TableShape } from './types.js';
import { planPointToWorld } from './location-view.js';

export const SIMPLE_ROOM_SOURCE = 'simple-rectangle-v1' as const;
export const SIMPLE_ROOM_WALL_HEIGHT_M = 3;
export const SIMPLE_ROOM_TABLE_HEIGHT_M = 0.75;

export type ProceduralRoom = typeof SIMPLE_ROOM_SOURCE;

export interface SimpleRoomWorldPoint {
  x: number;
  z: number;
}

export type SimpleRoomTableFootprint =
  | { type: 'rect'; points: SimpleRoomWorldPoint[] }
  | { type: 'circle'; center: SimpleRoomWorldPoint; radiusM: number }
  | { type: 'polygon'; points: SimpleRoomWorldPoint[] };

export interface SimpleRoomTableGeometry {
  shape?: TableShape;
  rect?: Rect;
}

/** Checks the only authored outline that can use the fixed rectangular room shell. */
export function isSimpleRoomRectangleOutline(
  outline: readonly (readonly [number, number])[], widthCm: number, heightCm: number,
): boolean {
  return Number.isFinite(widthCm) && widthCm > 0
    && Number.isFinite(heightCm) && heightCm > 0
    && outline.length === 4
    && samePoint(outline[0], 0, 0)
    && samePoint(outline[1], widthCm, 0)
    && samePoint(outline[2], widthCm, heightCm)
    && samePoint(outline[3], 0, heightCm);
}

/** Projects a plan coordinate in centimeters into the Y-up world X/Z plane. */
export function projectSimpleRoomPoint(point: { x: number; y: number }): SimpleRoomWorldPoint {
  const world = planPointToWorld(point);
  return { x: world.x, z: world.z };
}

/** Projects authored or legacy rectangular bounds without rounding coordinates. */
export function projectSimpleRoomTable(geometry: SimpleRoomTableGeometry): SimpleRoomTableFootprint {
  const shape = geometry.shape ?? rectShape(geometry.rect);
  if (shape.type === 'circle') {
    const radius = finite(shape.radius);
    if (radius <= 0) throw new RangeError('Simple room table dimensions must be positive.');
    return { type: 'circle', center: projectSimpleRoomPoint({ x: shape.cx, y: shape.cy }), radiusM: radius / 100 };
  }
  if (shape.type === 'rect') {
    if (!Number.isFinite(shape.width) || shape.width <= 0 || !Number.isFinite(shape.height) || shape.height <= 0) {
      throw new RangeError('Simple room table dimensions must be positive.');
    }
    return { type: 'rect', points: rectanglePoints(shape).map(([x, y]) => projectSimpleRoomPoint({ x, y })) };
  }
  if (shape.points.length < 3) throw new RangeError('Simple room table polygons require at least three points.');
  return { type: 'polygon', points: shape.points.map(([x, y]) => projectSimpleRoomPoint({ x, y })) };
}

/** Projects existing seat coordinates while leaving their IDs and authored positions untouched. */
export function projectSimpleRoomSeat(seat: { x: number; y: number }): SimpleRoomWorldPoint {
  return projectSimpleRoomPoint(seat);
}

function rectShape(rect: Rect | undefined): TableShape {
  if (!rect) throw new TypeError('A table shape or legacy rectangle is required.');
  return { type: 'rect', x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function rectanglePoints(shape: Extract<TableShape, { type: 'rect' }>): [number, number][] {
  return [
    [shape.x, shape.y],
    [shape.x + shape.width, shape.y],
    [shape.x + shape.width, shape.y + shape.height],
    [shape.x, shape.y + shape.height],
  ];
}

function samePoint(point: readonly [number, number] | undefined, x: number, y: number): boolean {
  return !!point && point[0] === x && point[1] === y;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Simple room geometry must be finite.');
  return value;
}
