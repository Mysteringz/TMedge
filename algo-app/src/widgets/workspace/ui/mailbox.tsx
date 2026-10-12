/** The mailbox: what other members wrote to you, what you sent, and writing to them. */
import { useEffect, useState } from 'react';
import { LIMITS, teamRoleText, workspaceApi, WorkspaceRequestError, type Message, type MessageDraft, type MessageHeader, type WorkspaceSnapshot, type WorkspaceState } from '../../../entities/workspace/index.ts';
import { ArrowBendUpLeft, ArrowLeft, PaperPlaneRight, Plus, Trash } from '../../../console/icons.tsx';
import { Switcher } from '../../../console/motion.tsx';
import { Dialog, Field, fullTime, reason, when } from './parts.tsx';

export type Box = 'inbox' | 'sent';

const people = (names: string[], me: string) => names.map((name) => (name === me ? 'you' : name)).join(', ');

export function MailboxPanel({ ws, snapshot, box, openId, now, onBox, onOpen, onCompose, flash }: {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; box: Box; openId: string | null; now: number;
  onBox(box: Box): void; onOpen(id: string | null): void; onCompose(draft: MessageDraft | null): void; flash(message: string): void;
}) {
  const { mail, me, members } = snapshot;
  const others = members.filter((name) => name !== me.name);
  if (openId) return <MessageView key={openId} ws={ws} snapshot={snapshot} id={openId} onBack={() => onOpen(null)} onCompose={onCompose} flash={flash} />;
  const rows = box === 'inbox' ? mail.inbox : mail.sent;
  const omitted = mail.omitted[box];
  return (
    <>
      <div className="ws-bar">
        <Switcher role="radiogroup" aria-label="Mailbox">
          <label className="seg-opt"><input type="radio" name="ws-box" checked={box === 'inbox'} onChange={() => onBox('inbox')} />Inbox{mail.unread > 0 && <span className="ws-count">{mail.unread}<span className="ws-sr"> unread</span></span>}</label>
          <label className="seg-opt"><input type="radio" name="ws-box" checked={box === 'sent'} onChange={() => onBox('sent')} />Sent</label>
        </Switcher>
        <button type="button" className="btn btn-primary cx-btn-px" onClick={() => onCompose(null)} disabled={others.length === 0}
          title={others.length === 0 ? 'There is nobody else to write to yet' : undefined}>Compose<Plus /></button>
      </div>
      {rows.length === 0 ? (
        <p className="ws-empty" key={box}>
          {others.length === 0 ? 'You are the only member of this console. When an admin adds accounts, you can write to each other here.'
            : box === 'inbox' ? 'No messages. What other members write to you appears here.' : 'Nothing sent yet.'}
        </p>
      ) : (
        <ul className="ws-list" key={box} aria-label={box === 'inbox' ? 'Inbox' : 'Sent messages'}>
          {rows.map((m) => <MessageRow key={m.id} message={m} me={me.name} now={now} onOpen={() => onOpen(m.id)} />)}
        </ul>
      )}
      {omitted > 0 && <p className="cx-hint ws-foot">Showing the newest {rows.length}. {omitted} older {omitted === 1 ? 'message is' : 'messages are'} kept and can be found by search.</p>}
    </>
  );
}

function MessageRow({ message: m, me, now, onOpen }: { message: MessageHeader; me: string; now: number; onOpen(): void }) {
  return (
    <li>
      <button type="button" className={`ws-row ws-mail ${m.read ? '' : 'is-unread'}`} onClick={onOpen}>
        <span className="ws-mail__mark" aria-hidden="true" />
        <span className="ws-row__main">
          <span className="ws-row__top">
            <span className="ws-mail__who">{m.box === 'inbox' ? m.from : `to ${people(m.to, me)}`}</span>
            <time className="ws-row__time" dateTime={new Date(m.sentAt).toISOString()} title={fullTime(m.sentAt)}>{when(m.sentAt, now)}</time>
          </span>
          {/* Unread is the weight and the word, not only the orange mark. */}
          <span className="ws-row__title">{!m.read && <span className="ws-sr">Unread: </span>}{m.subject}</span>
          <span className="ws-row__sub">{m.preview}</span>
        </span>
      </button>
    </li>
  );
}

