/**
 * The node catalogue: one entry per stage of the real system.
 *
 * The graph deliberately mirrors what exists rather than what would be tidy.
 * The first three nodes run on the sensor, so their parameters are the ten
 * TM_PARAM_* values and a change to them is a signed command; the rest run
 * here. `domain` on each spec is what the editor colours by, and what the
 * inspector warns about before it writes anything.
 */
import { DWELL_CELL_CM } from '../edge/dwell.js';
import { DEFAULT_DESK } from './desk.js';
import type { NodeSpec, Pipeline } from './types.js';

const device = (param: string) => ({ kind: 'device' as const, param });
const edge = (path: string) => ({ kind: 'edge' as const, path });
const local = { kind: 'local' as const };

export const NODE_SPECS: NodeSpec[] = [
  {
    type: 'thermal_input',
    name: 'Thermal Camera',
    version: '1',
    category: 'input',
    domain: 'device',
    summary: 'The MLX90640 on the ceiling: 32x24 temperatures through a 110 degree lens.',
    inputs: [],
    outputs: [{ id: 'frame', label: 'frame', type: 'thermal' }],
    params: [
      {
        id: 'refresh', label: 'Sensor refresh', min: 1, max: 7, step: 1, binding: device('refresh'),
        help: 'MLX refresh code: 2 = 1 frame/s, 3 = 2/s, 4 = 4/s. Faster costs heat and Wi-Fi.',
      },
      {
        id: 'raw_every', label: 'Send RAW every N frames', min: 0, max: 255, step: 1, binding: device('raw_every'),
        help: '0 means the sensor sends no pictures at all. This debugger needs it above 0 for the node you are inspecting.',
      },
    ],
  },
  {
    type: 'background_subtraction',
    name: 'Background Subtraction',
    version: '1',
    category: 'filter',
    domain: 'device',
    summary: 'Per-pixel background model on the node; foreground is heat above it and above the pixel noise.',
    inputs: [{ id: 'frame', label: 'frame', type: 'thermal' }],
    outputs: [
      { id: 'background', label: 'background', type: 'thermal' },
      { id: 'diff', label: 'difference', type: 'thermal' },
      { id: 'foreground', label: 'foreground', type: 'mask' },
    ],
    params: [
      {
        id: 'min_contrast', label: 'Min contrast', min: 10, max: 400, step: 5, unit: 'C', scale: 0.01,
        binding: device('min_contrast'),
        help: 'A pixel this far above its background is foreground. Wire units are centi-C.',
      },
      {
        id: 'noise_k', label: 'Noise k', min: 5, max: 150, step: 1, scale: 0.1, binding: device('noise_k'),
        help: 'Foreground also has to beat k times that pixel’s own noise. Wire units are tenths.',
      },
      {
        id: 'bg_tau', label: 'Background tau', min: 5, max: 1000, step: 5, unit: 'frames', binding: device('bg_tau'),
        help: 'Time constant of the background average. Longer holds a still person better and adapts slower.',
      },
      {
        id: 'bg_frames', label: 'Learn before detecting', min: 1, max: 200, step: 1, unit: 'frames',
        binding: device('bg_frames'),
      },
    ],
  },
  {
    type: 'human_detection',
    name: 'Human Detection',
    version: '1',
    category: 'detection',
    domain: 'device',
    summary: 'Connected components of the foreground, split at local heat peaks. One blob, one person.',
    inputs: [{ id: 'foreground', label: 'foreground', type: 'mask' }],
    outputs: [{ id: 'detections', label: 'detections', type: 'detections' }],
    params: [
      { id: 'min_area', label: 'Min blob area', min: 1, max: 100, step: 1, unit: 'px', binding: device('min_area') },
      { id: 'max_area', label: 'Max blob area', min: 2, max: 768, step: 1, unit: 'px', binding: device('max_area') },
      {
        id: 'min_peak', label: 'Min peak contrast', min: 10, max: 600, step: 5, unit: 'C', scale: 0.01,
        binding: device('min_peak'),
      },
      {
        id: 'split_sep', label: 'Peak separation', min: 5, max: 120, step: 1, unit: 'px', scale: 0.1,
        binding: device('split_sep'),
        help: 'Two heat peaks closer than this are one person. Wire units are tenths of a pixel.',
      },
    ],
  },
  {
    type: 'projection',
    name: 'Human Location',
    version: '1',
    category: 'filter',
    domain: 'edge',
    summary: 'Pixels to centimetres on the floor plan, through the lens model and the node’s mounted pose.',
    inputs: [{ id: 'detections', label: 'detections', type: 'detections' }],
    outputs: [{ id: 'points', label: 'people', type: 'points' }],
    params: [],
  },
  {
    type: 'heatmap',
    name: 'Historical Heat Map',
    version: '1',
    category: 'ml',
    domain: 'edge',
    summary: `Person-seconds per ${DWELL_CELL_CM} cm cell, decaying: where people actually settle.`,
    inputs: [{ id: 'points', label: 'people', type: 'points' }],
    outputs: [{ id: 'heat', label: 'dwell', type: 'heatmap' }],
    params: [],
  },
  {
    type: 'desk_estimator',
    name: 'Desk Location Estimator',
    version: '0.1',
    category: 'ml',
    domain: 'edge',
    summary: 'Proposes table rectangles from where people are repeatedly still. Proposes only: nothing downstream uses them yet.',
    inputs: [{ id: 'heat', label: 'dwell', type: 'heatmap' }],
    outputs: [{ id: 'tables', label: 'candidates', type: 'tables' }],
    params: [
      {
        id: 'clusterRadiusCm', label: 'Cluster radius', min: 20, max: 200, step: 5, unit: 'cm', binding: local,
        help: 'Dwell cells this close are one seat.',
      },
      { id: 'minDwellSeconds', label: 'Min dwell', min: 10, max: 3600, step: 10, unit: 'person-s', binding: local },
      { id: 'seatToDeskCm', label: 'Seat setback', min: 10, max: 150, step: 5, unit: 'cm', binding: local },
      { id: 'deskSpacingCm', label: 'Table span', min: 60, max: 400, step: 10, unit: 'cm', binding: local },
      { id: 'minConfidence', label: 'Min confidence', min: 0, max: 1, step: 0.05, binding: local },
    ],
  },
  {
    type: 'occupancy',
    name: 'Occupancy Classifier',
    version: '1',
    category: 'detection',
    domain: 'edge',
    summary: 'People to seats to free counts, with hysteresis. These parameters change what students are told.',
    inputs: [
      { id: 'points', label: 'people', type: 'points' },
      { id: 'tables', label: 'tables', type: 'tables' },
    ],
    outputs: [{ id: 'occupancy', label: 'occupancy', type: 'occupancy' }],
    params: [
      {
        id: 'seatRadiusCm', label: 'Seat radius', min: 20, max: 300, step: 5, unit: 'cm',
        binding: edge('occupancy.seatRadiusCm'),
        help: 'A person further than this from every seat is not at a table.',
      },
      {
        id: 'mergeCm', label: 'Merge distance', min: 0, max: 200, step: 5, unit: 'cm',
        binding: edge('occupancy.mergeCm'),
        help: 'Two blobs from one node closer than this, where the smaller is a fragment, are one person.',
      },
      {
        id: 'enterWindow', label: 'Enter window', min: 1, max: 60, step: 1, unit: 'frames',
        binding: edge('occupancy.enterWindow'),
      },
      {
        id: 'enterMin', label: 'Frames to seat', min: 1, max: 60, step: 1, unit: 'frames',
        binding: edge('occupancy.enterMin'),
      },
      {
        id: 'releaseMs', label: 'Seat release', min: 2000, max: 300000, step: 1000, unit: 'ms',
        binding: edge('occupancy.releaseMs'),
      },
      {
        id: 'staleMs', label: 'Node stale after', min: 2000, max: 120000, step: 1000, unit: 'ms',
        binding: edge('occupancy.staleMs'),
      },
    ],
  },
  {
    type: 'final_map',
    name: 'Final Map',
    version: '1',
    category: 'visualization',
    domain: 'view',
    summary: 'The floor as the system currently believes it: people, tables, free seats.',
    inputs: [
      { id: 'points', label: 'people', type: 'points' },
      { id: 'tables', label: 'tables', type: 'tables' },
      { id: 'occupancy', label: 'occupancy', type: 'occupancy' },
    ],
    outputs: [],
    params: [],
  },
  {
    type: 'frame_stats',
    name: 'Frame Statistics',
    version: '1',
    category: 'utility',
    domain: 'view',
    summary: 'Min, max, mean and a histogram of the frame. A branch off the raw input, for sanity.',
    inputs: [{ id: 'frame', label: 'frame', type: 'thermal' }],
    outputs: [],
    params: [],
  },
];

