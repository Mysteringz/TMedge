/**
 * The one box on the landing page. What is typed is looked up on the site
 * first; a question, or anything the site has no match for, is offered to
 * Ask AI instead. Enter takes whichever is first.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { looksLikeQuestion, QUESTION_LIMIT, type AssistantStatus } from '../../../entities/assistant/index.ts';
import { KIND_LABEL, search, type SearchEntry } from '../../../entities/workspace/index.ts';
import { MagnifyingGlass, Sparkle } from '../../../console/icons.tsx';
import { usePresence } from '../../../console/motion.tsx';

type Row = { kind: 'entry'; entry: SearchEntry } | { kind: 'ask' };

const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

export function AskBar({ entries, assistant, answering, onChoose, onAsk, onFocus }: {
  entries: SearchEntry[];
  /** Null until the server has said whether a model is set up. */
  assistant: AssistantStatus | null;
  /** An answer is being written; another question waits for it. */
  answering: boolean;
  onChoose(entry: SearchEntry): void;
  onAsk(question: string): void;
  /** The first focus is when the sensor list is worth fetching. */
  onFocus(): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const text = query.trim();
  const canAsk = !!assistant?.available;
  const rows = useMemo<Row[]>(() => {
    if (!text) return [];
    const found: Row[] = search(entries, query, 6).map((entry) => ({ kind: 'entry', entry }));
    if (!canAsk) return found;
    // The site first -- unless this reads as a question, or the site has
    // nothing by that name: then the assistant is the first answer offered.
    return looksLikeQuestion(text) || found.length === 0 ? [{ kind: 'ask' }, ...found] : [...found, { kind: 'ask' }];
  }, [entries, query, text, canAsk]);
  const current = rows[Math.min(active, rows.length - 1)];
  const open = focused && rows.length > 0;
  // The list leaves showing what it last offered: by then the query that made it may be gone.
  const list = usePresence(open);
  const offered = useRef(rows);
  if (open) offered.current = rows;
  const listed = open ? rows : offered.current;

  // "/" is the search key, and Ctrl/Cmd+K for those whose hands expect it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const palette = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey;
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event.target);
      if (!palette && !slash) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const change = (value: string) => { setQuery(value); setActive(0); };
  const askNow = () => {
    if (!text) { input.current?.focus(); return; }
    if (!canAsk || answering) return;
    change('');
    onAsk(text);
  };
  const take = (row: Row) => {
    if (row.kind === 'ask') { askNow(); return; }
    change('');
    onChoose(row.entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (Math.min(i, rows.length - 1) + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) take(current);
    } else if (event.key === 'Escape') {
      if (query) { event.preventDefault(); change(''); } else input.current?.blur();
    }
  };

  const why = !assistant ? 'Checking whether Ask AI is set up…'
    : assistant.reason === 'not-configured' ? 'Ask AI is not set up on this server yet. The box still searches the site.'
      : assistant.reason === 'knowledge-unreadable' ? 'Ask AI is off: its knowledge base could not be read on the server.' : '';
  return (
    <section className="ws-ask" aria-label="Search and ask">
      <div className="ws-ask__bar">
        <span className="ws-ask__icon" aria-hidden="true"><MagnifyingGlass /></span>
        <input ref={input} className="ws-ask__input" type="text" role="combobox" value={query} maxLength={QUESTION_LIMIT}
          placeholder={canAsk ? 'Search or ask a question' : 'Search the site'} aria-label="Search the site or ask a question"
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="search"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && current ? `${listId}-${rows.indexOf(current)}` : undefined}
          onChange={(event) => change(event.target.value)} onKeyDown={onKeyDown} onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => setFocused(false)} />
        {/* Pressing it must not take focus from the box first, or the list closes under the pointer. */}
        <button type="button" className="ws-ask__ai" onMouseDown={(event) => event.preventDefault()} onClick={askNow} disabled={!canAsk || answering}
          title={why || (answering ? 'An answer is being written' : text ? 'Ask the assistant this' : 'Type a question, then ask')}>
          <Sparkle /><span>Ask AI</span>
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label="Results" className="ws-ask__results" hidden={!list} data-state={list ?? undefined} inert={list === 'leaving'} aria-hidden={list === 'leaving' ? true : undefined}>
        {(list ? listed : []).map((row, index) => (
          <li key={row.kind === 'ask' ? 'ask' : row.entry.id} id={`${listId}-${index}`} role="option" aria-selected={row === current}
            className={`ws-ask__row ${row === current ? 'is-on' : ''} ${row.kind === 'ask' ? 'ws-ask__row--ai' : ''}`}
            onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => take(row)}>
            {row.kind === 'ask' ? (
              <>
                <span className="ws-ask__kind"><Sparkle />Ask AI</span>
                <span className="ws-ask__text"><span className="ws-ask__name">{text}</span><span className="ws-ask__detail">{answering ? 'Waiting for the answer in progress' : 'Answered from what the assistant knows about this system'}</span></span>
              </>
            ) : (
              <>
                <span className="ws-ask__kind">{KIND_LABEL[row.entry.kind]}</span>
                <span className="ws-ask__text"><span className="ws-ask__name">{row.entry.title}</span><span className="ws-ask__detail">{row.entry.detail}</span></span>
                <span className="ws-ask__hint">{row.entry.hint}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {text && rows.length === 0 && <p className="ws-ask__note" role="status">Nothing on the site matches <b>{text}</b>.{why ? ` ${why}` : ''}</p>}
      {!text && why && assistant && <p className="ws-ask__note">{why}</p>}
      <p className="ws-sr" role="status" aria-live="polite">{text && rows.length ? `${rows.length} ${rows.length === 1 ? 'suggestion' : 'suggestions'}` : ''}</p>
    </section>
  );
}
