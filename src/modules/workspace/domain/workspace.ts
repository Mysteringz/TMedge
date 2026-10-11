/**
 * The team's side of the algo console's landing page: a mailbox between the
 * people who hold accounts, and a board of feature requests and tasks.
 *
 * None of this touches a sensor, a parameter or a student. It is kept apart
 * from the operational modules on purpose: a note to a colleague must never
 * be able to change what the pipeline does, and nothing a student can reach
 * reads it.
 */

/** Bounds on what one person can put in the store. The whole of it is rewritten on every change. */
export const LIMITS = {
  subject: 120, body: 4000, recipients: 32,
  title: 120, detail: 2000,
  messages: 1000, requests: 500, tasks: 1000,
  /** Rows a mailbox listing returns per box; older mail stays stored and searchable by id. */
  listed: 100, preview: 140,
} as const;

export const REQUEST_STATUSES = ['open', 'planned', 'in-progress', 'shipped', 'declined'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
/** A decided request no longer collects votes. */
export const CLOSED_REQUEST: ReadonlySet<RequestStatus> = new Set(['shipped', 'declined']);

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** Somebody who can be written to: an enabled account. `since` is when that account was created. */
export interface Member { name: string; since: number; /** What they work on (ML, front-end, ...): a label, not access. */ teamRoles: string[] }

/** The person a request is made by, with what their role allows on the board. */
export interface Actor extends Member {
  /** Operator, engineer or admin: may change a request's status and manage tasks. */
  canTriage: boolean;
  isAdmin: boolean;
}

export interface StoredMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: number;
  /** The message this one answers, if it was a reply. A hint for the reader, not a thread. */
  replyTo: string | null;
  /** Recipients who have opened it. Never shown to the sender. */
  readBy: string[];
  /** People who removed it from their own mailbox. It leaves the file when everyone has. */
  hiddenFor: string[];
}
export interface MailDocument { version: 1; messages: StoredMessage[] }

export interface StoredRequest {
  id: string;
  title: string;
  detail: string;
  author: string;
  status: RequestStatus;
  votes: string[];
  createdAt: number;
  updatedAt: number;
  /** Goes up on every edit; a save made against an older one is refused. Votes do not count as edits. */
  revision: number;
}
export interface StoredTask {
  id: string;
  title: string;
  detail: string;
  createdBy: string;
  assignee: string | null;
  status: TaskStatus;
  /** A calendar day, `YYYY-MM-DD`, or none. */
  due: string | null;
  /** The feature request this task delivers, if it came from one. */
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export interface BoardDocument { version: 1; nextRequest: number; nextTask: number; requests: StoredRequest[]; tasks: StoredTask[] }

export interface MessageHeader {
  id: string; box: 'inbox' | 'sent'; from: string; to: string[]; subject: string; preview: string;
  sentAt: number; read: boolean; replyTo: string | null;
}
export interface MessageView extends MessageHeader { body: string }
export interface MailboxView { unread: number; inbox: MessageHeader[]; sent: MessageHeader[]; omitted: { inbox: number; sent: number } }

export interface RequestView extends Omit<StoredRequest, 'votes'> {
  votes: number;
  voted: boolean;
  /** Tasks made from this request that are not done yet. */
  openTasks: number;
  can: { edit: boolean; triage: boolean; vote: boolean; remove: boolean };
}
export interface TaskView extends StoredTask {
  can: { edit: boolean; status: boolean; remove: boolean };
}
export interface BoardView { requests: RequestView[]; tasks: TaskView[] }

export type WorkspaceErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION' | 'NOT_FOUND' | 'STALE_REVISION' | 'CLOSED' | 'FULL' | 'RATE_LIMITED' | 'STORAGE_UNAVAILABLE';

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, readonly status: number, message: string) { super(message); }
}

const invalid = (message: string): never => { throw new WorkspaceError('VALIDATION', 400, message); };

/** A plain JSON object with only the named keys; anything else is a mistake worth saying. */
export function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A JSON object is required.');
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) return invalid(`Unknown field: ${extra.slice(0, 40)}.`);
  return body;
}

// Control characters would let a subject draw over the row beside it; a tab or
// a line break is kept only where a paragraph is expected.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;

/** One line of text: trimmed, runs of white space collapsed, 1 to `max` characters. */
export function oneLine(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') return invalid(`${what} is required.`);
  const cleaned = value.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return invalid(`${what} is required.`);
  if (cleaned.length > max) return invalid(`${what} can be at most ${max} characters.`);
  return cleaned;
}

/** Paragraphs: line breaks kept, 0 (when optional) to `max` characters. */
export function paragraphs(value: unknown, max: number, what: string, required: boolean): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') return invalid(`${what} must be text.`);
  const cleaned = value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (!cleaned && required) return invalid(`${what} is required.`);
  if (cleaned.length > max) return invalid(`${what} can be at most ${max} characters.`);
  return cleaned;
}

/** The revision a save was made against. */
export function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid('The current revision is required.');
  return value;
}

/** `YYYY-MM-DD` naming a real day, or null for no date. */
export function dayOrNull(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('A due date is a day, as YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00Z`);
  // The round trip is what refuses the 31st of February.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return invalid('That due date is not a day on the calendar.');
  return value;
}
