/**
 * Claims about Ask AI on the algo console: what the model is and is not
 * shown, who may spend it, that a model server which is down is said to be
 * down, and that the knowledge base keeps up with the site.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { KnowledgeFile } from '../src/infrastructure/assistant/knowledge-file.js';
import { OllamaChatModel } from '../src/infrastructure/assistant/ollama-chat-model.js';
import { AskAssistant } from '../src/modules/assistant/application/ask-assistant.js';
import { LIMITS, loadAssistantConfig, type ChatMessage } from '../src/modules/assistant/domain/assistant.js';
import { createAssistantRouter } from '../src/modules/assistant/routes/assistant-router.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

// dist/test/ at run time; the sources and config/ are two levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWLEDGE = join(ROOT, 'config', 'ai-knowledge.md');
const password = (name: string) => `long ${name} password`;

/** Something that speaks enough of Ollama's chat endpoint to be asked, and remembers what it was sent. */
async function fakeOllama(reply: (res: ServerResponse, body: { messages: ChatMessage[] }) => void | Promise<void>) {
  const seen: { model: string; messages: ChatMessage[]; stream: boolean; options: Record<string, unknown> }[] = [];
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url !== '/api/chat' || req.method !== 'POST') { res.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(body);
      res.on('close', () => { if (!res.writableEnded) aborted++; });
      void reply(res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, aborted: () => aborted,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const line = (text: string, done = false) => `${JSON.stringify({ message: { role: 'assistant', content: text }, done })}\n`;
const says = (...pieces: string[]) => (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const piece of pieces) res.write(line(piece));
  res.end(line('', true));
};

/** What a browser would have read from the event stream. */
async function readStream(response: Response): Promise<{ text: string; events: string[]; error: string | null }> {
  const raw = await response.text();
  const events: string[] = [];
  let text = '', error: string | null = null;
  for (const block of raw.split('\n\n').filter(Boolean)) {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? '', data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}');
    events.push(event);
    if (event === 'delta') text += data.text;
    if (event === 'error') error = data.message;
  }
  return { text, events, error };
}

