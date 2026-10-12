/**
 * What the web flasher asks the edge: whether adoption can keep a
 * registration, to queue the board on the USB port, and the answer.
 *
 * Everything else it does -- the firmware, the Wi-Fi password, the signing
 * key -- goes to the board and never comes near these calls.
 */
import { permissionChanged } from '../../entities/admin-session/index.tsx';

export interface AdoptionState {
  ready: boolean;
  requests: { id: string; uid: string; pairingCode: string }[];
  nodes: { uid: string; label: string; placed: boolean; verified: boolean; online: boolean }[];
}
export type Asked = { status: 'registered'; uid: string } | { status: 'pending'; id: string; uid: string; pairingCode: string };

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/adoption${path}`, body === undefined ? { signal } : {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('could not reach the console');
  }
  permissionChanged(response.status);
  if (response.status === 401) throw new Error('your console session ended; sign in again');
  // A sign-in page or a proxy's refusal is not an answer about a node.
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`the console answered HTTP ${response.status} without an adoption response`);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `the adoption service answered HTTP ${response.status}`);
  return result;
}

export const flashApi = {
  state: (signal?: AbortSignal) => call<AdoptionState>('', undefined, signal),
  ask: (board: { uid: string; label: string; firmware: string | null }) => call<Asked>('/requests', board),
  answer: (id: string, verdict: 'approve' | 'deny', uid: string, pairingCode: string) =>
    call<{ ok: boolean }>(`/requests/${encodeURIComponent(id)}/${verdict}`, verdict === 'approve' ? { uid, pairingCode } : {}),
};
