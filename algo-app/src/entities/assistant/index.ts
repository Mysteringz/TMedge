/**
 * Ask AI: the client's side of `/api/assistant`. Mirrors
 * src/modules/assistant on the server; this app cannot import it.
 */
import { permissionChanged } from '../admin-session/index.tsx';

export interface AssistantStatus {
  available: boolean; reason: 'not-configured' | 'knowledge-unreadable' | null; model: string | null; knowledgeUpdatedAt: number | null;
  /** How much of the repository it can look things up in; null when the server has no index of it. */
  code: { files: number; chunks: number } | null;
}
export interface Turn { role: 'user' | 'assistant'; content: string }
/** A piece of the repository an answer was written from. */
export interface Source { path: string; from: number; to: number; heading?: string }
export const QUESTION_LIMIT = 1000;

export class AssistantError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function assistantStatus(signal?: AbortSignal): Promise<AssistantStatus> {
  const response = await fetch('/api/assistant', { signal, credentials: 'same-origin' });
  if (response.status === 401) permissionChanged(401);
  const body = await response.json() as { data: AssistantStatus | null };
  if (!response.ok || !body.data) throw new AssistantError('UNAVAILABLE', 'The assistant could not be reached.');
  return body.data;
}

/**
 * Asks, and hands each piece of the answer to `onText` as it arrives, and to
 * `onSources` the files it was shown, which come before its first word.
 * Resolves when the answer is complete; rejects with the server's own words
 * otherwise. Aborting the signal stops the model working on it.
 */
export async function ask(question: string, history: Turn[], signal: AbortSignal, onText: (piece: string) => void, onSources: (sources: Source[]) => void = () => undefined): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/assistant/ask', {
      method: 'POST', signal, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tm-algo': '1' },
      body: JSON.stringify({ question, history }),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new AssistantError('UNREACHABLE', 'Could not reach the console. Check your connection and try again.');
  }
  if (!response.ok || !response.body) {
    if (response.status === 401) permissionChanged(401);
    let message = 'The assistant is unavailable right now.', code = 'UNAVAILABLE';
    try { const body = await response.json() as { error?: { code: string; message: string } }; if (body.error) ({ code, message } = body.error); } catch { /* a proxy's page, not ours */ }
    throw new AssistantError(code, message);
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = '', finished = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    // Server-sent events: blocks separated by a blank line, an event name and one line of JSON each.
    let end: number;
    while ((end = buffered.indexOf('\n\n')) >= 0) {
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      let value: { text?: unknown; message?: unknown; sources?: unknown };
      try { value = JSON.parse(data); } catch { continue; }
      if (event === 'delta' && typeof value.text === 'string') onText(value.text);
      else if (event === 'sources' && Array.isArray(value.sources)) {
        onSources((value.sources as Partial<Source>[]).filter((source): source is Source =>
          !!source && typeof source.path === 'string' && Number.isInteger(source.from) && Number.isInteger(source.to)));
      }
      else if (event === 'error') throw new AssistantError('CUT_SHORT', typeof value.message === 'string' ? value.message : 'The answer was cut short.');
      else if (event === 'done') finished = true;
    }
  }
  // A stream that simply ends was cut somewhere on the way; it is not a finished answer.
  if (!finished) throw new AssistantError('CUT_SHORT', 'The answer was cut short before it finished.');
}

const ASKING = new Set(['how', 'what', 'whats', "what's", 'why', 'when', 'where', 'who', 'whose', 'which', 'can', 'could', 'does', 'do', 'did', 'is', 'are', 'was', 'were',
  'should', 'would', 'will', 'explain', 'describe', 'tell', 'summarize', 'summarise', 'compare', 'help']);

/**
 * Whether what was typed reads as a question about the system and not as the
 * name of something on the site: it ends in a question mark, opens with a
 * word people ask with, or is a whole sentence.
 */
export function looksLikeQuestion(query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return false;
  if (/[?？]$/.test(text)) return true;
  const words = text.split(/\s+/);
  // One word is a name to look up, whatever the word.
  if (words.length < 2) return false;
  return ASKING.has(words[0] ?? '') || words.length >= 7;
}
