/**
 * `/api/assistant` on the algo console: whether Ask AI is set up, and asking
 * it. Signed-in members only; nothing here is mounted on the student tier.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { AlgoAuth } from '../../../algo/auth.js';
import { RateLimiter } from '../../../web/auth.js';
import type { AskAssistant } from '../application/ask-assistant.js';
import { AssistantError, type Asker } from '../domain/assistant.js';

export interface AssistantServices {
  /** Null when AI_OLLAMA_URL / AI_MODEL are not set: the page then says so instead of offering a box that cannot answer. */
  assistant: AskAssistant | null;
  teamRolesOf(name: string): string[];
  now?: () => number;
}

export function createAssistantRouter(auth: Pick<AlgoAuth, 'principalOf'>, services: AssistantServices): Router {
  const { assistant } = services;
  const now = services.now ?? Date.now;
  const router = express.Router();
  // A question costs seconds of a shared GPU, so the budget is small and per person.
  const asks = new RateLimiter(20, 300_000);
  // The model server answers one request at a time; a second is refused, not queued behind the first.
  let answering = false;

  const fail = (res: Response, error: unknown) => {
    const known = error instanceof AssistantError ? error : new AssistantError('UNAVAILABLE', 503, 'The assistant is unavailable right now.');
    return void res.status(known.status).json({ data: null, error: { code: known.code, message: known.message } });
  };
  const askerOf = (req: Request): Asker => {
    const principal = auth.principalOf(req);
    if (!principal) throw new AssistantError('UNAUTHENTICATED', 401, 'Sign in again.');
    if (!principal.capabilities.includes('algo.read')) throw new AssistantError('FORBIDDEN', 403, 'The assistant is unavailable to this account.');
    return { name: principal.name, role: principal.role, teamRoles: services.teamRolesOf(principal.name) };
  };

  router.use((req, res, next) => { try { askerOf(req); next(); } catch (error) { fail(res, error); } });
  router.use(express.json({ limit: '48kb' }));

  router.get('/', async (_req, res) => {
    const status = assistant ? await assistant.status() : null;
    // The page asks this as it opens: the earliest sign that somebody may be
    // about to ask, and time for the model to be loaded before they have.
    if (status?.knowledgeReady && !answering) assistant?.warm();
    res.json({ data: {
      available: !!status?.knowledgeReady,
      reason: !status ? 'not-configured' : status.knowledgeReady ? null : 'knowledge-unreadable',
      model: status?.model ?? null, knowledgeUpdatedAt: status?.knowledgeUpdatedAt ?? null,
      // How much of the repository it can look things up in; null when this build has no index.
      code: status?.code ?? null,
    }, error: null });
  });

  router.post('/ask', async (req, res) => {
    const abort = new AbortController();
    let held = false;
    try {
      const asker = askerOf(req);
      // Like every write here: the cookie is SameSite=Lax, so the header and
      // the origin are what stop another site spending the GPU as this person.
      const origin = req.get('origin');
      if (req.get('x-tm-algo') !== '1' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) throw new AssistantError('FORBIDDEN', 403, 'Request origin is not permitted.');
      if (!assistant) throw new AssistantError('NOT_CONFIGURED', 503, 'Ask AI is not set up on this server.');
      const { messages, sources } = await assistant.prepare(asker, req.body);
      if (!asks.allow(asker.name, now())) throw new AssistantError('RATE_LIMITED', 429, 'Too many questions at once. Try again in a few minutes.');
      if (answering) throw new AssistantError('BUSY', 503, 'The assistant is answering someone else. Try again in a moment.');
      answering = true; held = true;

      // Somebody who closes the page stops the model working on their answer.
      res.on('close', () => abort.abort());
      const pieces = assistant.answer(messages, abort.signal)[Symbol.asyncIterator]();
      // The first piece is awaited before any header goes out, so a model
      // server that is down is an ordinary error and not half a stream.
      let next = await pieces.next();
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Which files it was shown goes first: it is true whatever the model goes on to say.
      if (sources.length) send('sources', { sources });
      try {
        while (!next.done) { send('delta', { text: next.value }); next = await pieces.next(); }
        send('done', { model: (await assistant.status()).model });
      } catch {
        // Headers are gone; the only honest thing left to say is that it stopped.
        if (!abort.signal.aborted) send('error', { message: 'The answer was cut short: the model server stopped responding.' });
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.end(); else fail(res, error);
    } finally {
      if (held) answering = false;
      abort.abort();
    }
  });

  router.use((_req, res) => fail(res, new AssistantError('VALIDATION', 404, 'No such endpoint.')));
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => fail(res, new AssistantError('VALIDATION', 400, 'Invalid or oversized JSON body.')));
  return router;
}
