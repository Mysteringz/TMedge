import { permissionChanged } from '../../admin-session/index.tsx';
import type { FeatureRequest, Message, MessageDraft, RequestDraft, RequestStatus, Task, TaskDraft, TaskStatus, WorkspaceSnapshot } from '../model/types.ts';

export class WorkspaceRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/** Same-origin cookie request. Losing access is told to the shell, which signs out or re-reads the role. */
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/workspace${path}`, {
      method, signal, credentials: 'same-origin',
      // The header is what marks a write as coming from this page and not a form on another site.
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-tm-algo': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new WorkspaceRequestError('UNREACHABLE', 0, 'Could not reach the console. Check your connection and try again.');
  }
  let value: { data: T | null; error: { code: string; message: string } | null } | null = null;
  try { value = await response.json(); } catch { /* a proxy's error page, not ours */ }
  if (!response.ok || !value || value.data === null) {
    // Only a lost session is the shell's business. A 403 here is usually the
    // board having moved on since the page last read it (a request decided
    // while its author was editing), and it carries its own explanation.
    if (response.status === 401) permissionChanged(401);
    throw new WorkspaceRequestError(value?.error?.code ?? 'UNAVAILABLE', response.status, value?.error?.message ?? 'The team workspace is unavailable right now.');
  }
  return value.data;
}

const at = (kind: string, id: string) => `/${kind}/${encodeURIComponent(id)}`;

export const workspaceApi = {
  snapshot: (signal: AbortSignal) => request<WorkspaceSnapshot>('', 'GET', undefined, signal),

  openMessage: (id: string, signal?: AbortSignal) => request<Message>(at('messages', id), 'GET', undefined, signal),
  sendMessage: (draft: MessageDraft) => request<Message>('/messages', 'POST', { to: draft.to, subject: draft.subject, body: draft.body, ...(draft.replyTo ? { replyTo: draft.replyTo } : {}) }),
  markMessage: (id: string, read: boolean) => request<Message>(`${at('messages', id)}/read`, 'POST', { read }),
  removeMessage: (id: string) => request<{ id: string }>(at('messages', id), 'DELETE'),

  createRequest: (draft: RequestDraft) => request<FeatureRequest>('/requests', 'POST', draft),
  updateRequest: (id: string, revision: number, change: Partial<RequestDraft> & { status?: RequestStatus }) => request<FeatureRequest>(at('requests', id), 'PATCH', { revision, ...change }),
  vote: (id: string, vote: boolean) => request<FeatureRequest>(`${at('requests', id)}/vote`, 'POST', { vote }),
  removeRequest: (id: string, revision: number) => request<{ id: string }>(at('requests', id), 'DELETE', { revision }),

  createTask: (draft: TaskDraft) => request<Task>('/tasks', 'POST', draft),
  updateTask: (id: string, revision: number, change: Partial<Omit<TaskDraft, 'requestId'>> & { status?: TaskStatus }) => request<Task>(at('tasks', id), 'PATCH', { revision, ...change }),
  removeTask: (id: string, revision: number) => request<{ id: string }>(at('tasks', id), 'DELETE', { revision }),
};
