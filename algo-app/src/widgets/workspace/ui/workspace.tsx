/**
 * Everything on the landing page under the welcome: one box to search the
 * site or ask the assistant, the places this person goes most, six figures on
 * how the system is doing, the mailbox, and the board.
 *
 * The box can open any of the rest, so what is open (which message, which
 * dialog, which answer) is held here and handed down.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdminSession } from '../../../entities/admin-session/index.tsx';
import { ask, assistantStatus, AssistantError, type AssistantStatus, type Turn } from '../../../entities/assistant/index.ts';
import { byPersonalUse, readVisits } from '../../../entities/usage/index.ts';
import {
  buildIndex, useWorkspace,
  type FeatureRequest, type MessageDraft, type SearchEntry, type SensorSource, type Task,
} from '../../../entities/workspace/index.ts';
import { Presence, TabList } from '../../../console/motion.tsx';
import { modulesForCapabilities } from '../../../console/parts.tsx';
import { navigate } from '../../../console/router.ts';
import { AskBar } from './ask-bar.tsx';
import { AssistantPanel, type Exchange } from './assistant-panel.tsx';
import { RequestDialog, RequestsPanel, TaskDialog, TasksPanel, type TaskFilter } from './board.tsx';
import { ComposeDialog, MailboxPanel, type Box } from './mailbox.tsx';
import { Notice } from './parts.tsx';
import { SystemTiles } from './system-tiles.tsx';
import './workspace.css';

const TABS = [{ id: 'requests', label: 'Feature requests' }, { id: 'tasks', label: 'Tasks' }] as const;
type Tab = typeof TABS[number]['id'];
const isTab = (value: unknown): value is Tab => TABS.some((tab) => tab.id === value);

type Open =
  | { kind: 'compose'; draft: MessageDraft }
  | { kind: 'request'; editing: FeatureRequest | null }
  | { kind: 'task'; editing: Task | null; requestId: string | null };

const BLANK: MessageDraft = { to: [], subject: '', body: '', replyTo: null };
/** How many of the most-used places are offered where the header also lists every module. */
const SUGGESTED = 4;

function rememberedTab(): Tab {
  // A convenience only: the page works the same where storage is blocked.
  try { const stored = localStorage.getItem('workspace.board'); if (isTab(stored)) return stored; } catch { /* private window */ }
  return 'requests';
}

