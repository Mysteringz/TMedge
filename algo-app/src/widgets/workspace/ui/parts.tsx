/** Small pieces the workspace's panels share. */
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { XMark } from '../../../console/icons.tsx';
import { Icons } from '../../charts/index.ts';

/** "3 min ago" for today, a date after that: a mailbox is read by recency first. */
export function when(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function fullTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** Today as the browser's own calendar day, to compare with a due date. */
export function today(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A `YYYY-MM-DD` due date as people write one. Built from its parts so no time zone can move the day. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Carbon's inline notification: edge, icon and bold title carry the status, never colour alone. */
export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warning' | 'error'; title: string; children?: ReactNode }) {
  const Icon = kind === 'error' ? Icons.ErrorFilled : kind === 'warning' ? Icons.WarningFilled : Icons.InformationFilled;
  return (
    <div className={`ws-notice ws-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={20} className="ws-notice__icon" />
      <div><strong>{title}</strong>{children}</div>
    </div>
  );
}

/** A field with its label above and what went wrong below (Bluegrid TextInput). */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className={`field ${error ? 'is-bad' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <div className="cx-hint is-err cx-field-hint" id={`${id}-hint`} role="alert">{error}</div>
        : hint ? <div className="cx-hint cx-field-hint" id={`${id}-hint`}>{hint}</div> : null}
    </div>
  );
}

/**
 * One focused task over a scrim. Focus goes in when it opens, stays in while
 * it is open, and returns to whatever opened it; Escape and Cancel close it.
 * A click on the scrim closes only a form nothing has been typed into, so a
 * stray click does not throw away a half-written message.
 */
export function Dialog({ title, label, busy, dirty, submit, cancel = 'Cancel', onSubmit, onClose, children }: {
  title: string; label: string; busy: boolean; dirty: boolean;
  /** The primary button, or null for something that is only read: then there is one button, and it closes. */
  submit: ReactNode | null; cancel?: string;
  onSubmit(): void; onClose(): void; children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A dialog with nothing to fill in still takes the focus, on its close button.
    const first = form.current?.querySelector<HTMLElement>('[data-autofocus]') ?? form.current?.querySelector<HTMLElement>('input, textarea, select') ?? form.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const onKey = (event: React.KeyboardEvent) => {
    // The page behind has shortcuts of its own (the search keys).
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) close.current(); return; }
    if (event.key !== 'Tab' || !form.current) return;
    const stops = [...form.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    const firstStop = stops[0], lastStop = stops[stops.length - 1];
    if (!firstStop || !lastStop) return;
    if (event.shiftKey && document.activeElement === firstStop) { event.preventDefault(); lastStop.focus(); }
    else if (!event.shiftKey && document.activeElement === lastStop) { event.preventDefault(); firstStop.focus(); }
  };
  const send = (event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit(); };
  return (
    <div className="cx-modal-back ws-modal-back" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !dirty && !busy) onClose(); }}>
      <form ref={form} className="card cx-modal ws-modal" role="dialog" aria-modal="true" aria-labelledby="ws-dialog-title" onSubmit={send} onKeyDown={onKey} aria-busy={busy} noValidate>
        <div className="cx-card-head">
          <div>
            <div className="ws-modal__label">{label}</div>
            <h2 id="ws-dialog-title" className="ws-modal__title">{title}</h2>
          </div>
          <button type="button" className="btn btn-ghost cx-icon" onClick={onClose} disabled={busy} aria-label="Close"><XMark /></button>
        </div>
        {children}
        <div className="cx-modal-actions">
          <button type="button" className="btn btn-secondary cx-btn-px" onClick={onClose} disabled={busy}>{cancel}</button>
          {submit}
        </div>
      </form>
    </div>
  );
}

/** What the server said, or a plain sentence when it said nothing usable. */
export function reason(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
