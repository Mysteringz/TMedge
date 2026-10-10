import { permissionChanged } from './entities/admin-session/index.tsx';
/** Talking to the edge. Every write carries the header a form cannot send. */
export interface PortSpec { id: string; label: string; type: string }
export interface ParamSpec {
  id: string; label: string; min: number; max: number; step: number;
  unit?: string; scale?: number; help?: string;
  binding: { kind: 'device'; param: string } | { kind: 'edge'; path: string } | { kind: 'local' };
}
export interface NodeSpec {
  type: string; name: string; version: string; category: string;
  domain: 'device' | 'edge' | 'view';
  inputs: PortSpec[]; outputs: PortSpec[]; params: ParamSpec[]; summary: string;
}
export interface GraphNode {
  id: string; type: string; name: string; enabled: boolean;
  position: { x: number; y: number }; params: Record<string, number>;
}
export interface GraphEdge {
  id: string; sourceNode: string; sourcePort: string; targetNode: string; targetPort: string;
}
export interface Pipeline {
  version: 1; id: string; name: string; uid: string;
  nodes: GraphNode[]; edges: GraphEdge[]; updatedAt: number;
}
export interface Envelope {
  frameId: number; timestamp: number; nodeId: string; type: string;
  domain: 'device' | 'edge' | 'view';
  executionTimeMs: number;
  outputs: Record<string, unknown>;
  debug: Record<string, unknown>;
  metrics: Record<string, number | string>;
  parameters: Record<string, number>;
  error?: string;
}
export interface RunResult {
  frameId: number; timestamp: number; uid: string;
  envelopes: Envelope[]; previewUnavailable: string | null;
  dirty?: string[]; pending?: PendingChange[];
}
export interface PendingChange {
  uid: string; nodeId: string; param: string; binding: string;
  from: number | null; to: number; at: number; revertAt: number;
  /** Null until the node's STATUS shows it took the command. */
  confirmedAt: number | null;
  cmdSeq: number | null;
  restoring?: boolean;
}
export interface SourceNode {
  uid: string; label: string; floorId: string; simulated: boolean;
  /** A dual-cam rig: there is a live camera picture to show beside the thermal. */
  rgb: boolean;
  online: boolean; rawEvery: number | null; frames: number; published: boolean;
}

const write = { 'content-type': 'application/json', 'x-tm-algo': '1' };

async function json<T>(r: Response): Promise<T> {
  // The session ended under us (expired, signed out in another tab, account
  // removed): go and sign in, then come back to this page.
  permissionChanged(r.status);
  if (r.status === 401) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  catalogue: () => fetch('/api/catalogue').then(json<{
    nodes: NodeSpec[]; edgeParams: Record<string, { lo: number; hi: number; unit: string }>;
    revertMs: number; preview: { available: boolean; reason: string | null };
  }>),
  sources: (signal?: AbortSignal) => fetch('/api/sources', { signal }).then(json<{ nodes: SourceNode[] }>),
  pipeline: () => fetch('/api/pipeline').then(json<{
    pipeline: Pipeline; problems: { where: string; message: string }[]; dirty: string[]; saved: string[];
  }>),
  putPipeline: (p: Pipeline) => fetch('/api/pipeline', { method: 'PUT', headers: write, body: JSON.stringify(p) })
    .then(json<{ ok: boolean; pipeline: Pipeline }>),
  savePipeline: (name: string) => fetch('/api/pipeline/save', { method: 'POST', headers: write, body: JSON.stringify({ name }) }).then(json),
  /**
   * The other half of "save": the server has the graph, the picker that lists
   * `saved` and calls this is not built yet, so a saved pipeline is currently
   * write-only. Kept because it works and is what the picker will call.
   */
  loadPipeline: (name: string) => fetch('/api/pipeline/load', { method: 'POST', headers: write, body: JSON.stringify({ name }) })
    .then(json<{ pipeline: Pipeline }>),
  resetPipeline: () => fetch('/api/pipeline/reset', { method: 'POST', headers: write }).then(json<{ pipeline: Pipeline }>),
  frames: (uid: string) => fetch(`/api/frames?uid=${encodeURIComponent(uid)}`)
    .then(json<{ uid: string; frames: { frame: number; at: number; detections: number | null }[] }>),
  run: (frame?: number, only?: string) =>
    fetch('/api/run', { method: 'POST', headers: write, body: JSON.stringify({ frame, only }) }).then(json<RunResult>),
  mode: (mode: 'live' | 'pause' | 'step', frame?: number) =>
    fetch('/api/mode', { method: 'POST', headers: write, body: JSON.stringify({ mode, frame }) })
      .then(json<{ live: boolean; frame?: number }>),
  params: (signal?: AbortSignal) => fetch('/api/params', { signal }).then(json<{
    device: Record<string, number>; edge: Record<string, number>;
    pending: PendingChange[]; audit: unknown[];
  }>),
  apply: (nodeId: string, param: string, value: number, uid?: string) =>
    fetch('/api/params/apply', { method: 'POST', headers: write, body: JSON.stringify({ nodeId, param, value, uid }) })
      .then(json<{ ok: boolean; local?: boolean; change?: PendingChange }>),
  commit: (param: string, uid?: string) =>
    fetch('/api/params/commit', { method: 'POST', headers: write, body: JSON.stringify({ param, uid }) }).then(json),
  revert: (param: string, uid?: string) =>
    fetch('/api/params/revert', { method: 'POST', headers: write, body: JSON.stringify({ param, uid }) }).then(json),
  persist: (uid?: string) =>
    fetch('/api/params/persist', { method: 'POST', headers: write, body: JSON.stringify({ uid }) }).then(json),
  resetBackground: (uid?: string) =>
    fetch('/api/node/reset-background', { method: 'POST', headers: write, body: JSON.stringify({ uid }) }).then(json),
  wsToken: () => fetch('/api/ws-token').then(json<{ token: string }>),
  pairs: () => fetch('/api/pairs').then(json<{
    samples: number; withPeople: number; bytes: number; oldest: number | null; newest: number | null;
    recording: boolean; mode: RecordMode; capturing: boolean; lastSkipped: string | null; rgbNodes: string[];
  }>),
  record: (mode: RecordMode) => fetch('/api/pairs/record', { method: 'POST', headers: write, body: JSON.stringify({ mode }) })
    .then(json<{ ok: boolean; samples: number; recording: boolean; mode: RecordMode; capturing: boolean }>),
};

/** Mirrors src/algo/autorecord.ts: never, while a person is detected, or always. */
export type RecordMode = 'off' | 'auto' | 'on';

/** base64 plane -> bytes, for the canvas viewers. */
export function unpack(b64: string): Uint8Array | null {
  if (typeof b64 !== 'string' || b64.length > 1024) return null;
  try {
    const bin = atob(b64);
    if (bin.length !== 32 * 24) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
