/**
 * The board: feature requests anyone may file and vote on, and the tasks
 * handed out to deliver them. Every control here is offered only when the
 * server said this person may use it (`can`), so a role shows as fewer
 * buttons, not as buttons that refuse.
 */
import { useState } from 'react';
import {
  LIMITS, REQUEST_STATUSES, REQUEST_STATUS_LABEL, TASK_STATUSES, TASK_STATUS_LABEL, teamRoleText, workspaceApi,
  type FeatureRequest, type RequestStatus, type Task, type TaskStatus, type WorkspaceSnapshot, type WorkspaceState,
} from '../../../entities/workspace/index.ts';
import { ArrowLeft, CaretUp, FloppyDisk, PencilSimple, Plus, Trash } from '../../../console/icons.tsx';
import { Icons } from '../../charts/index.ts';
import { dayLabel, Dialog, Field, reason, today, when } from './parts.tsx';

const ACTIVE: ReadonlySet<RequestStatus> = new Set(['open', 'planned', 'in-progress']);

export function StatusTag({ status }: { status: RequestStatus | TaskStatus }) {
  const label = status in REQUEST_STATUS_LABEL ? REQUEST_STATUS_LABEL[status as RequestStatus] : TASK_STATUS_LABEL[status as TaskStatus];
  return <span className={`tag ws-tag ws-tag--${status}`}>{label}</span>;
}

function VoteButton({ request, busy, onVote }: { request: FeatureRequest; busy: boolean; onVote(): void }) {
  return (
    <button type="button" className={`ws-vote ${request.voted ? 'is-on' : ''}`} aria-pressed={request.voted} disabled={busy || !request.can.vote} onClick={onVote}
      aria-label={`${request.voted ? 'Remove your vote from' : 'Vote for'} ${request.title}. ${request.votes} ${request.votes === 1 ? 'vote' : 'votes'}.`}
      title={request.can.vote ? (request.voted ? 'You voted for this. Select to remove your vote.' : 'Vote for this') : 'Decided: no longer taking votes'}>
      <CaretUp /><span>{request.votes}</span>
    </button>
  );
}

