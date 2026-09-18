/**
 * Sensor pixel <-> floor plan geometry for a downward-looking MLX90640.
 *
 * Lens: 110 x 75 deg (MLX90640BAA), modelled as f-theta: the angle off the
 * optical axis grows linearly with the pixel's distance from the centre. For a
 * lens this wide that fits better than a pinhole, which would put the edge
 * columns far too far out.
 *
 * Height matters twice. A node mounted H cm up sees a seated person's head and
 * shoulders at about TARGET_HEIGHT_CM, so the ray is projected onto the plane
 * H - TARGET_HEIGHT_CM below the sensor, not onto the floor. Using the floor
 * would push every person outward by up to 40% at a 3 m mount.
 *
 * Pixel coordinates are in pixel units with (0,0) the top-left corner of the
 * first pixel: a pixel's centre is at (col + 0.5, row + 0.5), and the optical
 * axis at (16, 12). That is the convention the node's centroids use.
 */
import type { NodePose, Point } from './types.js';

export const GRID_W = 32;
export const GRID_H = 24;
export const HALF_FOV_X_DEG = 55;
export const HALF_FOV_Y_DEG = 37.5;
/** Head-and-shoulders height of a seated adult, cm. */
export const TARGET_HEIGHT_CM = 110;

const DEG = Math.PI / 180;

/** Plan position (cm) of what pixel (u, v) sees at height zCm. */
export function pixelToFloor(pose: NodePose, u: number, v: number, zCm = TARGET_HEIGHT_CM): Point {
  const d = Math.max(pose.heightCm - zCm, 1);
  const ax = ((u - GRID_W / 2) / (GRID_W / 2)) * HALF_FOV_X_DEG * DEG;
  const ay = ((v - GRID_H / 2) / (GRID_H / 2)) * HALF_FOV_Y_DEG * DEG;
  let lx = d * Math.tan(ax);
  const ly = d * Math.tan(ay);
  if (pose.mirror) lx = -lx;
  const c = Math.cos(pose.yawDeg * DEG);
  const s = Math.sin(pose.yawDeg * DEG);
  return [pose.x + lx * c - ly * s, pose.y + lx * s + ly * c];
}

/** Inverse of pixelToFloor. Returns null for points the lens cannot see. */
export function floorToPixel(pose: NodePose, x: number, y: number, zCm = TARGET_HEIGHT_CM): Point | null {
  const d = Math.max(pose.heightCm - zCm, 1);
  const c = Math.cos(pose.yawDeg * DEG);
  const s = Math.sin(pose.yawDeg * DEG);
  const dx = x - pose.x;
  const dy = y - pose.y;
  let lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  if (pose.mirror) lx = -lx;
  const u = (Math.atan2(lx, d) / (HALF_FOV_X_DEG * DEG)) * (GRID_W / 2) + GRID_W / 2;
  const v = (Math.atan2(ly, d) / (HALF_FOV_Y_DEG * DEG)) * (GRID_H / 2) + GRID_H / 2;
  if (u < 0 || u > GRID_W || v < 0 || v > GRID_H) return null;
  return [u, v];
}

/** Outline of the node's field of view on the plane at zCm, as a polygon. */
export function footprint(pose: NodePose, zCm = TARGET_HEIGHT_CM, stepsPerEdge = 8): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < stepsPerEdge; i++) pts.push(pixelToFloor(pose, (GRID_W * i) / stepsPerEdge, 0, zCm));
  for (let i = 0; i < stepsPerEdge; i++) pts.push(pixelToFloor(pose, GRID_W, (GRID_H * i) / stepsPerEdge, zCm));
  for (let i = stepsPerEdge; i > 0; i--) pts.push(pixelToFloor(pose, (GRID_W * i) / stepsPerEdge, GRID_H, zCm));
  for (let i = stepsPerEdge; i > 0; i--) pts.push(pixelToFloor(pose, 0, (GRID_H * i) / stepsPerEdge, zCm));
  return pts;
}

/** Floor area one pixel covers near (u, v), cm^2, at height zCm. */
export function pixelAreaCm2(pose: NodePose, u: number, v: number, zCm = TARGET_HEIGHT_CM): number {
  const [x0, y0] = pixelToFloor(pose, u - 0.5, v - 0.5, zCm);
  const [x1, y1] = pixelToFloor(pose, u + 0.5, v - 0.5, zCm);
  const [x2, y2] = pixelToFloor(pose, u - 0.5, v + 0.5, zCm);
  return Math.abs((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0));
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}