export function Workspace({ user, flash }: { user: string; flash(message: string): void }) {
  const session = useAdminSession();
  const ws = useWorkspace(user);
  const { snapshot } = ws;
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const [box, setBox] = useState<Box>('inbox');
  const [messageId, setMessageId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('mine');
  const [dialog, setDialog] = useState<Open | null>(null);
  const [sensors, setSensors] = useState<SensorSource[]>([]);
  const [assistant, setAssistant] = useState<AssistantStatus | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [now, setNow] = useState(Date.now);
  /** A message closed before it was sent, so Compose opens on it again. */
  const kept = useRef<MessageDraft | null>(null);
  const sensorsAt = useRef(0);
  const asking = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const mail = useRef<HTMLElement>(null), board = useRef<HTMLElement>(null);

  // "3 min ago" should not still say so half an hour later.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { try { localStorage.setItem('workspace.board', tab); } catch { /* private window */ } }, [tab]);
  // Whether a model is set up is asked once: the box says so instead of offering what cannot answer.
  useEffect(() => {
    const controller = new AbortController();
    assistantStatus(controller.signal).then(setAssistant).catch(() => { if (!controller.signal.aborted) setAssistant({ available: false, reason: null, model: null, knowledgeUpdatedAt: null }); });
    return () => { controller.abort(); asking.current?.abort(); };
  }, [user]);

  // Sensors are only worth listing once somebody is about to search, and a
  // list a minute old is good enough to search by name.
  const loadSensors = useCallback(() => {
    if (Date.now() - sensorsAt.current < 60_000) return;
    sensorsAt.current = Date.now();
    void fetch('/api/sources', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() as Promise<{ nodes?: SensorSource[] }> : null))
      .then((body) => { if (body && Array.isArray(body.nodes)) setSensors(body.nodes.filter((node) => typeof node?.uid === 'string' && typeof node.label === 'string')); })
      .catch(() => { sensorsAt.current = 0; });
  }, []);

  const accounts = !!session?.namedAccount && session.capabilities.includes('accounts.manage');
  const modules = modulesForCapabilities(session?.capabilities);
  const entries = useMemo(() => buildIndex({ modules, accounts, snapshot, sensors }), [modules, accounts, snapshot, sensors]);
  // Read once when the page opens: the order should not shuffle under the pointer.
  const places = useMemo(() => byPersonalUse(modules, readVisits(user)), [modules, user]);
  const personal = places.some((place) => place.used);

  const reveal = (section: HTMLElement | null) => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  };
  const show = (next: Tab) => { setTab(next); reveal(board.current); };
  const compose = (draft: MessageDraft | null) => setDialog({ kind: 'compose', draft: draft ?? kept.current ?? BLANK });

  const choose = (entry: SearchEntry) => {
    const target = entry.target;
    if (target.type === 'navigate') { navigate(target.path); return; }
    if (target.type === 'compose') { compose(target.to.length ? { ...BLANK, to: target.to } : null); return; }
    if (target.type === 'mailbox') { setMessageId(null); reveal(mail.current); return; }
    if (target.type === 'message') {
      setBox(snapshot?.mail.sent.some((m) => m.id === target.id) ? 'sent' : 'inbox');
      setMessageId(target.id); reveal(mail.current); return;
    }
    if (target.type === 'request') { setRequestId(target.id); show('requests'); return; }
    if (target.type === 'new-request') { show('requests'); setDialog({ kind: 'request', editing: null }); return; }
    if (target.type === 'new-task') { show('tasks'); setDialog({ kind: 'task', editing: null, requestId: null }); return; }
    const task = snapshot?.board.tasks.find((item) => item.id === target.id);
    if (task) { show('tasks'); setDialog({ kind: 'task', editing: task, requestId: null }); }
  };

  const answering = exchanges.some((exchange) => exchange.state === 'waiting' || exchange.state === 'writing');
  const askAssistant = (question: string) => {
    if (answering) return;
    const id = nextId.current++;
    // The last few finished exchanges go back with the question, so "and the other floor?" means something.
    const history: Turn[] = exchanges.filter((exchange) => exchange.state === 'done').slice(-3)
      .flatMap((exchange) => [{ role: 'user' as const, content: exchange.question }, { role: 'assistant' as const, content: exchange.answer }]);
    const patch = (change: Partial<Exchange> | ((exchange: Exchange) => Partial<Exchange>)) =>
      setExchanges((all) => all.map((exchange) => (exchange.id === id ? { ...exchange, ...(typeof change === 'function' ? change(exchange) : change) } : exchange)));
    setExchanges((all) => [...all.slice(-5), { id, question, answer: '', state: 'waiting' }]);
    const controller = new AbortController();
    asking.current = controller;
    ask(question, history, controller.signal, (piece) => patch((exchange) => ({ answer: exchange.answer + piece, state: 'writing' })))
      .then(() => patch({ state: 'done' }))
      .catch((cause) => patch(controller.signal.aborted ? { state: 'stopped' }
        : { state: 'failed', error: cause instanceof AssistantError ? cause.message : 'The assistant could not answer. Try again.' }))
      .finally(() => { if (asking.current === controller) asking.current = null; });
  };

  const onTabKey = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    const target = TABS[next];
    if (!target) return;
    event.preventDefault();
    setTab(target.id);
    document.getElementById(`ws-tab-${target.id}`)?.focus();
  };

  const counts: Record<Tab, { n: number; word: string }> = {
    requests: { n: snapshot?.board.requests.filter((request) => request.status === 'open').length ?? 0, word: 'open' },
    tasks: { n: snapshot?.board.tasks.filter((task) => task.status !== 'done' && task.assignee === snapshot.me.name).length ?? 0, word: 'yours' },
  };
  const loadingBody = (
    <p className="ws-empty" role="status" aria-busy={ws.loading}>
      {ws.loading ? 'Loading…' : <>This could not be loaded. <button type="button" className="ws-inline" onClick={ws.refresh}>Try again</button></>}
    </p>
  );

  return (
    <div className="ws" data-ready={snapshot ? '' : undefined}>
      <div className="ws-top">
        <AskBar entries={entries} assistant={assistant} answering={answering} onChoose={choose} onAsk={askAssistant} onFocus={loadSensors} />
        <nav className="ws-places" aria-label={personal ? 'Suggested for you' : 'Modules'}>
          <span className="ws-places__label">{personal ? 'Suggested for you' : 'Jump to'}</span>
          {places.map(({ item }, index) => (
            <a key={item.path} href={item.path} data-testid={item.path === '/locations' ? 'location-workspace-place' : undefined} className={`ws-place ${index >= SUGGESTED ? 'ws-place--more' : ''}`} title={item.desc}
              onClick={(event) => { event.preventDefault(); navigate(item.path); }}>{item.title}</a>
          ))}
        </nav>
        {exchanges.length > 0 && (
          <AssistantPanel exchanges={exchanges} model={assistant?.model ?? null} onStop={() => asking.current?.abort()}
            onClear={() => { asking.current?.abort(); setExchanges([]); }} />
        )}
      </div>

      <SystemTiles />
      {ws.error && <Notice kind="warning" title="Not up to date">{ws.error}</Notice>}

      <div className="ws-cols">
        <section className="ws-section" ref={mail} aria-labelledby="ws-mail-title">
          <div className="ws-head">
            <h2 id="ws-mail-title" className="ws-head__title">Mailbox</h2>
            <span className="ws-head__note">{snapshot ? `${snapshot.members.length} ${snapshot.members.length === 1 ? 'member' : 'members'}` : ''}</span>
          </div>
          <div className="ws-panel"><div className="ws-panel__body">
            {!snapshot ? loadingBody
              : <MailboxPanel ws={ws} snapshot={snapshot} box={box} openId={messageId} now={now} onBox={setBox} onOpen={setMessageId} onCompose={compose} flash={flash} />}
          </div></div>
        </section>

        <section className="ws-section" ref={board} aria-labelledby="ws-board-title">
          <div className="ws-head">
            <h2 id="ws-board-title" className="ws-head__title">Requests and tasks</h2>
          </div>
          <div className="ws-panel">
            <TabList className="ws-tabs" aria-label="Requests and tasks">
              {TABS.map((item, index) => (
                <button key={item.id} id={`ws-tab-${item.id}`} type="button" role="tab" className="ws-tab" aria-selected={tab === item.id} aria-controls="ws-tabpanel"
                  tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={(event) => onTabKey(event, index)}>
                  {item.label}{counts[item.id].n > 0 && <span className="ws-count">{counts[item.id].n}<span className="ws-sr"> {counts[item.id].word}</span></span>}
                </button>
              ))}
            </TabList>
            <div id="ws-tabpanel" role="tabpanel" aria-labelledby={`ws-tab-${tab}`} className="ws-panel__body">
              {!snapshot ? loadingBody : tab === 'requests' ? (
                <RequestsPanel ws={ws} snapshot={snapshot} openId={requestId} now={now} onOpen={setRequestId} flash={flash}
                  onNew={() => setDialog({ kind: 'request', editing: null })} onEdit={(editing) => setDialog({ kind: 'request', editing })}
                  onNewTask={(id) => setDialog({ kind: 'task', editing: null, requestId: id })} onOpenTask={(editing) => setDialog({ kind: 'task', editing, requestId: null })} />
              ) : (
                <TasksPanel ws={ws} snapshot={snapshot} filter={taskFilter} now={now} onFilter={setTaskFilter} flash={flash}
                  onNew={() => setDialog({ kind: 'task', editing: null, requestId: null })} onOpen={(editing) => setDialog({ kind: 'task', editing, requestId: null })} />
              )}
            </div>
          </div>
        </section>
      </div>

      <Presence>
      {snapshot && dialog?.kind === 'compose' && (
        <ComposeDialog ws={ws} snapshot={snapshot} initial={dialog.draft}
          onClose={(draft) => { if (!draft.replyTo) kept.current = draft.subject.trim() || draft.body.trim() ? draft : null; setDialog(null); }}
          onSent={(message) => { if (!message.replyTo) kept.current = null; setDialog(null); flash(`Message sent to ${message.to.join(', ')}.`); }} />
      )}
      {snapshot && dialog?.kind === 'request' && (
        <RequestDialog ws={ws} editing={dialog.editing} onClose={() => setDialog(null)}
          onSaved={(request) => { setDialog(null); setTab('requests'); setRequestId(request.id); flash(dialog.editing ? `Request ${request.id} saved.` : `Request ${request.id} filed.`); }} />
      )}
      {snapshot && dialog?.kind === 'task' && (
        <TaskDialog ws={ws} snapshot={snapshot} editing={dialog.editing} requestId={dialog.requestId} onClose={() => setDialog(null)}
          onSaved={(task) => {
            setDialog(null);
            // A new task is shown where it will be looked for: with its owner's, or with everyone's.
            if (!dialog.editing) { setTab('tasks'); setTaskFilter(task.assignee === snapshot.me.name ? 'mine' : 'everyone'); }
            flash(dialog.editing ? `Task ${task.id} saved.` : task.assignee ? `Task ${task.id} assigned to ${task.assignee}.` : `Task ${task.id} created, unassigned.`);
          }}
          onRemoved={(task) => { setDialog(null); flash(`Task ${task.id} deleted.`); }} />
      )}
      </Presence>
    </div>
  );
}