export function specOf(type: string): NodeSpec | undefined {
  return NODE_SPECS.find((s) => s.type === type);
}

/** The pipeline the system actually runs, laid out left to right. */
export function defaultPipeline(uid: string): Pipeline {
  const at = (x: number, y: number) => ({ x, y });
  return {
    version: 1,
    id: 'default',
    name: 'Production path',
    uid,
    updatedAt: Date.now(),
    nodes: [
      { id: 'thermal-1', type: 'thermal_input', name: 'Thermal Camera', enabled: true, position: at(0, 160), params: {} },
      { id: 'bg-1', type: 'background_subtraction', name: 'Background Subtraction', enabled: true, position: at(260, 160), params: {} },
      { id: 'stats-1', type: 'frame_stats', name: 'Frame Statistics', enabled: true, position: at(260, 380), params: {} },
      { id: 'human-1', type: 'human_detection', name: 'Human Detection', enabled: true, position: at(520, 160), params: {} },
      { id: 'proj-1', type: 'projection', name: 'Human Location', enabled: true, position: at(780, 100), params: {} },
      { id: 'heat-1', type: 'heatmap', name: 'Historical Heat Map', enabled: true, position: at(780, 300), params: {} },
      { id: 'desk-1', type: 'desk_estimator', name: 'Desk Location Estimator', enabled: true, position: at(1040, 300), params: { ...DEFAULT_DESK } },
      { id: 'occ-1', type: 'occupancy', name: 'Occupancy Classifier', enabled: true, position: at(1300, 160), params: {} },
      { id: 'map-1', type: 'final_map', name: 'Final Map', enabled: true, position: at(1560, 160), params: {} },
    ],
    edges: [
      e('thermal-1', 'frame', 'bg-1', 'frame'),
      e('thermal-1', 'frame', 'stats-1', 'frame'),
      e('bg-1', 'foreground', 'human-1', 'foreground'),
      e('human-1', 'detections', 'proj-1', 'detections'),
      e('proj-1', 'points', 'heat-1', 'points'),
      e('proj-1', 'points', 'occ-1', 'points'),
      e('heat-1', 'heat', 'desk-1', 'heat'),
      e('desk-1', 'tables', 'occ-1', 'tables'),
      e('proj-1', 'points', 'map-1', 'points'),
      e('desk-1', 'tables', 'map-1', 'tables'),
      e('occ-1', 'occupancy', 'map-1', 'occupancy'),
    ],
  };
}

function e(sourceNode: string, sourcePort: string, targetNode: string, targetPort: string) {
  return { id: `${sourceNode}.${sourcePort}->${targetNode}.${targetPort}`, sourceNode, sourcePort, targetNode, targetPort };
}
