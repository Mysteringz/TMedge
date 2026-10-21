import { AssistantError, LIMITS, type AssistantConfig, type ChatMessage, type ChatModel } from '../../modules/assistant/domain/assistant.js';

/**
 * Ollama's chat endpoint, streamed. The model runs on the Proxmox cluster
 * (docs/ASSISTANT.md); the edge only carries text to it and back.
 *
 * Nothing about the request or the reply is logged here or anywhere else in
 * the edge: a question can quote whatever the person asking is looking at.
 */
export class OllamaChatModel implements ChatModel {
  readonly name: string;
  constructor(private readonly config: AssistantConfig, private readonly fetcher: typeof fetch = fetch) { this.name = config.model; }

  /**
   * What every request asks for. A question and a warm-up must ask for the
   * same context size: the model server reloads the model for a different one,
   * which is the twenty-second wait this exists to avoid.
   */
  private body(messages: ChatMessage[], stream: boolean, predict: number): string {
    return JSON.stringify({
      model: this.config.model, messages, stream,
      // How long it stays in memory afterwards. -1 is "always", and is a number to Ollama.
      keep_alive: this.config.keepAlive === '-1' ? -1 : this.config.keepAlive,
      // Low temperature: this is asked what is true of a system, not for ideas.
      // It stops at a code fence: shown real source, this model "quotes" code
      // it has made up, with imports of files that do not exist. It may
      // explain code; the code itself is in the file the answer names.
      options: { temperature: 0.2, num_ctx: this.config.contextTokens, num_predict: predict, stop: ['```'] },
    });
  }

  async warm(messages: ChatMessage[], signal: AbortSignal): Promise<void> {
    // One token out: the work wanted is the loading and the reading, which the server keeps.
    const response = await this.fetcher(`${this.config.url}/api/chat`, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      headers: { 'content-type': 'application/json' }, body: this.body(messages, false, 1),
    });
    try { await response.arrayBuffer(); } catch { /* it answered or it did not; either way there is nobody to tell */ }
  }

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    const unavailable = (): never => { throw new AssistantError('UNAVAILABLE', 502, 'The assistant\'s model server did not answer. It may be busy, loading the model, or unreachable.'); };
    // One clock for the whole answer: a model that stops mid-sentence must not hold the request open.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.url}/api/chat`, {
        method: 'POST', signal: deadline, headers: { 'content-type': 'application/json' },
        body: this.body(messages, true, LIMITS.answerTokens),
      });
    } catch { return unavailable(); }
    if (!response.ok || !response.body) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return unavailable();
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); } catch { return unavailable(); }
        if (chunk.done) return;
        buffered += decoder.decode(chunk.value, { stream: true });
        // One JSON object a line; a line can arrive in two reads.
        if (buffered.length > 1_000_000) return unavailable();
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end).trim();
          buffered = buffered.slice(end + 1);
          if (!line) continue;
          let event: { message?: { content?: unknown }; done?: unknown; error?: unknown };
          try { event = JSON.parse(line); } catch { return unavailable(); }
          if (event.error) return unavailable();
          if (typeof event.message?.content === 'string' && event.message.content) yield event.message.content;
          if (event.done === true) return;
        }
      }
    } finally {
      // Whoever stops reading (the person closed the page, the answer was long
      // enough) also stops the GPU working on the rest.
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  }
}
