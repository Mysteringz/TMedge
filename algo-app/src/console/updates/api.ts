import { permissionChanged } from '../../entities/admin-session/index.tsx';
/** Module 04 shares the console's authenticated OTA services and write header. */
export interface FirmwareBuild {
  id: string; sha256: string; size: number; version: string;
  state: 'uploading' | 'building' | 'ready' | 'failed';
  builtAt: number | null; files: number; error?: string;
}
export interface NodeUpdate {
  uid: string; label: string; state: string; percent: number; error?: string;
}
export interface Rollout {
  id: string; buildId: string; version: string;
  stage: 'pilot' | 'rest' | 'done' | 'stopped';
  note: string; startedAt: number; nodes: NodeUpdate[];
}
export interface FirmwareView {
  pio: boolean; builds: FirmwareBuild[]; diskBytes: number;
  building: { startedAt: number; log: string[]; error?: string; lifecycle?: string } | null;
  rollout: Rollout | null; history: Rollout[];
}
export interface UpdateNode {
  uid: string; label: string; registered: boolean; floorId: string | null;
  online: boolean; address: string | null; transport: string | null;
}
export interface UpdateLayout { floors: { id: string; name: string }[] }
export type UpdateTarget = { kind: 'all' } | { kind: 'floor'; floorId: string } | { kind: 'node'; uid: string };

const BASE = '/console-app/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, options);
  permissionChanged(response.status);
  if (response.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new Error('Your session ended. Sign in to continue.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `The edge returned HTTP ${response.status}.`);
  }
  return await response.json() as T;
}

function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST', signal,
    headers: { 'x-tm-console': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const updatesApi = {
  firmware: (signal?: AbortSignal) => request<FirmwareView>('/firmware', { signal }),
  layout: (signal?: AbortSignal) => request<UpdateLayout>('/layout', { signal }),
  nodes: (signal?: AbortSignal) => request<{ nodes: UpdateNode[] }>('/state', { signal }),
  upload: (signal?: AbortSignal) => post<{ uploadId: string }>('/firmware/uploads', undefined, signal),
  file: (id: string, path: string, bytes: ArrayBuffer, signal?: AbortSignal) => request<{ ok: boolean }>(
    `/firmware/uploads/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, {
      method: 'POST', signal, body: bytes,
      headers: { 'x-tm-console': '1', 'content-type': 'application/octet-stream' },
    }),
  build: (id: string, signal?: AbortSignal) => post<{ ok: boolean }>(`/firmware/uploads/${encodeURIComponent(id)}/build`, undefined, signal),
  rollout: (buildId: string, target: UpdateTarget, signal?: AbortSignal) => post<Rollout>('/firmware/rollout', { buildId, target }, signal),
  stop: (signal?: AbortSignal) => post<{ ok: boolean }>('/firmware/rollout/cancel', undefined, signal),
};

/** Match the server's target eligibility, including a live downlink route. */
export function eligibleNodes(nodes: UpdateNode[], target: UpdateTarget): UpdateNode[] {
  return nodes.filter((node) => node.registered && node.online && node.address !== null && node.transport !== null
    && (target.kind === 'all' || (target.kind === 'node' ? node.uid === target.uid : node.floorId === target.floorId)));
}

export function targetOf(value: string): UpdateTarget {
  if (value.startsWith('floor:')) return { kind: 'floor', floorId: value.slice(6) };
  if (value.startsWith('node:')) return { kind: 'node', uid: value.slice(5) };
  return { kind: 'all' };
}
