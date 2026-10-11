/**
 * What Ask AI said, under the box it was asked in. Marked as AI throughout
 * (Bluegrid's AI label): these words came from a model, not from the system
 * of record, and the panel says where they came from and that they can be wrong.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Stop, XMark } from '../../../console/icons.tsx';

export interface Exchange {
  id: number; question: string; answer: string;
  state: 'waiting' | 'writing' | 'done' | 'stopped' | 'failed';
  error?: string;
}

/**
 * The little formatting a small model insists on, shown as what it means:
 * **bold** and `code`. Everything else stays text, with its line breaks.
 * Built as elements, never as HTML: an answer can quote anything.
 */
function formatted(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let last = 0, match: RegExpExecArray | null, key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(match[1] !== undefined ? <strong key={key++}>{match[1]}</strong> : <code key={key++}>{match[2]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AssistantPanel({ exchanges, model, onStop, onClear }: { exchanges: Exchange[]; model: string | null; onStop(): void; onClear(): void }) {
  const live = exchanges.some((exchange) => exchange.state === 'waiting' || exchange.state === 'writing');
  const latest = exchanges[exchanges.length - 1];
  const body = useRef<HTMLDivElement>(null);
  // The newest words are the ones being read; keep them in view as they arrive.
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [latest?.id, latest?.answer.length, latest?.state]);
  return (
    <section className="ws-answer" aria-label="Ask AI answers" aria-busy={live}>
      <div className="ws-answer__head">
        <span className="ws-ai-label">AI</span>
        <span className="ws-answer__title">Ask AI</span>
        {model && <span className="ws-answer__model">{model}</span>}
        <span className="ws-answer__tools">
          {live && <button type="button" className="btn btn-ghost cx-btn-px" onClick={onStop}>Stop<Stop /></button>}
          <button type="button" className="btn btn-ghost cx-icon" onClick={onClear} aria-label="Close answers" title="Close"><XMark /></button>
        </span>
      </div>
      <div className="ws-answer__body" ref={body}>
        {exchanges.map((exchange) => (
          <div className="ws-answer__turn" key={exchange.id}>
            <p className="ws-answer__q">{exchange.question}</p>
            {exchange.answer && <div className="ws-answer__a">{formatted(exchange.answer)}{exchange.state === 'writing' && <span className="ws-answer__cursor" aria-hidden="true" />}</div>}
            {exchange.state === 'waiting' && <p className="ws-answer__wait">Thinking… the first answer after a quiet spell takes about twenty seconds while the model loads.</p>}
            {exchange.state === 'stopped' && <p className="ws-answer__wait">Stopped.</p>}
            {exchange.state === 'failed' && <p className="cx-hint is-err" role="alert">{exchange.error}</p>}
          </div>
        ))}
      </div>
      <p className="ws-answer__foot">
        Written by a model on the team's own server from the system's knowledge base and a few live figures. It cannot see mail or change anything, and it can be wrong: check what you will act on.
        {latest?.state === 'done' && ' Ask a follow-up in the box above.'}
      </p>
      <p className="ws-sr" role="status" aria-live="polite">{latest?.state === 'done' ? 'Answer ready.' : latest?.state === 'failed' ? 'The assistant could not answer.' : ''}</p>
    </section>
  );
}
