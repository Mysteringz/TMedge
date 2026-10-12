import { permissionChanged } from '../admin-session/index.tsx';

/** What a person may be emailed about. Mirrors EMAIL_TOPICS on the edge. */
export const EMAIL_TOPICS = [
  { id: 'sensor', label: 'Sensors', detail: 'A sensor goes offline or needs attention.' },
  { id: 'training', label: 'Training jobs', detail: 'A job finishes or fails.' },
  { id: 'firmware', label: 'Firmware', detail: 'A build or a rollout finishes, fails or stops.' },
  { id: 'parameter', label: 'Live parameter changes', detail: 'A temporary change is waiting to be committed, or has reverted.' },
  { id: 'mail', label: 'Team mail', detail: 'Someone on the team writes to you.' },
  { id: 'task', label: 'Tasks', detail: 'A task is assigned to you.' },
] as const;

export interface OwnAccount {
  name: string; role: 'viewer' | 'operator' | 'engineer' | 'admin'; teamRoles: string[]; createdAt: number;
  namedAccount: boolean;
  /** `confirmed`: a code sent to the address was typed back. Nothing else is sent to it until then. */
  settings: { email: string | null; notify: string[]; confirmed: boolean };
  /** False until this server can send email: the address is kept, and nothing is sent to it. */
  emailDelivery: boolean;
}

export class OwnAccountError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function ownAccount<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/account${path}`, { method, signal, headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new OwnAccountError('UNAVAILABLE', 'Could not reach the console.'); }
  // Only a lost session is the shell's business. A refusal here (a wrong
  // current password, local mode) is about this form, not about access.
  if (response.status === 401) permissionChanged(401);
  const value = await response.json().catch(() => null) as { data: T; error: { code: string; message: string } | null } | null;
  if (!response.ok || !value) throw new OwnAccountError(value?.error?.code ?? 'UNAVAILABLE', value?.error?.message ?? 'Account settings are unavailable.');
  return value.data;
}
