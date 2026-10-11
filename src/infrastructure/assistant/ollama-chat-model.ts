import { AssistantError, type AssistantConfig, type ChatMessage, type ChatModel } from '../../modules/assistant/domain/assistant.js';

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

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
    const unavailable = (): never => { throw new AssistantError('UNAVAILABLE', 502, 'The assistant\'s model server did not answer. It may be busy, loading the model, or unreachable.'); };
    // One clock for the whole answer: a model that stops mid-sentence must not hold the request open.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.url}/api/chat`, {
        method: 'POST', signal: deadline, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model, messages, stream: true,
          // Kept loaded between questions; the first answer after a reload is the slow one.
          keep_alive: '30m',
          // Low temperature: this is asked what is true of a system, not for ideas.
          options: { temperature: 0.2, num_ctx: this.config.contextTokens, num_predict: 700 },
        }),
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
