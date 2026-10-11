/**
 * Feature requests anyone on the team may file and vote on, and the tasks
 * that are handed out to deliver them.
 *
 * Who may do what, in one place:
 *   - anyone signed in files a request and votes;
 *   - its author edits or withdraws it while it is still open;
 *   - write access (operator, engineer, admin) decides a request's status and
 *     creates, edits, assigns and deletes tasks;
 *   - whoever a task is assigned to moves its status, whatever their role;
 *   - an admin may delete any request.
 */
import {
  CLOSED_REQUEST, dayOrNull, fields, LIMITS, oneLine, paragraphs, REQUEST_STATUSES, revisionOf, TASK_STATUSES, WorkspaceError,
  type Actor, type BoardDocument, type BoardView, type Member, type RequestStatus, type RequestView, type StoredRequest, type StoredTask,
  type TaskStatus, type TaskView,
} from '../domain/workspace.js';
import type { DocumentStore } from '../repositories/document-store.js';

const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const REQUEST_ID = /^R-[1-9]\d{0,8}$/, TASK_ID = /^T-[1-9]\d{0,8}$/;
const isRequestStatus = (value: unknown): value is RequestStatus => REQUEST_STATUSES.some((status) => status === value);
const isTaskStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.some((status) => status === value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Refuses anything that is not a board this code wrote. */
export function parseBoard(value: unknown): BoardDocument {
  const bad = (): never => { throw new Error('not a board'); };
  const document = value as Partial<BoardDocument> | null;
  if (!document || document.version !== 1 || !isCounter(document.nextRequest) || !isCounter(document.nextTask)
    || !Array.isArray(document.requests) || document.requests.length > LIMITS.requests
    || !Array.isArray(document.tasks) || document.tasks.length > LIMITS.tasks) return bad();
  for (const r of document.requests as Partial<StoredRequest>[]) {
    if (!r || typeof r.id !== 'string' || !REQUEST_ID.test(r.id) || typeof r.title !== 'string' || !r.title || r.title.length > LIMITS.title
      || typeof r.detail !== 'string' || r.detail.length > LIMITS.detail || typeof r.author !== 'string' || !NAME.test(r.author)
      || !isRequestStatus(r.status) || !Array.isArray(r.votes) || r.votes.some((name) => typeof name !== 'string' || !NAME.test(name))
      || !isTime(r.createdAt) || !isTime(r.updatedAt) || !isRevision(r.revision)) return bad();
  }
  for (const t of document.tasks as Partial<StoredTask>[]) {
    if (!t || typeof t.id !== 'string' || !TASK_ID.test(t.id) || typeof t.title !== 'string' || !t.title || t.title.length > LIMITS.title
      || typeof t.detail !== 'string' || t.detail.length > LIMITS.detail || typeof t.createdBy !== 'string' || !NAME.test(t.createdBy)
      || !(t.assignee === null || (typeof t.assignee === 'string' && NAME.test(t.assignee))) || !isTaskStatus(t.status)
      || !(t.due === null || (typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due)))
      || !(t.requestId === null || (typeof t.requestId === 'string' && REQUEST_ID.test(t.requestId)))
      || !isTime(t.createdAt) || !isTime(t.updatedAt) || !isRevision(t.revision)) return bad();
  }
  const ids = [...document.requests.map((r) => r.id), ...document.tasks.map((t) => t.id)];
  if (new Set(ids).size !== ids.length) return bad();
  return document as BoardDocument;
}

export const emptyBoard = (): BoardDocument => ({ version: 1, nextRequest: 1, nextTask: 1, requests: [], tasks: [] });

const forbidden = (message: string): never => { throw new WorkspaceError('FORBIDDEN', 403, message); };
const stale = (): never => { throw new WorkspaceError('STALE_REVISION', 409, 'Someone else changed this. Refresh and try again.'); };

export class Board {
  constructor(
    private readonly store: DocumentStore<BoardDocument>,
    private readonly members: () => Member[],
    private readonly now: () => number = Date.now,
  ) {}

  private requestView(request: StoredRequest, document: BoardDocument, actor: Actor): RequestView {
    const { votes, ...rest } = request;
    const own = request.author === actor.name && request.status === 'open';
    return {
      ...rest, votes: votes.length, voted: votes.includes(actor.name),
      openTasks: document.tasks.filter((task) => task.requestId === request.id && task.status !== 'done').length,
      can: { edit: own || actor.canTriage, triage: actor.canTriage, vote: !CLOSED_REQUEST.has(request.status), remove: own || actor.isAdmin },
    };
  }