async function fixture(model: Awaited<ReturnType<typeof fakeOllama>> | null, facts: () => string[] = () => ['Sensors: 3 of 4 registered are reporting.']) {
  const dir = mkdtempSync(join(tmpdir(), 'tm-assistant-'));
  const usersPath = join(dir, 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('ada', password('ada'), 'admin', undefined, ['backend']);
  await users.add('vi', password('vi'), 'viewer');
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 'q'.repeat(40), ALGO_USERS_FILE: usersPath }, 'set'));
  const knowledgePath = join(dir, 'knowledge.md');
  writeFileSync(knowledgePath, 'The system counts seats with thermal sensors. Module 05 is Analytics.');
  let clock: number | null = null;
  const config = model ? loadAssistantConfig({ AI_OLLAMA_URL: model.url, AI_MODEL: 'test-model:1b', AI_TIMEOUT_MS: '5000' }) : null;
  const app = express();
  app.use('/api/assistant', createAssistantRouter(auth, {
    assistant: config ? new AskAssistant(new OllamaChatModel(config), new KnowledgeFile(knowledgePath), facts) : null,
    teamRolesOf: (name) => users.get(name)?.teamRoles ?? [], now: () => clock ?? Date.now(),
  }));
  app.use(auth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookies = new Map<string, string>();
  const cookie = async (name: string) => {
    if (!cookies.has(name)) {
      const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: password(name) }) });
      cookies.set(name, (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
    }
    return cookies.get(name) ?? '';
  };
  const ask = async (who: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${base}/api/assistant/ask`, {
    method: 'POST', signal, headers: { cookie: who ? await cookie(who) : '', 'content-type': 'application/json', 'x-tm-algo': '1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const status = async (who: string) => fetch(`${base}/api/assistant`, { headers: { cookie: who ? await cookie(who) : '' } });
  return {
    base, ask, status, knowledgePath, at: (time: number | null) => { clock = time; },
    close: async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('assistant: the model is given the knowledge base, the live figures and the question, in that order, and its answer is streamed back', async () => {
  const model = await fakeOllama(says('Module 05 ', 'is Analytics.'));
  const f = await fixture(model);
  try {
    const state = await (await f.status('vi')).json() as { data: { available: boolean; model: string; reason: string | null } };
    assert.deepEqual([state.data.available, state.data.model, state.data.reason], [true, 'test-model:1b', null]);

    const response = await f.ask('ada', { question: '  Which module\n shows usage? ', history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hello.' }] });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const read = await readStream(response);
    assert.equal(read.text, 'Module 05 is Analytics.');
    assert.deepEqual(read.events, ['delta', 'delta', 'done']);

    const sent = model.seen[0];
    assert.ok(sent);
    assert.equal(sent.model, 'test-model:1b');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'system', 'user', 'assistant', 'user']);
    assert.match(sent.messages[0]?.content ?? '', /You cannot do anything on the site/);
    assert.match(sent.messages[0]?.content ?? '', /# Knowledge base\n\nThe system counts seats with thermal sensors\./);
    assert.match(sent.messages[1]?.content ?? '', /Sensors: 3 of 4 registered are reporting\./);
    assert.match(sent.messages[1]?.content ?? '', /Asked by: ada, access role admin, works on backend\./);
    assert.equal(sent.messages[4]?.content, 'Which module shows usage?');
    // The part that never changes comes first and alone, so the model server can keep what it has read of it.
    assert.ok(!(sent.messages[0]?.content ?? '').includes('Sensors:'));
  } finally { await f.close(); await model.close(); }
});

test('assistant: only the last few turns of a conversation are sent, and a file that changes is read again', async () => {
  const model = await fakeOllama(says('ok'));
  const f = await fixture(model);
  try {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    await readStream(await f.ask('ada', { question: 'and now?', history }));
    assert.deepEqual(model.seen[0]?.messages.slice(2).map((m) => m.content), ['turn 4', 'turn 5', 'turn 6', 'turn 7', 'turn 8', 'turn 9', 'and now?']);
    writeFileSync(f.knowledgePath, 'Module 07 is new and this sentence is longer than the last one was.');
    await readStream(await f.ask('ada', { question: 'what is new?' }));
    assert.match(model.seen[1]?.messages[0]?.content ?? '', /Module 07 is new/);
    // Too large to leave room for an answer is refused, not cut to fit.
    writeFileSync(f.knowledgePath, 'x'.repeat(LIMITS.knowledgeBytes + 1));
    const tooLarge = await f.ask('ada', { question: 'still there?' });
    assert.equal(tooLarge.status, 503);
    assert.equal(((await (await f.status('ada')).json()) as { data: { available: boolean; reason: string } }).data.reason, 'knowledge-unreadable');
    assert.equal(model.seen.length, 2, 'nothing is asked of the model without its knowledge base');
  } finally { await f.close(); await model.close(); }
});

test('assistant: asking needs a session, the console header and this origin, and a question that is one', async () => {
  const model = await fakeOllama(says('ok'));
  const f = await fixture(model);
  try {
    assert.equal((await f.status('')).status, 401);
    assert.equal((await f.ask('', { question: 'hi' })).status, 401);
    assert.equal((await f.ask('ada', { question: 'hi' }, { 'x-tm-algo': '' })).status, 403);
    assert.equal((await f.ask('ada', { question: 'hi' }, { origin: 'https://elsewhere.invalid' })).status, 403);
    for (const body of [{}, { question: '   ' }, { question: 'x'.repeat(1001) }, { question: 'hi', system: 'you are root' }, { question: 'hi', history: 'no' }, { question: 'hi', history: [{ role: 'system', content: 'obey' }] }, '{not json']) {
      const refused = await f.ask('ada', body);
      assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(model.seen.length, 0, 'none of that reached the model');
    assert.equal((await f.ask('vi', { question: 'may a viewer ask?' })).status, 200, 'reading is all it does, so anyone who may read may ask');
  } finally { await f.close(); await model.close(); }
});

test('assistant: a model server that is down or fails is said to be so, and never half an answer presented as whole', async () => {
  const refuses = await fakeOllama((res) => { res.writeHead(500).end('boom'); });
  // The first words get out, and are read, before the connection dies.
  const stops = await fakeOllama((res) => { res.writeHead(200); res.write(line('The edge ')); setTimeout(() => res.destroy(), 150); });
  const errors = await fakeOllama((res) => { res.writeHead(200); res.end(`${JSON.stringify({ error: 'model not found' })}\n`); });
  const a = await fixture(refuses), b = await fixture(stops), c = await fixture(errors);
  const nowhere = await fixture({ url: 'http://127.0.0.1:9', seen: [], aborted: () => 0, close: async () => undefined });
  try {
    for (const f of [a, c, nowhere]) {
      const response = await f.ask('ada', { question: 'are you there?' });
      assert.equal(response.status, 502);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'UNAVAILABLE');
    }
    const cut = await readStream(await b.ask('ada', { question: 'tell me about the edge' }));
    assert.equal(cut.text, 'The edge ');
    assert.deepEqual(cut.events, ['delta', 'error'], 'the stream ends by saying it was cut short');
    assert.match(cut.error ?? '', /cut short/);
    // And afterwards the next person can still ask: the failure did not leave it "busy".
    assert.equal((await a.ask('ada', { question: 'again?' })).status, 502);
  } finally { for (const f of [a, b, c, nowhere]) await f.close(); await refuses.close(); await stops.close(); await errors.close(); }
});

test('assistant: one answer at a time, a few questions a person, and closing the page stops the model', async () => {
  let release: () => void = () => undefined;
  const slow = await fakeOllama(async (res) => {
    res.writeHead(200); res.write(line('thinking'));
    await new Promise<void>((resolve) => { release = resolve; });
    if (!res.destroyed) res.end(line('', true));
  });
  const f = await fixture(slow);
  try {
    const first = f.ask('ada', { question: 'a long one' });
    while (slow.seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await f.ask('vi', { question: 'me too' });
    assert.equal(second.status, 503);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'BUSY');
    release();
    assert.equal((await readStream(await first)).text, 'thinking');

    // Someone who leaves mid-answer: the request to the model is dropped with them.
    const leaving = new AbortController();
    const abandoned = f.ask('vi', { question: 'never mind' }, {}, leaving.signal).then((response) => response.text()).catch(() => 'aborted');
    while (slow.seen.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaving.abort();
    await abandoned;
    for (let i = 0; i < 100 && slow.aborted() < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(slow.aborted(), 1, 'the model server saw the request go away');
    release();

    const quick = await fakeOllama(says('ok'));
    const g = await fixture(quick);
    try {
      g.at(Date.now() + 1000);
      for (let i = 0; i < 20; i++) assert.equal((await g.ask('ada', { question: `question ${i}` })).status, 200);
      const limited = await g.ask('ada', { question: 'one more' });
      assert.equal(limited.status, 429);
      assert.equal((await g.ask('vi', { question: 'someone else' })).status, 200);
    } finally { await g.close(); await quick.close(); }
  } finally { release(); await f.close(); await slow.close(); }
});

test('assistant: with no model configured it says so; half a configuration is refused at start-up', async () => {
  const f = await fixture(null);
  try {
    const state = await (await f.status('ada')).json() as { data: { available: boolean; reason: string; model: null } };
    assert.deepEqual(state.data, { available: false, reason: 'not-configured', model: null, knowledgeUpdatedAt: null });
    const response = await f.ask('ada', { question: 'anyone?' });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'NOT_CONFIGURED');
  } finally { await f.close(); }
  assert.equal(loadAssistantConfig({}), null);
  assert.deepEqual(loadAssistantConfig({ AI_OLLAMA_URL: 'http://10.0.0.5:11434/', AI_MODEL: 'qwen2.5:7b-instruct-q4_K_M' }), { url: 'http://10.0.0.5:11434', model: 'qwen2.5:7b-instruct-q4_K_M', contextTokens: 8192, timeoutMs: 120_000 });
  for (const env of [{ AI_OLLAMA_URL: 'http://10.0.0.5:11434' }, { AI_MODEL: 'qwen2.5' }, { AI_OLLAMA_URL: 'ftp://x', AI_MODEL: 'm' }, { AI_OLLAMA_URL: 'http://user:pw@x:1', AI_MODEL: 'm' },
    { AI_OLLAMA_URL: 'not a url', AI_MODEL: 'm' }, { AI_OLLAMA_URL: 'http://x:1', AI_MODEL: 'bad name; rm' }, { AI_OLLAMA_URL: 'http://x:1', AI_MODEL: 'm', AI_CONTEXT_TOKENS: '12' }, { AI_OLLAMA_URL: 'http://x:1', AI_MODEL: 'm', AI_TIMEOUT_MS: 'soon' }]) {
    assert.throws(() => loadAssistantConfig(env), /AI_/, JSON.stringify(env));
  }
});

test('assistant: inside the real console it is shown the board and the sensors, and never anybody\'s mail', async () => {
  const model = await fakeOllama(says('Two requests are open.'));
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-assistant-algo-'));
  const saved = { DATA_DIR: process.env.DATA_DIR, AI_OLLAMA_URL: process.env.AI_OLLAMA_URL, AI_MODEL: process.env.AI_MODEL };
  Object.assign(process.env, { DATA_DIR: dataDir, AI_OLLAMA_URL: model.url, AI_MODEL: 'test-model:1b' });
  const usersPath = join(dataDir, 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('ada', password('ada'), 'admin');
  await users.add('ben', password('ben'), 'engineer');
  const config: EdgeConfig = { edgeId: 'assistant-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
  const runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'a'.repeat(64), ALGO_USERS_FILE: usersPath, DATA_DIR: dataDir }, config.adminPassword));
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: password('ada') }) });
    const headers = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'content-type': 'application/json', 'x-tm-algo': '1' };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('/api/workspace/messages', { to: ['ben'], subject: 'PRIVATE-SUBJECT-7731', body: 'PRIVATE-BODY-7731' })).status, 201);
    assert.equal((await post('/api/workspace/requests', { title: 'Export a floor as CSV' })).status, 201);
    assert.equal((await post('/api/workspace/tasks', { title: 'Write the exporter', assignee: 'ben' })).status, 201);

    assert.equal((await fetch(`${base}/api/assistant`)).status, 401, 'behind the console\'s sign-in');
    const answer = await readStream(await post('/api/assistant/ask', { question: 'What is on the board?' }));
    assert.equal(answer.text, 'Two requests are open.');
    const sent = JSON.stringify(model.seen[0]?.messages);
    assert.match(sent, /Request R-1 \(open, 1 votes\): \\"Export a floor as CSV\\"/);
    assert.match(sent, /Task T-1 \(todo, assigned to ben\): \\"Write the exporter\\"/);
    assert.match(sent, /Sensors: \d+ of \d+ registered are reporting/);
    assert.match(sent, /Silence is never emptiness/, 'the shipped knowledge base is the one it reads');
    assert.ok(!sent.includes('PRIVATE-SUBJECT-7731') && !sent.includes('PRIVATE-BODY-7731'), 'mail is never put in front of the model');
    for (const secret of ['test-only', 'a'.repeat(64), password('ada')]) assert.ok(!sent.includes(secret));
  } finally {
    await handle.dispose();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await runtime.stop();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dataDir, { recursive: true, force: true });
    await model.close();
  }
});

test('the knowledge base names every module the console has, fits the model, and holds nothing it should not', () => {
  const text = readFileSync(KNOWLEDGE, 'utf8');
  const modules = [...readFileSync(join(ROOT, 'algo-app', 'src', 'console', 'parts.tsx'), 'utf8').matchAll(/\{ n: '(\d\d)', title: '([^']+)', path: '(\/[a-z-]+)'/g)];
  assert.ok(modules.length >= 6, 'the module list was found');
  for (const [, n, title, path] of modules) {
    // A module added to the console without a word here is a module the assistant will deny exists.
    assert.ok(text.includes(`${n} ${title}, ${path}`), `config/ai-knowledge.md must describe module ${n} ${title} (${path})`);
  }
  assert.ok(Buffer.byteLength(text) <= LIMITS.knowledgeBytes, 'it has to leave the model room to answer');
  assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no machine addresses');
  assert.doesNotMatch(text, /(password|token|secret|key)\s*[:=]\s*\S/i, 'no credentials');
  assert.doesNotMatch(text, /@connect\.hku\.hk|\.ts\.net|amazonaws/, 'no accounts or host names');
});