function MessageView({ ws, snapshot, id, onBack, onCompose, flash }: {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; id: string; onBack(): void; onCompose(draft: MessageDraft | null): void; flash(message: string): void;
}) {
  const [message, setMessage] = useState<Message | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = snapshot.me.name;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const opened = await workspaceApi.openMessage(id, controller.signal);
        if (controller.signal.aborted) return;
        setMessage(opened);
        // Opening it is reading it. The list and the unread count follow.
        if (!opened.read) await ws.act(() => workspaceApi.markMessage(id, true));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof WorkspaceRequestError && cause.status === 404 ? 'This message is no longer in your mailbox.' : reason(cause, 'The message could not be opened.'));
      }
    })();
    return () => controller.abort();
    // Once per message: ws.act is stable, and a refreshed snapshot is no reason to fetch the body again.
  }, [id]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError('');
    try { await ws.act(work); flash(done); onBack(); }
    catch (cause) { setError(reason(cause, 'That did not go through.')); setBusy(false); }
  };

  const back = <button type="button" className="btn btn-ghost cx-btn-px ws-back" onClick={onBack}><span>Back to mailbox</span><ArrowLeft /></button>;
  if (!message) return <><div className="ws-bar">{back}</div><p className="ws-empty" role={error ? 'alert' : 'status'}>{error || 'Opening message…'}</p></>;

  const current = new Set(snapshot.members);
  const reply = (all: boolean): MessageDraft => ({
    // Only to people who can still be written to; a removed account cannot receive it.
    to: [...new Set([message.from, ...(all ? message.to : [])])].filter((name) => name !== me && current.has(name)),
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`.slice(0, LIMITS.subject),
    body: '', replyTo: message.id,
  });
  const canReply = message.box === 'inbox' && current.has(message.from);
  const canReplyAll = message.box === 'inbox' && reply(true).to.length > 1;
  return (
    <article className="ws-detail" aria-labelledby="ws-message-title">
      <div className="ws-bar">
        {back}
        <div className="ws-actions">
          {canReply && <button type="button" className="btn btn-secondary cx-btn-px" onClick={() => onCompose(reply(false))} disabled={busy}>Reply<ArrowBendUpLeft /></button>}
          {canReplyAll && <button type="button" className="btn btn-ghost cx-btn-px" onClick={() => onCompose(reply(true))} disabled={busy}>Reply to all</button>}
        </div>
      </div>
      <div className="ws-detail__body">
        <h3 id="ws-message-title" className="ws-detail__title">{message.subject}</h3>
        <p className="ws-detail__meta">
          From <b>{message.from === me ? 'you' : message.from}</b> to <b>{people(message.to, me)}</b>
          <span> · <time dateTime={new Date(message.sentAt).toISOString()}>{fullTime(message.sentAt)}</time></span>
        </p>
        <div className="ws-prose">{message.body}</div>
        {error && <p className="cx-hint is-err" role="alert">{error}</p>}
        <div className="ws-actions ws-detail__foot">
          {message.box === 'inbox' && <button type="button" className="btn btn-ghost cx-btn-px" disabled={busy} onClick={() => void run(() => workspaceApi.markMessage(id, false), 'Marked as unread.')}>Mark as unread</button>}
          {confirming ? (
            <>
              {/* Says what it does: the other side keeps their copy. */}
              <span className="ws-confirm">Remove it from your mailbox? {message.box === 'inbox' ? 'The sender keeps their copy.' : 'The people you sent it to keep theirs.'}</span>
              <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => void run(() => workspaceApi.removeMessage(id), 'Message removed from your mailbox.')}>Delete message<Trash /></button>
              <button type="button" className="btn btn-ghost cx-btn-px" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
            </>
          ) : <button type="button" className="btn btn-ghost cx-btn-px cx-danger" disabled={busy} onClick={() => setConfirming(true)}>Delete<Trash /></button>}
        </div>
      </div>
    </article>
  );
}

/** Writing a message. Recipients are picked from the members; there is nobody else to write to. */
export function ComposeDialog({ ws, snapshot, initial, onClose, onSent }: {
  ws: WorkspaceState; snapshot: WorkspaceSnapshot; initial: MessageDraft;
  /** Closed without sending: the draft is handed back so it is still there next time. */
  onClose(draft: MessageDraft): void; onSent(message: Message): void;
}) {
  const others = snapshot.members.filter((name) => name !== snapshot.me.name);
  const [to, setTo] = useState<string[]>(() => initial.to.filter((name) => others.includes(name)));
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const draft = (): MessageDraft => ({ to, subject, body, replyTo: initial.replyTo });
  const problems = {
    to: to.length === 0 ? 'Choose at least one person.' : '',
    subject: !subject.trim() ? 'Enter a subject.' : '',
    body: !body.trim() ? 'Write a message.' : body.length > LIMITS.body ? `Shorten the message to ${LIMITS.body.toLocaleString()} characters.` : '',
  };
  const send = async () => {
    setTried(true); setError('');
    // Straight to the first thing that needs fixing, where its message is read out.
    const wrong = problems.to ? 'ws-to-first' : problems.subject ? 'ws-subject' : problems.body ? 'ws-body' : '';
    if (wrong) { document.getElementById(wrong)?.focus(); return; }
    setBusy(true);
    try { onSent(await ws.act(() => workspaceApi.sendMessage(draft()))); }
    catch (cause) { setError(reason(cause, 'The message was not sent.')); setBusy(false); }
  };
  const toggle = (name: string) => setTo((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));
  return (
    <Dialog label="Mailbox" title={initial.replyTo ? 'Reply' : 'New message'} busy={busy} dirty={!!(subject.trim() || body.trim())}
      onSubmit={() => void send()} onClose={() => onClose(draft())}
      submit={<button type="submit" className="btn btn-primary cx-btn-px" disabled={busy}>{busy ? 'Sending…' : 'Send message'}<PaperPlaneRight /></button>}>
      <div className={`field ${tried && problems.to ? 'is-bad' : ''}`}>
        <label id="ws-to-label">To</label>
        <div className="cx-chips" role="group" aria-labelledby="ws-to-label">
          {others.map((name, index) => (
            <label key={name} className="seg-opt cx-chip"><input type="checkbox" id={index === 0 ? 'ws-to-first' : undefined} checked={to.includes(name)} onChange={() => toggle(name)} data-autofocus={index === 0 && to.length === 0 ? '' : undefined}
              aria-describedby={tried && problems.to ? 'ws-to-hint' : undefined} />{name}{snapshot.teamRoles[name] && <span className="ws-chip-role">{teamRoleText(snapshot.teamRoles[name])}</span>}</label>
          ))}
        </div>
        {others.length > 2 && (
          <button type="button" className="ws-inline" onClick={() => setTo(to.length === others.length ? [] : others)}>{to.length === others.length ? 'Clear everyone' : `Select all ${others.length} members`}</button>
        )}
        {tried && problems.to && <div className="cx-hint is-err cx-field-hint" id="ws-to-hint" role="alert">{problems.to}</div>}
      </div>
      <Field id="ws-subject" label="Subject" error={tried ? problems.subject : ''}>
        <input id="ws-subject" className={`input ${tried && problems.subject ? 'is-bad' : ''}`} value={subject} maxLength={LIMITS.subject} onChange={(event) => setSubject(event.target.value)}
          data-autofocus={to.length > 0 && !subject ? '' : undefined} aria-invalid={tried && !!problems.subject} aria-describedby={tried && problems.subject ? 'ws-subject-hint' : undefined} />
      </Field>
      <Field id="ws-body" label="Message" error={tried ? problems.body : ''} hint={`${body.length.toLocaleString()} of ${LIMITS.body.toLocaleString()} characters. Plain text; line breaks are kept.`}>
        <textarea id="ws-body" className={`input cx-textarea ws-textarea ${tried && problems.body ? 'is-bad' : ''}`} rows={8} value={body} maxLength={LIMITS.body}
          data-autofocus={to.length > 0 && subject ? '' : undefined} aria-invalid={tried && !!problems.body} aria-describedby="ws-body-hint"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      </Field>
      {error && <div className="cx-error ws-form-error" role="alert">{error}</div>}
    </Dialog>
  );
}
