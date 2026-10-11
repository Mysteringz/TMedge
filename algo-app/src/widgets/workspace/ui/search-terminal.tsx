/**
 * The landing page's terminal (Bluegrid's Terminal, used for looking things
 * up): a prompt, and under it whatever on the site answers what was typed.
 *
 * It searches; it does not yet answer questions. The index it is handed is
 * the seam for that: an assistant that can act on the site needs the same
 * list of places and items, and what opening each one does.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { KIND_LABEL, search, type SearchEntry } from '../../../entities/workspace/index.ts';
import { Icons } from '../../charts/index.ts';

/** Recent queries, for the up arrow. Kept for the tab's lifetime and nowhere else. */
const history: string[] = [];
function remember(query: string): void {
  const index = history.indexOf(query);
  if (index >= 0) history.splice(index, 1);
  history.push(query);
  if (history.length > 20) history.shift();
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

export function SearchTerminal({ entries, state, onChoose, onFocus }: {
  entries: SearchEntry[];
  /** Whether the index holds everything, only the site's own pages, or is still being read. */
  state: 'ready' | 'partial' | 'loading';
  onChoose(entry: SearchEntry): void;
  /** The first focus is when the sensor list is worth fetching. */
  onFocus(): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recall, setRecall] = useState(-1);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => search(entries, query), [entries, query]);
  const current = results[Math.min(active, results.length - 1)];
  // The list floats over the page, so it is only there while the prompt is being used.
  const open = focused && results.length > 0;

  // "/" is the search key everywhere a terminal is on screen, and Ctrl/Cmd+K for
  // those whose hands expect it. Neither fires while something is being typed.
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

  const change = (value: string) => { setQuery(value); setActive(0); setRecall(-1); };
  const choose = (entry: SearchEntry) => {
    remember(query.trim() || entry.title);
    change('');
    onChoose(entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // The page's own shortcuts (module numbers, arrows) must not see these.
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      if (recall < 0 && results.length) { event.preventDefault(); setActive((i) => (Math.min(i, results.length - 1) + step + results.length) % results.length); return; }
      // An empty prompt: up walks back through what was searched before, as a
      // shell's does, and down comes forward again to the empty prompt.
      if (recall < 0 && (query || step > 0)) return;
      event.preventDefault();
      const next = recall < 0 ? history.length - 1 : recall + step;
      if (next < 0) return;
      if (next >= history.length) { change(''); return; }
      setRecall(next); setQuery(history[next] ?? ''); setActive(0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) choose(current);
    } else if (event.key === 'Tab' && !event.shiftKey && current && query && current.title.toLowerCase() !== query.trim().toLowerCase()) {
      // Completes once; a second Tab finds nothing left to complete and moves on.
      event.preventDefault();
      setQuery(current.title); setActive(0);
    } else if (event.key === 'Escape') {
      if (query) { event.preventDefault(); change(''); } else input.current?.blur();
    } else if (event.key.toLowerCase() === 'l' && event.ctrlKey) {
      event.preventDefault(); change('');
    }
  };

  const Status = state === 'ready' ? Icons.CheckmarkFilled : state === 'partial' ? Icons.WarningFilled : Icons.RadioButton;
  return (
    <section className="ws-term" aria-label="Search terminal">
      <div className="ws-term__bar">
        <span className="ws-term__title">algo.hkumyseat <span className="ws-term__dim">/ search</span></span>
        <span className={`ws-term__status ws-term__status--${state}`}>
          <Status />{state === 'ready' ? `${entries.length} indexed` : state === 'partial' ? 'Site pages only' : 'Indexing…'}
        </span>
      </div>
      <div className="ws-term__screen">
        <label className="ws-term__prompt">
          <span className="ws-term__glyph" aria-hidden="true">&gt;</span>
          <span className="ws-sr">Search the site</span>
          <input ref={input} className="ws-term__input" type="text" role="combobox" value={query} placeholder="Search modules, people, messages, requests, sensors"
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
            aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && current ? `${listId}-${results.indexOf(current)}` : undefined}
            onChange={(event) => change(event.target.value)} onKeyDown={onKeyDown} onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => setFocused(false)} />
          <kbd className="ws-term__key" aria-hidden="true">/</kbd>
        </label>
        <div className="ws-term__output">
          <ul id={listId} role="listbox" aria-label="Results" className="ws-term__results" hidden={!open}>
            {results.map((entry, index) => (
              // Pressing a row must not take focus from the prompt: the list closes on blur, and the click would land on nothing.
              <li key={entry.id} id={`${listId}-${index}`} role="option" aria-selected={entry === current} className={`ws-term__row ${entry === current ? 'is-on' : ''}`}
                onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(entry)}>
                <span className="ws-term__kind">{KIND_LABEL[entry.kind]}</span>
                <span className="ws-term__text"><span className="ws-term__name">{entry.title}</span><span className="ws-term__detail">{entry.detail}</span></span>
                <span className="ws-term__hint">{entry.hint}</span>
              </li>
            ))}
          </ul>
          {query.trim() && results.length === 0
            ? <p className="ws-term__line">No match for <b>{query.trim()}</b>. Try a module, a member's name, or a request such as R-1.</p>
            : <p className="ws-term__line">Type to find a module, page, member, message, request, task or sensor.</p>}
          <p className="ws-term__line ws-term__dim"><kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Tab</kbd> complete · <kbd>Esc</kbd> clear</p>
          <p className="ws-sr" role="status" aria-live="polite">{query.trim() ? results.length ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : 'No results' : ''}</p>
        </div>
        <div className="ws-term__foot">
          <span>Ask AI</span><span className="tag tag-neutral">Not available yet</span>
          <span className="ws-term__dim">It searches today; asking it to act comes later.</span>
        </div>
      </div>
    </section>
  );
}
