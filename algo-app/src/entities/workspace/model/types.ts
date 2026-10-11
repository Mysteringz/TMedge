/**
 * What `/api/workspace` returns. Mirrors src/modules/workspace/domain/workspace.ts
 * on the server; this app is built on its own and cannot import it.
 */
export const LIMITS = { subject: 120, body: 4000, title: 120, detail: 2000 } as const;

export const REQUEST_STATUSES = ['open', 'planned', 'in-progress', 'shipped', 'declined'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = { open: 'Open', planned: 'Planned', 'in-progress': 'In progress', shipped: 'Shipped', declined: 'Declined' };

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };

export interface MessageHeader {
  id: string; box: 'inbox' | 'sent'; from: string; to: string[]; subject: string; preview: string;
  sentAt: number; read: boolean; replyTo: string | null;
}
export interface Message extends MessageHeader { body: string }
export interface Mailbox { unread: number; inbox: MessageHeader[]; sent: MessageHeader[]; omitted: { inbox: number; sent: number } }

export interface FeatureRequest {
  id: string; title: string; detail: string; author: string; status: RequestStatus;
  votes: number; voted: boolean; openTasks: number; createdAt: number; updatedAt: number; revision: number;
  can: { edit: boolean; triage: boolean; vote: boolean; remove: boolean };
}
export interface Task {
  id: string; title: string; detail: string; createdBy: string; assignee: string | null; status: TaskStatus;
  due: string | null; requestId: string | null; createdAt: number; updatedAt: number; revision: number;
  can: { edit: boolean; status: boolean; remove: boolean };
}

export interface WorkspaceSnapshot {
  generatedAt: number;
  me: { name: string; canTriage: boolean; isAdmin: boolean };
  /** Everyone who can be written to, the reader included. */
  members: string[];
  mail: Mailbox;
  board: { requests: FeatureRequest[]; tasks: Task[] };
}

export interface MessageDraft { to: string[]; subject: string; body: string; replyTo: string | null }
export interface RequestDraft { title: string; detail: string }
export interface TaskDraft { title: string; detail: string; assignee: string | null; due: string | null; requestId: string | null }