export function RequestsPanel({ ws, snapshot, openId, now, onOpen, onNew, onEdit, onNewTask, onOpenTask, flash }: {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; openId: string | null; now: number;
  onOpen(id: string | null): void; onNew(): void; onEdit(request: FeatureRequest): void; onNewTask(requestId: string): void; onOpenTask(task: Task): void; flash(message: string): void;
}) {
  const [filter, setFilter] = useState<RequestStatus | null>(null);
  const [voting, setVoting] = useState('');
  const [error, setError] = useState('');
  const { requests, tasks } = snapshot.board;
  const vote = async (request: FeatureRequest) => {
    setVoting(request.id); setError('');
    try { await ws.act(() => workspaceApi.vote(request.id, !request.voted)); }
    catch (cause) { setError(reason(cause, 'Your vote was not counted.')); }
    finally { setVoting(''); }
  };

  const open = openId ? requests.find((request) => request.id === openId) : undefined;
  if (openId) {
    return open
      ? <RequestDetail key={open.id} ws={ws} request={open} tasks={tasks.filter((task) => task.requestId === open.id)} now={now} voting={voting === open.id} error={error}
        onVote={() => void vote(open)} onBack={() => onOpen(null)} onEdit={() => onEdit(open)} onNewTask={() => onNewTask(open.id)} onOpenTask={onOpenTask} flash={flash} />
      : <><div className="ws-bar"><BackButton label="Back to requests" onClick={() => onOpen(null)} /></div><p className="ws-empty" role="status">That request no longer exists.</p></>;
  }

  const counts = Object.fromEntries(REQUEST_STATUSES.map((status) => [status, requests.filter((request) => request.status === status).length])) as Record<RequestStatus, number>;
  // With no cell chosen the list is what is still in play, most wanted first.
  const rows = requests.filter((request) => (filter ? request.status === filter : ACTIVE.has(request.status)));
  return (
    <>
      <div className="ws-stats" role="group" aria-label="Requests by status. Select one to show only those.">
        {REQUEST_STATUSES.map((status) => (
          <button key={status} type="button" className={`ws-stat ${filter === status ? 'is-on' : ''}`} aria-pressed={filter === status} onClick={() => setFilter(filter === status ? null : status)}>
            <span className="ws-stat__value">{counts[status]}</span><span className="ws-stat__label">{REQUEST_STATUS_LABEL[status]}</span>
          </button>
        ))}
      </div>
      <div className="ws-bar">
        <span className="ws-bar__note">{filter ? `${REQUEST_STATUS_LABEL[filter]} requests` : 'Open, planned and in progress'} · most votes first</span>
        <button type="button" className="btn btn-primary cx-btn-px" onClick={onNew}>New request<Plus /></button>
      </div>
      {error && <p className="cx-hint is-err ws-foot" role="alert">{error}</p>}
      {rows.length === 0 ? (
        <p className="ws-empty">{requests.length === 0 ? 'No feature requests yet. File the first one: anyone on the team can, and everyone can vote.' : filter ? `No ${REQUEST_STATUS_LABEL[filter].toLowerCase()} requests.` : 'Nothing is open. Shipped and declined requests are under their counts above.'}</p>
      ) : (
        <ul className="ws-list" aria-label="Feature requests">
          {rows.map((request) => (
            <li key={request.id} className="ws-req">
              <VoteButton request={request} busy={voting === request.id} onVote={() => void vote(request)} />
              <button type="button" className="ws-row" onClick={() => onOpen(request.id)}>
                <span className="ws-row__main">
                  <span className="ws-row__title">{request.title}</span>
                  <span className="ws-row__sub"><span className="cx-mono">{request.id}</span> · {request.author} · {when(request.createdAt, now)}{request.openTasks > 0 && ` · ${request.openTasks} ${request.openTasks === 1 ? 'task' : 'tasks'} open`}</span>
                </span>
                <StatusTag status={request.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BackButton({ label, onClick }: { label: string; onClick(): void }) {
  return <button type="button" className="btn btn-ghost cx-btn-px ws-back" onClick={onClick}><span>{label}</span><ArrowLeft /></button>;
}

function RequestDetail({ ws, request, tasks, now, voting, error: voteError, onVote, onBack, onEdit, onNewTask, onOpenTask, flash }: {
  ws: WorkspaceState; request: FeatureRequest; tasks: Task[]; now: number; voting: boolean; error: string;
  onVote(): void; onBack(): void; onEdit(): void; onNewTask(): void; onOpenTask(task: Task): void; flash(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const setStatus = async (status: RequestStatus) => {
    setBusy(true); setError('');
    try { await ws.act(() => workspaceApi.updateRequest(request.id, request.revision, { status })); flash(`${request.id} is now ${REQUEST_STATUS_LABEL[status].toLowerCase()}.`); }
    catch (cause) { setError(reason(cause, 'The status was not changed.')); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await ws.act(() => workspaceApi.removeRequest(request.id, request.revision)); flash(`Request ${request.id} deleted.`); onBack(); }
    catch (cause) { setError(reason(cause, 'The request was not deleted.')); setBusy(false); }
  };
  return (
    <article className="ws-detail" aria-labelledby="ws-request-title">
      <div className="ws-bar">
        <BackButton label="Back to requests" onClick={onBack} />
        <div className="ws-actions">
          {request.can.edit && <button type="button" className="btn btn-ghost cx-btn-px" onClick={onEdit} disabled={busy}>Edit<PencilSimple /></button>}
          {request.can.triage && <button type="button" className="btn btn-secondary cx-btn-px" onClick={onNewTask} disabled={busy}>Create task<Plus /></button>}
        </div>
      </div>
      <div className="ws-detail__body">
        <div className="ws-detail__head">
          <VoteButton request={request} busy={voting} onVote={onVote} />
          <div>
            <h3 id="ws-request-title" className="ws-detail__title">{request.title}</h3>
            <p className="ws-detail__meta"><span className="cx-mono">{request.id}</span> · filed by <b>{request.author}</b> {when(request.createdAt, now)}{request.updatedAt > request.createdAt && ` · changed ${when(request.updatedAt, now)}`}</p>
          </div>
        </div>
        {request.detail ? <div className="ws-prose">{request.detail}</div> : <p className="ws-detail__meta">No description was given.</p>}
        <div className="ws-detail__row">
          {request.can.triage ? (
            <div className="field ws-inline-field">
              <label htmlFor="ws-request-status">Status</label>
              <select id="ws-request-status" className="input" value={request.status} disabled={busy} onChange={(event) => void setStatus(event.target.value as RequestStatus)}>
                {REQUEST_STATUSES.map((status) => <option key={status} value={status}>{REQUEST_STATUS_LABEL[status]}</option>)}
              </select>
            </div>
          ) : <p className="ws-detail__meta">Status <StatusTag status={request.status} /></p>}
        </div>
        {tasks.length > 0 && (
          <div>
            <h4 className="ws-detail__sub">Tasks for this request</h4>
            <ul className="ws-list ws-list--inset">
              {tasks.map((task) => (
                <li key={task.id}><button type="button" className="ws-row" onClick={() => onOpenTask(task)}>
                  <span className="ws-row__main"><span className="ws-row__title">{task.title}</span><span className="ws-row__sub"><span className="cx-mono">{task.id}</span> · {task.assignee ?? 'unassigned'}</span></span>
                  <StatusTag status={task.status} />
                </button></li>
              ))}
            </ul>
          </div>
        )}
        {(error || voteError) && <p className="cx-hint is-err" role="alert">{error || voteError}</p>}
        {request.can.remove && (
          <div className="ws-actions ws-detail__foot">
            {confirming ? (
              <>
                <span className="ws-confirm">Delete request {request.id} for everyone?{tasks.length > 0 && ' Its tasks stay, without the link.'}</span>
                <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => void remove()}>Delete request<Trash /></button>
                <button type="button" className="btn btn-ghost cx-btn-px" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
              </>
            ) : <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => setConfirming(true)}>Delete<Trash /></button>}
          </div>
        )}
      </div>
    </article>
  );
}

export type TaskFilter = 'mine' | 'everyone' | 'done';
const TASK_FILTERS: { id: TaskFilter; label: string }[] = [{ id: 'mine', label: 'Mine' }, { id: 'everyone', label: 'Everyone' }, { id: 'done', label: 'Done' }];
/** What is being worked on leads, then what is waiting; inside each, the nearest date first. */
const TASK_ORDER: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };

export function TasksPanel({ ws, snapshot, filter, now, onFilter, onNew, onOpen, flash }: {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; filter: TaskFilter; now: number;
  onFilter(filter: TaskFilter): void; onNew(): void; onOpen(task: Task): void; flash(message: string): void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const { tasks } = snapshot.board, me = snapshot.me;
  const day = today(now);
  const rows = tasks
    .filter((task) => (filter === 'done' ? task.status === 'done' : task.status !== 'done' && (filter === 'everyone' || task.assignee === me.name)))
    .sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status] || (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.updatedAt - a.updatedAt);
  const mine = tasks.filter((task) => task.status !== 'done' && task.assignee === me.name).length;
  const move = async (task: Task, status: TaskStatus) => {
    setBusy(task.id); setError('');
    try { await ws.act(() => workspaceApi.updateTask(task.id, task.revision, { status })); flash(`${task.id} moved to ${TASK_STATUS_LABEL[status].toLowerCase()}.`); }
    catch (cause) { setError(reason(cause, 'The task was not changed.')); }
    finally { setBusy(''); }
  };
  return (
    <>
      <div className="ws-bar">
        <div className="seg" role="radiogroup" aria-label="Which tasks">
          {TASK_FILTERS.map((option) => (
            <label key={option.id} className="seg-opt"><input type="radio" name="ws-task-filter" checked={filter === option.id} onChange={() => onFilter(option.id)} />{option.label}
              {option.id === 'mine' && mine > 0 && <span className="ws-count">{mine}<span className="ws-sr"> open</span></span>}</label>
          ))}
        </div>
        {me.canTriage && <button type="button" className="btn btn-primary cx-btn-px" onClick={onNew}>New task<Plus /></button>}
      </div>
      {error && <p className="cx-hint is-err ws-foot" role="alert">{error}</p>}
      {rows.length === 0 ? (
        <p className="ws-empty">
          {filter === 'mine' ? 'Nothing is assigned to you.' : filter === 'done' ? 'Nothing has been finished yet.' : 'No open tasks.'}
          {!me.canTriage && tasks.length === 0 && ' Tasks are created by members with write access.'}
        </p>
      ) : (
        <ul className="ws-list" aria-label="Tasks">
          {rows.map((task) => {
            const overdue = task.due !== null && task.status !== 'done' && task.due < day;
            return (
              <li key={task.id} className="ws-task">
                {task.can.status ? (
                  <select className="input ws-task__status" value={task.status} disabled={busy === task.id} aria-label={`Status of ${task.title}`} onChange={(event) => void move(task, event.target.value as TaskStatus)}>
                    {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABEL[status]}</option>)}
                  </select>
                ) : <span className="ws-task__status"><StatusTag status={task.status} /></span>}
                <button type="button" className="ws-row" onClick={() => onOpen(task)}>
                  <span className="ws-row__main">
                    <span className="ws-row__title">{task.title}</span>
                    <span className="ws-row__sub">
                      <span className="cx-mono">{task.id}</span> · {task.assignee === me.name ? 'you' : task.assignee ?? 'unassigned'}
                      {task.due && <> · {overdue ? <span className="ws-overdue"><Icons.WarningFilled size={14} />Overdue, was due {dayLabel(task.due)}</span> : `due ${dayLabel(task.due)}`}</>}
                      {task.requestId && <> · for <span className="cx-mono">{task.requestId}</span></>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Filing a request, or rewording one. */
export function RequestDialog({ ws, editing, onClose, onSaved }: { ws: WorkspaceState; editing: FeatureRequest | null; onClose(): void; onSaved(request: FeatureRequest): void }) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [detail, setDetail] = useState(editing?.detail ?? '');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const missing = !title.trim() ? 'Enter a title.' : '';
  const save = async () => {
    setTried(true); setError('');
    if (missing) { document.getElementById('ws-request-name')?.focus(); return; }
    setBusy(true);
    try {
      onSaved(await ws.act(() => (editing ? workspaceApi.updateRequest(editing.id, editing.revision, { title, detail }) : workspaceApi.createRequest({ title, detail }))));
    } catch (cause) { setError(reason(cause, 'The request was not saved.')); setBusy(false); }
  };
  return (
    <Dialog label="Feature requests" title={editing ? `Edit ${editing.id}` : 'New feature request'} busy={busy}
      dirty={title.trim() !== (editing?.title ?? '') || detail.trim() !== (editing?.detail ?? '')} onSubmit={() => void save()} onClose={onClose}
      submit={<button type="submit" className="btn btn-primary cx-btn-px" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save request' : 'File request'}{editing ? <FloppyDisk /> : <Plus />}</button>}>
      <Field id="ws-request-name" label="Title" error={tried ? missing : ''} hint="One line: what should the system do that it does not do today?">
        <input id="ws-request-name" className={`input ${tried && missing ? 'is-bad' : ''}`} value={title} maxLength={LIMITS.title} data-autofocus="" aria-invalid={tried && !!missing} aria-describedby="ws-request-name-hint" onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field id="ws-request-detail" label="Description (optional)" hint={`${detail.length.toLocaleString()} of ${LIMITS.detail.toLocaleString()} characters. Who needs it, and what they do instead today.`}>
        <textarea id="ws-request-detail" className="input cx-textarea ws-textarea" rows={6} value={detail} maxLength={LIMITS.detail} aria-describedby="ws-request-detail-hint" onChange={(event) => setDetail(event.target.value)} />
      </Field>
      {!editing && <p className="cx-hint">Filing it counts as your vote. Everyone on the team can see it and vote.</p>}
      {error && <div className="cx-error ws-form-error" role="alert">{error}</div>}
    </Dialog>
  );
}

interface TaskDialogProps {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; editing: Task | null; requestId: string | null;
  onClose(): void; onSaved(task: Task): void; onRemoved(task: Task): void;
}

/** A task: created and edited by members with write access, read by everyone. */
export function TaskDialog(props: TaskDialogProps) {
  // Someone who may not edit it is shown the task, not a form they cannot use.
  return props.editing && !props.editing.can.edit
    ? <TaskCard task={props.editing} snapshot={props.snapshot} onClose={props.onClose} />
    : <TaskForm {...props} />;
}

function TaskCard({ task, snapshot, onClose }: { task: Task; snapshot: WorkspaceSnapshot; onClose(): void }) {
  const request = task.requestId ? snapshot.board.requests.find((r) => r.id === task.requestId) : undefined;
  return (
    <Dialog label={task.requestId ? `Task for ${task.requestId}` : 'Tasks'} title={`Task ${task.id}`} busy={false} dirty={false} onSubmit={onClose} onClose={onClose} cancel="Close" submit={null}>
      <h3 className="ws-detail__title">{task.title}</h3>
      {request && <p className="cx-hint ws-modal__context">Delivers <b>{request.title}</b></p>}
      <dl className="ws-facts">
        <div><dt>Status</dt><dd><StatusTag status={task.status} /></dd></div>
        <div><dt>Assigned to</dt><dd>{task.assignee === snapshot.me.name ? `${task.assignee} (you)` : task.assignee ?? 'Nobody yet'}{task.assignee && snapshot.teamRoles[task.assignee] ? ` · ${teamRoleText(snapshot.teamRoles[task.assignee])}` : ''}</dd></div>
        <div><dt>Due</dt><dd>{task.due ? dayLabel(task.due) : 'No date set'}</dd></div>
        <div><dt>Created by</dt><dd>{task.createdBy}</dd></div>
      </dl>
      {task.detail ? <div className="ws-prose">{task.detail}</div> : <p className="cx-hint ws-modal__context">No notes.</p>}
      <p className="cx-hint">{task.can.status ? 'This task is yours: change its status from the list. Editing or reassigning it needs write access.' : 'Editing a task needs write access.'}</p>
    </Dialog>
  );
}

function TaskForm({ ws, snapshot, editing, requestId, onClose, onSaved, onRemoved }: TaskDialogProps) {
  const from = editing?.requestId ?? requestId;
  const request = from ? snapshot.board.requests.find((r) => r.id === from) : undefined;
  // A task made from a request starts with its title: usually that is the task.
  const [title, setTitle] = useState(editing?.title ?? (requestId ? request?.title ?? '' : ''));
  const [detail, setDetail] = useState(editing?.detail ?? '');
  const [assignee, setAssignee] = useState(editing?.assignee ?? '');
  const [due, setDue] = useState(editing?.due ?? '');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const missing = !title.trim() ? 'Enter a title.' : '';
  // Somebody who has since lost their account can still be shown as holding the task.
  const choices = [...new Set([...snapshot.members, ...(editing?.assignee ? [editing.assignee] : [])])].sort();
  const save = async () => {
    setTried(true); setError('');
    if (missing) { document.getElementById('ws-task-name')?.focus(); return; }
    setBusy(true);
    try {
      const fieldsToSend = { title, detail, assignee: assignee || null, due: due || null };
      onSaved(await ws.act(() => (editing ? workspaceApi.updateTask(editing.id, editing.revision, fieldsToSend) : workspaceApi.createTask({ ...fieldsToSend, requestId }))));
    } catch (cause) { setError(reason(cause, 'The task was not saved.')); setBusy(false); }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true); setError('');
    try { await ws.act(() => workspaceApi.removeTask(editing.id, editing.revision)); onRemoved(editing); }
    catch (cause) { setError(reason(cause, 'The task was not deleted.')); setBusy(false); }
  };
  const dirty = title.trim() !== (editing?.title ?? '') || detail.trim() !== (editing?.detail ?? '') || assignee !== (editing?.assignee ?? '') || due !== (editing?.due ?? '');
  return (
    <Dialog label={from ? `Task for ${from}` : 'Tasks'} title={editing ? `Edit ${editing.id}` : 'New task'} busy={busy} dirty={dirty} onSubmit={() => void save()} onClose={onClose}
      submit={<button type="submit" className="btn btn-primary cx-btn-px" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save task' : 'Create task'}{editing ? <FloppyDisk /> : <Plus />}</button>}>
      {request && <p className="cx-hint ws-modal__context">Delivers <b>{request.title}</b></p>}
      <Field id="ws-task-name" label="Title" error={tried ? missing : ''}>
        <input id="ws-task-name" className={`input ${tried && missing ? 'is-bad' : ''}`} value={title} maxLength={LIMITS.title} data-autofocus="" aria-invalid={tried && !!missing} aria-describedby={tried && missing ? 'ws-task-name-hint' : undefined} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field id="ws-task-detail" label="Notes (optional)">
        <textarea id="ws-task-detail" className="input cx-textarea ws-textarea" rows={4} value={detail} maxLength={LIMITS.detail} onChange={(event) => setDetail(event.target.value)} />
      </Field>
      <div className="cx-fields">
        <Field id="ws-task-assignee" label="Assigned to">
          <select id="ws-task-assignee" className="input" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">Unassigned</option>
            {choices.map((name) => <option key={name} value={name}>{name === snapshot.me.name ? `${name} (you)` : name}{snapshot.teamRoles[name] ? ` · ${teamRoleText(snapshot.teamRoles[name])}` : ''}{snapshot.members.includes(name) ? '' : ' (no longer a member)'}</option>)}
          </select>
        </Field>
        <Field id="ws-task-due" label="Due (optional)">
          <input id="ws-task-due" className="input" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
        </Field>
      </div>
      {error && <div className="cx-error ws-form-error" role="alert">{error}</div>}
      {editing?.can.remove && (
        <div className="ws-actions">
          {confirming ? (
            <>
              <span className="ws-confirm">Delete task {editing.id} for everyone?</span>
              <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => void remove()}>Delete task<Trash /></button>
              <button type="button" className="btn btn-ghost cx-btn-px" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
            </>
          ) : <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => setConfirming(true)}>Delete<Trash /></button>}
        </div>
      )}
    </Dialog>
  );
}
