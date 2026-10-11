/**
 * "Ask AI" on the algo console's landing page: a local model that has been
 * told how this system works and answers questions about it.
 *
 * It answers; it does not act. It has no tools, no credentials and no way to
 * reach a sensor, a parameter or a student. What it is told is one file
 * (config/ai-knowledge.md) and a few live figures every member can already
 * see. Nobody's mail, no imagery and nothing about a student is ever put in
 * front of it.
 */

export const LIMITS = {
  question: 1000,
  /** Earlier turns sent back for a follow-up; older ones are simply forgotten. */
  turns: 6, turn: 4000,
  /** The knowledge base has to fit the model's context with room to answer. */
  knowledgeBytes: 16_000,
  answer: 6000,
} as const;

export interface Turn { role: 'user' | 'assistant'; content: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** Whatever produces the words. One implementation: Ollama, on the Proxmox cluster. */
export interface ChatModel {
  readonly name: string;
  /** Yields the answer piece by piece. Aborting the signal must stop the model working. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

export interface Knowledge { text: string; updatedAt: number }
export interface KnowledgeSource { read(): Knowledge }

export interface Asker { name: string; role: string; teamRoles: string[] }

export type AssistantErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VALIDATION' | 'NOT_CONFIGURED' | 'BUSY' | 'RATE_LIMITED' | 'UNAVAILABLE';
export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode, readonly status: number, message: string) { super(message); }
}

export interface AssistantConfig { url: string; model: string; contextTokens: number; timeoutMs: number }

/**
 * AI_OLLAMA_URL and AI_MODEL, both or neither. Neither is "not set up", which
 * the page says in those words; one without the other is a mistake worth
 * stopping for, like every other half-configured setting here.
 */
export function loadAssistantConfig(env: NodeJS.ProcessEnv): AssistantConfig | null {
  const url = env.AI_OLLAMA_URL?.trim() ?? '', model = env.AI_MODEL?.trim() ?? '';
  if (!url && !model) return null;
  if (!url || !model) throw new Error('AI_OLLAMA_URL and AI_MODEL must be set together (or neither, to leave Ask AI off)');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('AI_OLLAMA_URL must be a URL such as http://100.127.1.82:11434'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('AI_OLLAMA_URL must be a plain http(s) URL with no credentials, query or fragment');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(model)) throw new Error('AI_MODEL must be an Ollama model name such as qwen2.5:7b-instruct-q4_K_M');
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  return {
    url: parsed.origin + parsed.pathname.replace(/\/+$/, ''), model,
    contextTokens: number('AI_CONTEXT_TOKENS', 8192, 2048, 32768),
    timeoutMs: number('AI_TIMEOUT_MS', 120_000, 5000, 600_000),
  };
}
