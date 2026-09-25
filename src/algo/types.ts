/**
 * The algo debugger's data model.
 *
 * A pipeline is a graph of nodes over one thermal frame. The important thing
 * this model carries, which a generic flow editor would not, is **where a
 * parameter actually lives**: the first stages of this system run on the
 * ESP32, not here, so changing their parameters is a signed command to a
 * sensor on a ceiling, not a variable in this process. `domain` says which,
 * and the UI must show it, because one of them can be wrong for real students
 * until someone puts it back.
 */

/** Typed ports: a connection is only legal between the same type. */
export type PortType =
  | 'thermal'      // 32x24 floats, degrees C
  | 'mask'         // 32x24 bytes, 0/1
  | 'detections'   // blobs in sensor pixels
  | 'points'       // people on the floor plan, cm
  | 'heatmap'      // dwell grid over a floor
  | 'tables'       // table rectangles, configured or inferred
  | 'occupancy'    // per-table state
  | 'json';        // anything else, shown as a tree

export type NodeDomain =
  /** Runs on the sensor. Parameters are TM_PARAM_* and change it for real. */
  | 'device'
  /** Runs in this edge process. Parameters change live occupancy. */
  | 'edge'
  /** Drawn here only; changing it affects nothing outside the debugger. */
  | 'view';

export type NodeCategory = 'input' | 'filter' | 'detection' | 'tracking' | 'ml' | 'visualization' | 'utility';

/** Where a parameter's value really lives. */
export type ParamBinding =
  | { kind: 'device'; param: string }        // a TM_PARAM_* name
  | { kind: 'edge'; path: string }           // dotted path into the live edge options
  | { kind: 'local' };                       // the debugger's own knob

export interface ParamSpec {
  id: string;
  label: string;
  /** Integer on the wire for device params; the UI shows `unit`. */
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** How the number a person types maps to the stored value (device params are integers). */
  scale?: number;
  binding: ParamBinding;
  help?: string;
}

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
}

export interface NodeSpec {
  type: string;
  name: string;
  version: string;
  category: NodeCategory;
  domain: NodeDomain;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
  /** One line telling the operator what this stage does and where it runs. */
  summary: string;
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  position: { x: number; y: number };
  /** Only values that differ from the live source; the runtime resolves the rest. */
  params: Record<string, number>;
}

export interface GraphEdge {
  id: string;
  sourceNode: string;
  sourcePort: string;
  targetNode: string;
  targetPort: string;
}

export interface Pipeline {
  version: 1;
  id: string;
  name: string;
  /** Which sensor this pipeline is looking through. */
  uid: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  updatedAt: number;
}

/** The envelope around every node's result, per the plan's debug data model. */
export interface NodeEnvelope {
  frameId: number;
  timestamp: number;
  nodeId: string;
  type: string;
  domain: NodeDomain;
  executionTimeMs: number;
  /** Rendered output per port id. Large planes are sent as base64. */
  outputs: Record<string, unknown>;
  /** Anything the viewer draws but the next node does not consume. */
  debug: Record<string, unknown>;
  /** Counters for the node's header: candidates, accepted, rejected, … */
  metrics: Record<string, number | string>;
  /** Resolved parameters actually used for this run. */
  parameters: Record<string, number>;
  error?: string;
}

export interface FramePair {
  /** The sensor's own frame number: RAW and REPORT of one frame share it. */
  frame: number;
  uid: string;
  receivedAt: number;
  /** 768 temperatures in degrees C, row-major, y then x. */
  temps: Float32Array;
  tMin: number;
  step: number;
  /** What the sensor itself decided for this exact frame, if the REPORT arrived. */
  deviceDetections: DeviceDetection[] | null;
  deviceFlags: number | null;
}

export interface DeviceDetection {
  x: number;
  y: number;
  area: number;
  contrast: number;
  peak: number;
  heat: number;
}

/** One entry of the change log: every parameter write, with the way back. */
export interface AuditEntry {
  at: number;
  uid: string;
  nodeId: string;
  param: string;
  binding: ParamBinding['kind'];
  from: number | null;
  to: number;
  by: string;
  /** When an uncommitted live change will be put back. */
  revertAt: number | null;
  action: 'apply' | 'commit' | 'revert' | 'persist';
}
