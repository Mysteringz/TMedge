/** Small helpers shared by the tests. */
import { readFileSync } from 'node:fs';
import { floorToPixel } from '../src/shared/geometry.js';
import { buildReport, REPORT_BACKGROUND_READY, type Detection, type Identity } from '../src/edge/protocol.js';
import { buildRegistry, type Registry } from '../src/edge/registry.js';
import type { NodePose } from '../src/shared/types.js';

export const KEY = Buffer.from('test-key');

export function siteJson(): unknown {
  return JSON.parse(readFileSync('config/site.json', 'utf8'));
}

export function nodesJson(): { nodes: Record<string, unknown>[] } {
  return JSON.parse(readFileSync('config/nodes.json', 'utf8')) as { nodes: Record<string, unknown>[] };
}

export function makerspace(): Registry {
  return buildRegistry(siteJson(), nodesJson());
}

/** What a node at `pose` reports for a person at plan point (x, y). */
export function personAt(pose: NodePose, x: number, y: number, heat = 60): Detection {
  const px = floorToPixel(pose, x, y);
  if (!px) throw new Error(`(${x}, ${y}) is outside the view`);
  return { x: px[0], y: px[1], area: 8, contrast: 5, peak: 31, heat };
}

export function identity(uid: string, boot = 1): Identity {
  return { uid, boot, seq: 0, key: KEY };
}

export function report(id: Identity, dets: Detection[], frame: number, flags = REPORT_BACKGROUND_READY): Buffer {
  return buildReport(id, frame * 1000, { frame, ta: 30, sceneMin: 22, sceneMax: 32, bgMean: 23, flags, detections: dets });
}