  private taskView(task: StoredTask, actor: Actor): TaskView {
    return { ...task, can: { edit: actor.canTriage, status: actor.canTriage || task.assignee === actor.name, remove: actor.canTriage } };
  }

  view(actor: Actor): BoardView {
    const document = this.store.read();
    return {
      // Most wanted first; the list is small enough to send whole.
      requests: document.requests.map((request) => this.requestView(request, document, actor))
        .sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt),
      tasks: document.tasks.map((task) => this.taskView(task, actor)).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  private request(draft: BoardDocument, id: string): StoredRequest {
    const found = REQUEST_ID.test(id) ? draft.requests.find((request) => request.id === id) : undefined;
    if (!found) throw new WorkspaceError('NOT_FOUND', 404, 'That request no longer exists.');
    return found;
  }

  private task(draft: BoardDocument, id: string): StoredTask {
    const found = TASK_ID.test(id) ? draft.tasks.find((task) => task.id === id) : undefined;
    if (!found) throw new WorkspaceError('NOT_FOUND', 404, 'That task no longer exists.');
    return found;
  }

  createRequest(actor: Actor, input: unknown): RequestView {
    const body = fields(input, ['title', 'detail']);
    const title = oneLine(body.title, LIMITS.title, 'A title'), detail = paragraphs(body.detail, LIMITS.detail, 'The description', false);
    return this.store.update((draft) => {
      if (draft.requests.length >= LIMITS.requests) throw new WorkspaceError('FULL', 409, `The board holds ${LIMITS.requests} requests. Delete shipped or declined ones to make room.`);
      const at = this.now();
      const request: StoredRequest = { id: `R-${draft.nextRequest++}`, title, detail, author: actor.name, status: 'open', votes: [actor.name], createdAt: at, updatedAt: at, revision: 1 };
      draft.requests.push(request);
      return this.requestView(request, draft, actor);
    });
  }

  updateRequest(actor: Actor, id: string, input: unknown): RequestView {
    const body = fields(input, ['revision', 'title', 'detail', 'status']);
    const revision = revisionOf(body.revision);
    const title = body.title === undefined ? undefined : oneLine(body.title, LIMITS.title, 'A title');
    const detail = body.detail === undefined ? undefined : paragraphs(body.detail, LIMITS.detail, 'The description', false);
    if (body.status !== undefined && !isRequestStatus(body.status)) throw new WorkspaceError('VALIDATION', 400, 'Choose a status from the list.');
    const status = body.status;
    if (title === undefined && detail === undefined && status === undefined) throw new WorkspaceError('VALIDATION', 400, 'Nothing to change.');
    return this.store.update((draft) => {
      const request = this.request(draft, id);
      if (status !== undefined && !actor.canTriage) forbidden('Changing a request\'s status needs write access.');
      if ((title !== undefined || detail !== undefined) && !actor.canTriage && !(request.author === actor.name && request.status === 'open')) {
        forbidden(request.author === actor.name ? 'A request can be edited by its author only while it is open.' : 'Only its author can edit this request.');
      }
      if (request.revision !== revision) stale();
      if (title !== undefined) request.title = title;
      if (detail !== undefined) request.detail = detail;
      if (status !== undefined) request.status = status;
      request.updatedAt = this.now(); request.revision += 1;
      return this.requestView(request, draft, actor);
    });
  }

  vote(actor: Actor, id: string, input: unknown): RequestView {
    const body = fields(input, ['vote']);
    if (typeof body.vote !== 'boolean') throw new WorkspaceError('VALIDATION', 400, 'Vote must be true or false.');
    const vote = body.vote;
    return this.store.update((draft) => {
      const request = this.request(draft, id);
      if (CLOSED_REQUEST.has(request.status)) throw new WorkspaceError('CLOSED', 409, 'This request has been decided and no longer takes votes.');
      const others = request.votes.filter((name) => name !== actor.name);
      // One vote a person, however many times it is sent.
      request.votes = vote ? [...others, actor.name] : others;
      return this.requestView(request, draft, actor);
    });
  }

  removeRequest(actor: Actor, id: string, input: unknown): { id: string; removed: true } {
    const revision = revisionOf(fields(input, ['revision']).revision);
    return this.store.update((draft) => {
      const request = this.request(draft, id);
      if (!actor.isAdmin && !(request.author === actor.name && request.status === 'open')) {
        forbidden(request.author === actor.name ? 'A request can be withdrawn by its author only while it is open.' : 'Only its author or an admin can delete this request.');
      }
      if (request.revision !== revision) stale();
      draft.requests = draft.requests.filter((item) => item !== request);
      // Its tasks are still work somebody was given; they only lose the link.
      for (const task of draft.tasks) if (task.requestId === id) task.requestId = null;
      return { id, removed: true as const };
    });
  }

  private assignee(value: unknown): string | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !this.members().some((member) => member.name === value)) throw new WorkspaceError('VALIDATION', 400, 'Assign the task to a current member, or leave it unassigned.');
    return value;
  }

  createTask(actor: Actor, input: unknown): TaskView {
    const body = fields(input, ['title', 'detail', 'assignee', 'due', 'requestId']);
    if (!actor.canTriage) forbidden('Creating a task needs write access.');
    const title = oneLine(body.title, LIMITS.title, 'A title'), detail = paragraphs(body.detail, LIMITS.detail, 'The notes', false);
    const assignee = body.assignee === undefined ? null : this.assignee(body.assignee), due = body.due === undefined ? null : dayOrNull(body.due);
    const requestId = body.requestId === undefined || body.requestId === null ? null : String(body.requestId);
    return this.store.update((draft) => {
      if (draft.tasks.length >= LIMITS.tasks) throw new WorkspaceError('FULL', 409, `The board holds ${LIMITS.tasks} tasks. Delete finished ones to make room.`);
      if (requestId !== null && !draft.requests.some((request) => request.id === requestId)) throw new WorkspaceError('VALIDATION', 400, 'The request this task is for no longer exists.');
      const at = this.now();
      const task: StoredTask = { id: `T-${draft.nextTask++}`, title, detail, createdBy: actor.name, assignee, status: 'todo', due, requestId, createdAt: at, updatedAt: at, revision: 1 };
      draft.tasks.push(task);
      return this.taskView(task, actor);
    });
  }

  updateTask(actor: Actor, id: string, input: unknown): TaskView {
    const body = fields(input, ['revision', 'title', 'detail', 'assignee', 'due', 'status']);
    const revision = revisionOf(body.revision);
    const title = body.title === undefined ? undefined : oneLine(body.title, LIMITS.title, 'A title');
    const detail = body.detail === undefined ? undefined : paragraphs(body.detail, LIMITS.detail, 'The notes', false);
    const due = body.due === undefined ? undefined : dayOrNull(body.due);
    if (body.status !== undefined && !isTaskStatus(body.status)) throw new WorkspaceError('VALIDATION', 400, 'Choose a status from the list.');
    const status = body.status;
    const reassign = body.assignee !== undefined;
    if (title === undefined && detail === undefined && due === undefined && status === undefined && !reassign) throw new WorkspaceError('VALIDATION', 400, 'Nothing to change.');
    return this.store.update((draft) => {
      const task = this.task(draft, id);
      // The person doing the work reports on it; what the work *is*, and
      // whose it is, stays with those who hand it out.
      const onlyStatus = title === undefined && detail === undefined && due === undefined && !reassign;
      if (!actor.canTriage && !(onlyStatus && task.assignee === actor.name)) {
        forbidden(task.assignee === actor.name ? 'You can change the status of your task; editing or reassigning it needs write access.' : 'Changing this task needs write access, or for it to be assigned to you.');
      }
      if (task.revision !== revision) stale();
      if (title !== undefined) task.title = title;
      if (detail !== undefined) task.detail = detail;
      if (due !== undefined) task.due = due;
      // Someone already holding the task may have lost their account since;
      // only a *change* of assignee has to name a current member.
      if (reassign && body.assignee !== task.assignee) task.assignee = this.assignee(body.assignee);
      if (status !== undefined) task.status = status;
      task.updatedAt = this.now(); task.revision += 1;
      return this.taskView(task, actor);
    });
  }

  removeTask(actor: Actor, id: string, input: unknown): { id: string; removed: true } {
    const revision = revisionOf(fields(input, ['revision']).revision);
    return this.store.update((draft) => {
      const task = this.task(draft, id);
      if (!actor.canTriage) forbidden('Deleting a task needs write access.');
      if (task.revision !== revision) stale();
      draft.tasks = draft.tasks.filter((item) => item !== task);
      return { id, removed: true as const };
    });
  }
}
