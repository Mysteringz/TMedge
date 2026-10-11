/**
 * Claims about the team side of the algo console's landing page: whose mail
 * is whose, who may decide what on the board, and that the store is never
 * replaced by something it could not read.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { AlgoUsers, createAlgoAuth, loadAlgoAuthConfig } from '../src/algo/auth.js';
import { startAlgo } from '../src/algo/server.js';
import { createEdgeRuntime } from '../src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS, type EdgeConfig } from '../src/edge/config.js';
import { buildRegistry } from '../src/edge/registry.js';
import { JsonDocumentStore } from '../src/infrastructure/workspace/json-document-store.js';
import { Board, emptyBoard, parseBoard } from '../src/modules/workspace/application/board.js';
import { emptyMail, Mailbox, parseMail } from '../src/modules/workspace/application/mailbox.js';
import type { BoardView, MailboxView, MailDocument, MessageView, RequestView, TaskView } from '../src/modules/workspace/domain/workspace.js';
import { createWorkspaceRouter } from '../src/modules/workspace/routes/workspace-router.js';
import { KEY, nodesJson, siteJson } from './fixtures.js';

interface Snapshot { me: { name: string; canTriage: boolean; isAdmin: boolean }; members: string[]; teamRoles: Record<string, string[]>; mail: MailboxView; board: BoardView }
interface Reply<T> { status: number; data: T; code: string | null }

const ROLES = { ada: 'admin', ben: 'engineer', cy: 'operator', vi: 'viewer' } as const;
const password = (name: string) => `long ${name} password`;

/** The router on its own, over real accounts and real files, with a clock the test owns. */
async function fixture(signIn = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tm-workspace-'));
  const usersPath = join(dir, 'users.json');
  const users = new AlgoUsers(usersPath);
  if (signIn) for (const [name, role] of Object.entries(ROLES)) await users.add(name, password(name), role);
  const auth = createAlgoAuth(loadAlgoAuthConfig({ SESSION_SECRET: 'w'.repeat(40), ALGO_USERS_FILE: usersPath }, signIn ? 'set' : null));
  const members = () => signIn ? auth.users.records().filter((user) => !user.disabled).map((user) => ({ name: user.name, since: user.createdAt, teamRoles: user.teamRoles ?? [] })) : [{ name: 'local', since: 0, teamRoles: [] }];
  const mailPath = join(dir, 'workspace', 'mail.json'), boardPath = join(dir, 'workspace', 'board.json');
  let clock: number | null = null;
  const now = () => clock ?? Date.now();
  const app = express();
  app.use('/api/workspace', createWorkspaceRouter(auth, {
    mailbox: new Mailbox(new JsonDocumentStore(mailPath, emptyMail, parseMail), members, now),
    board: new Board(new JsonDocumentStore(boardPath, emptyBoard, parseBoard), members, now),
    members, now,
  }));
  app.use(auth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookies = new Map<string, string>();
  const login = async (name: string) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: password(name) }) });
    assert.equal(response.status, 200, `${name} signs in`);
    cookies.set(name, (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
  };
  /** One request as `who` ('' for nobody), with the console's write header unless `headers` says otherwise. */
  const call = async <T>(who: string, method: string, path = '', body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    if (who && signIn && !cookies.has(who)) await login(who);
    const response = await fetch(`${base}/api/workspace${path}`, {
      method, headers: { cookie: cookies.get(who) ?? '', 'content-type': 'application/json', 'x-tm-algo': '1', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const value = await response.json() as { data: T; error: { code: string } | null };
    return { status: response.status, data: value.data, code: value.error?.code ?? null };
  };
  const snapshot = async (who: string) => (await call<Snapshot>(who, 'GET')).data;
  return {
    dir, users, mailPath, boardPath, call, snapshot, login,
    forget: (name: string) => cookies.delete(name),
    at: (time: number | null) => { clock = time; },
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); },
  };
}

const letter = (to: string[], over: Record<string, unknown> = {}) => ({ to, subject: 'Node 7 keeps dropping', body: 'It rejoined twice this morning.\nCan you look at the gateway log?', ...over });

test('mail: a message is seen by its sender and the people it was sent to, and by nobody else', async () => {
  const f = await fixture();
  try {
    const sent = await f.call<MessageView>('ada', 'POST', '/messages', letter(['ben', 'cy']));
    assert.equal(sent.status, 201);
    assert.deepEqual(Object.keys(sent.data).sort(), ['body', 'box', 'from', 'id', 'preview', 'read', 'replyTo', 'sentAt', 'subject', 'to']);

    const ben = await f.snapshot('ben');
    assert.equal(ben.mail.unread, 1);
    assert.equal(ben.mail.inbox[0]?.subject, 'Node 7 keeps dropping');
    assert.equal(ben.mail.inbox[0]?.from, 'ada');
    assert.equal(ben.mail.inbox[0]?.preview, 'It rejoined twice this morning. Can you look at the gateway log?', 'the list carries one line, not the letter');
    assert.equal(ben.mail.sent.length, 0);

    const ada = await f.snapshot('ada');
    assert.equal(ada.mail.unread, 0, 'what you sent is not unread');
    assert.equal(ada.mail.sent.length, 1);
    assert.equal(ada.mail.inbox.length, 0);

    // Someone who was not written to: nothing in a list, and nothing by id either.
    const outsider = await f.snapshot('vi');
    assert.equal(outsider.mail.inbox.length + outsider.mail.sent.length + outsider.mail.unread, 0);
    assert.equal((await f.call('vi', 'GET', `/messages/${sent.data.id}`)).status, 404);
    assert.equal((await f.call('vi', 'POST', `/messages/${sent.data.id}/read`, { read: true })).status, 404);
    assert.equal((await f.call('vi', 'DELETE', `/messages/${sent.data.id}`)).status, 404);
    const second = await f.call<MessageView>('ben', 'POST', '/messages', letter(['cy'], { subject: 'Between ben and cy' }));
    assert.equal((await f.call('ada', 'GET', `/messages/${second.data.id}`)).status, 404, 'being an admin opens nobody else\'s mail');
    assert.ok(!JSON.stringify(await f.snapshot('ada')).includes('Between ben and cy'));

    const opened = await f.call<MessageView>('ben', 'GET', `/messages/${sent.data.id}`);
    assert.equal(opened.data.body, 'It rejoined twice this morning.\nCan you look at the gateway log?');
    assert.equal((await f.snapshot('ben')).mail.unread, 1, 'fetching a message does not mark it read');
    assert.equal((await f.call<MessageView>('ben', 'POST', `/messages/${sent.data.id}/read`, { read: true })).data.read, true);
    assert.equal((await f.snapshot('ben')).mail.unread, 0);
    assert.equal((await f.snapshot('cy')).mail.unread, 2, 'one person reading it does not read it for the other');
    assert.equal((await f.call<MessageView>('ben', 'POST', `/messages/${sent.data.id}/read`, { read: false })).data.read, false);
    assert.ok(!JSON.stringify(await f.snapshot('ada')).includes('readBy'), 'the sender is not told who has opened it');
  } finally { await f.close(); }
});

test('mail: removing a message takes it out of my mailbox only, and it is erased once nobody keeps it', async () => {
  const f = await fixture();
  try {
    const { data } = await f.call<MessageView>('ada', 'POST', '/messages', letter(['ben']));
    assert.equal((await f.call('ben', 'DELETE', `/messages/${data.id}`)).status, 200);
    assert.equal((await f.snapshot('ben')).mail.inbox.length, 0);
    assert.equal((await f.call('ben', 'GET', `/messages/${data.id}`)).status, 404);
    assert.equal((await f.snapshot('ada')).mail.sent.length, 1, 'the sender still has their copy');
    assert.equal((JSON.parse(readFileSync(f.mailPath, 'utf8')) as MailDocument).messages.length, 1);
    assert.equal((await f.call('ada', 'DELETE', `/messages/${data.id}`)).status, 200);
    assert.equal((JSON.parse(readFileSync(f.mailPath, 'utf8')) as MailDocument).messages.length, 0, 'nobody keeps it, so it is gone from the file');
  } finally { await f.close(); }
});

test('mail: a username created again does not inherit the mailbox of the account that had it before', async () => {
  const f = await fixture();
  try {
    const { data } = await f.call<MessageView>('ada', 'POST', '/messages', letter(['ben'], { subject: 'For the first ben only' }));
    assert.equal((await f.snapshot('ben')).mail.inbox.length, 1);
    assert.equal(f.users.remove('ben'), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.users.add('ben', password('ben'), 'viewer');
    f.forget('ben');
    const next = await f.snapshot('ben');
    assert.equal(next.mail.inbox.length, 0);
    assert.equal(next.mail.unread, 0);
    assert.equal((await f.call('ben', 'GET', `/messages/${data.id}`)).status, 404);
    // New mail to the name reaches whoever holds it now.
    assert.equal((await f.call('ada', 'POST', '/messages', letter(['ben'], { subject: 'For the second ben' }))).status, 201);
    assert.deepEqual((await f.snapshot('ben')).mail.inbox.map((m) => m.subject), ['For the second ben']);
  } finally { await f.close(); }
});

test('mail: only current members can be written to, never yourself, and a reply must answer something you can see', async () => {
  const f = await fixture();
  try {
    const theirs = await f.call<MessageView>('ben', 'POST', '/messages', letter(['cy']));
    const refused = async (body: unknown, who = 'ada') => { const reply = await f.call(who, 'POST', '/messages', body); assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 80)); assert.equal(reply.code, 'VALIDATION'); };
    await refused(letter(['nobody']));
    await refused(letter(['ada']));
    await refused(letter([]));
    await refused(letter(['ben'], { subject: '   ' }));
    await refused(letter(['ben'], { subject: 'x'.repeat(121) }));
    await refused(letter(['ben'], { body: '' }));
    await refused(letter(['ben'], { body: 'x'.repeat(4001) }));
    await refused(letter(['ben'], { from: 'cy' }));
    await refused(letter(['ben'], { replyTo: theirs.data.id }));
    await refused('{not json');
    f.users.update('vi', { disabled: true });
    await refused(letter(['vi']));
    assert.equal(existsSync(f.mailPath) ? (JSON.parse(readFileSync(f.mailPath, 'utf8')) as MailDocument).messages.length : 0, 1, 'a refused message is not stored');

    // Names are matched as accounts are: case and stray space do not make a new person.
    const tidy = await f.call<MessageView>('ada', 'POST', '/messages', letter([' Ben ', 'ben'], { subject: '  Two\tspaces\n here ' }));
    assert.equal(tidy.status, 201);
    assert.deepEqual(tidy.data.to, ['ben']);
    assert.equal(tidy.data.subject, 'Two spaces here');
    const answer = await f.call<MessageView>('ben', 'POST', '/messages', letter(['ada'], { replyTo: tidy.data.id }));
    assert.equal(answer.status, 201);
    assert.equal(answer.data.replyTo, tidy.data.id);
    assert.deepEqual((await f.snapshot('ada')).members, ['ada', 'ben', 'cy'], 'a disabled account is not someone to write to');
  } finally { await f.close(); }
});

test('reads need a session, and writes need the console header and this origin', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('', 'GET')).status, 401);
    assert.equal((await f.call('', 'POST', '/messages', '{not json')).status, 401, 'a stranger learns nothing from how a body is parsed');
    assert.equal((await f.call('ada', 'POST', '/messages', letter(['ben']), { 'x-tm-algo': '' })).status, 403);
    assert.equal((await f.call('ada', 'POST', '/requests', { title: 'From another site' }, { origin: 'https://elsewhere.invalid' })).status, 403);
    assert.equal((await f.call('ada', 'POST', '/requests/R-1/vote', { vote: true }, { 'x-tm-algo': '' })).status, 403);
    assert.equal(existsSync(f.mailPath) || existsSync(f.boardPath), false, 'nothing was written');
    assert.equal((await f.call('ada', 'GET', '/nothing-here')).status, 404);
    const mine = await f.snapshot('vi');
    assert.deepEqual(mine.me, { name: 'vi', canTriage: false, isAdmin: false });
    assert.deepEqual((await f.snapshot('cy')).me, { name: 'cy', canTriage: true, isAdmin: false });
    assert.deepEqual(mine.members, ['ada', 'ben', 'cy', 'vi']);
    assert.ok(!JSON.stringify(mine).includes('admin') && !JSON.stringify(mine).includes('engineer'), 'colleagues\' access roles are not handed to everyone');
    // What somebody works on is: it is how a task finds the right person.
    f.users.update('ben', { teamRoles: ['backend', 'ml'] });
    assert.deepEqual((await f.snapshot('vi')).teamRoles, { ben: ['ml', 'backend'] });
    assert.deepEqual((await f.snapshot('ben')).me, { name: 'ben', canTriage: true, isAdmin: false }, 'a team role changes no access and ends no session');
  } finally { await f.close(); }
});

test('board: anyone files a request and votes once; only write access decides its status', async () => {
  const f = await fixture();
  try {
    const filed = await f.call<RequestView>('vi', 'POST', '/requests', { title: 'Export a floor as CSV', detail: 'For the weekly report.' });
    assert.equal(filed.status, 201);
    assert.equal(filed.data.id, 'R-1');
    assert.equal(filed.data.votes, 1, 'filing it counts as wanting it');
    assert.deepEqual(filed.data.can, { edit: true, triage: false, vote: true, remove: true });

    assert.equal((await f.call<RequestView>('ben', 'POST', '/requests/R-1/vote', { vote: true })).data.votes, 2);
    assert.equal((await f.call<RequestView>('ben', 'POST', '/requests/R-1/vote', { vote: true })).data.votes, 2, 'a second vote from the same person changes nothing');
    assert.equal((await f.call<RequestView>('ben', 'POST', '/requests/R-1/vote', { vote: false })).data.votes, 1);
    assert.equal((await f.snapshot('ben')).board.requests[0]?.voted, false);
    assert.equal((await f.snapshot('vi')).board.requests[0]?.voted, true);

    const denied = await f.call('vi', 'PATCH', '/requests/R-1', { revision: 1, status: 'shipped' });
    assert.equal(denied.status, 403, 'a viewer cannot mark their own request shipped');
    assert.equal((await f.call<RequestView>('vi', 'PATCH', '/requests/R-1', { revision: 1, title: 'Export a floor as a CSV file' })).data.revision, 2, 'the author edits it while it is open');
    assert.equal((await f.call('ben', 'POST', '/requests', { title: 'Second' })).status, 201);

    const planned = await f.call<RequestView>('cy', 'PATCH', '/requests/R-1', { revision: 2, status: 'planned' });
    assert.equal(planned.status, 200);
    assert.equal(planned.data.status, 'planned');
    assert.equal((await f.call('vi', 'PATCH', '/requests/R-1', { revision: 3, title: 'Changed after the decision' })).status, 403, 'once it is decided on, the wording is no longer the author\'s alone');
    assert.equal((await f.call('vi', 'DELETE', '/requests/R-1', { revision: 3 })).status, 403);
    assert.equal((await f.call('cy', 'DELETE', '/requests/R-1', { revision: 3 })).status, 403, 'write access is not the right to delete someone\'s request');

    assert.equal((await f.call<RequestView>('ben', 'PATCH', '/requests/R-1', { revision: 3, status: 'shipped' })).data.can.vote, false);
    const late = await f.call('ada', 'POST', '/requests/R-1/vote', { vote: true });
    assert.equal(late.status, 409);
    assert.equal(late.code, 'CLOSED');
    assert.equal((await f.call('ada', 'DELETE', '/requests/R-1', { revision: 4 })).status, 200, 'an admin can delete any request');
    assert.deepEqual((await f.snapshot('vi')).board.requests.map((r) => r.id), ['R-2']);
    assert.equal((await f.call<RequestView>('vi', 'POST', '/requests', { title: 'Third' })).data.id, 'R-3', 'a deleted request\'s number is not handed out again');

    for (const body of [{ title: '' }, { title: 'x'.repeat(121) }, { title: 'ok', detail: 'x'.repeat(2001) }, { title: 'ok', status: 'shipped' }, { title: 'ok', votes: ['ada', 'ben'] }]) {
      assert.equal((await f.call('ada', 'POST', '/requests', body)).status, 400);
    }
    assert.equal((await f.call('ada', 'PATCH', '/requests/R-2', { revision: 1, status: 'done' })).status, 400);
    assert.equal((await f.call('ada', 'PATCH', '/requests/R-99', { revision: 1, status: 'planned' })).status, 404);
  } finally { await f.close(); }
});

test('board: a save made against an older revision is refused instead of overwriting', async () => {
  const f = await fixture();
  try {
    await f.call('ada', 'POST', '/requests', { title: 'Dark mode for the floor map' });
    assert.equal((await f.call('ada', 'PATCH', '/requests/R-1', { revision: 1, title: 'Dark mode for the 3D floor map' })).status, 200);
    const second = await f.call('ben', 'PATCH', '/requests/R-1', { revision: 1, status: 'declined' });
    assert.equal(second.status, 409);
    assert.equal(second.code, 'STALE_REVISION');
    const now = (await f.snapshot('ben')).board.requests[0];
    assert.equal(now?.title, 'Dark mode for the 3D floor map');
    assert.equal(now?.status, 'open');
    // A vote in between is not an edit: it must not make somebody's save stale.
    await f.call('cy', 'POST', '/requests/R-1/vote', { vote: true });
    assert.equal((await f.call('ben', 'PATCH', '/requests/R-1', { revision: 2, status: 'planned' })).status, 200);
    assert.equal((await f.call('ada', 'PATCH', '/requests/R-1', { status: 'shipped' })).status, 400, 'no revision, no save');
  } finally { await f.close(); }
});

test('tasks: write access hands them out, and whoever holds one reports on it, whatever their role', async () => {
  const f = await fixture();
  try {
    await f.call('vi', 'POST', '/requests', { title: 'Show last-seen time per sensor' });
    assert.equal((await f.call('vi', 'POST', '/tasks', { title: 'A task for myself' })).status, 403);
    const made = await f.call<TaskView>('ben', 'POST', '/tasks', { title: 'Add last-seen to the sensor table', assignee: 'vi', due: '2026-10-20', requestId: 'R-1' });
    assert.equal(made.status, 201);
    assert.equal(made.data.id, 'T-1');
    assert.equal(made.data.status, 'todo');
    assert.equal((await f.snapshot('vi')).board.requests[0]?.openTasks, 1);

    const mine = (await f.snapshot('vi')).board.tasks[0];
    assert.deepEqual(mine?.can, { edit: false, status: true, remove: false });
    const started = await f.call<TaskView>('vi', 'PATCH', '/tasks/T-1', { revision: 1, status: 'doing' });
    assert.equal(started.status, 200);
    assert.equal(started.data.status, 'doing');
    assert.equal((await f.call('vi', 'PATCH', '/tasks/T-1', { revision: 2, title: 'Something easier' })).status, 403, 'the assignee reports on the work, they do not redefine it');
    assert.equal((await f.call('vi', 'PATCH', '/tasks/T-1', { revision: 2, status: 'done', assignee: 'ben' })).status, 403);
    assert.equal((await f.call('vi', 'DELETE', '/tasks/T-1', { revision: 2 })).status, 403);

    assert.equal((await f.call('cy', 'PATCH', '/tasks/T-1', { revision: 2, assignee: 'nobody' })).status, 400);
    assert.equal((await f.call('cy', 'PATCH', '/tasks/T-1', { revision: 2, due: '2026-02-31' })).status, 400, 'a due date is a day that exists');
    assert.equal((await f.call('cy', 'POST', '/tasks', { title: 'For a request that is gone', requestId: 'R-9' })).status, 400);
    const moved = await f.call<TaskView>('cy', 'PATCH', '/tasks/T-1', { revision: 2, assignee: 'ben', due: null });
    assert.equal(moved.data.assignee, 'ben');
    assert.equal(moved.data.due, null);
    assert.equal((await f.call('vi', 'PATCH', '/tasks/T-1', { revision: 3, status: 'done' })).status, 403, 'it is no longer theirs to report on');
    assert.equal((await f.call<TaskView>('ben', 'PATCH', '/tasks/T-1', { revision: 3, status: 'done' })).data.status, 'done');
    assert.equal((await f.snapshot('vi')).board.requests[0]?.openTasks, 0);

    // Deleting the request leaves the work that was handed out.
    const request = (await f.snapshot('ada')).board.requests[0];
    assert.equal((await f.call('ada', 'DELETE', '/requests/R-1', { revision: request?.revision })).status, 200);
    assert.equal((await f.snapshot('ada')).board.tasks[0]?.requestId, null);
    assert.equal((await f.call('cy', 'DELETE', '/tasks/T-1', { revision: 4 })).status, 200);
    assert.equal((await f.snapshot('ada')).board.tasks.length, 0);
  } finally { await f.close(); }
});

test('a store this code did not write closes the feature and is left exactly as it was', async () => {
  const f = await fixture();
  try {
    await f.call('ada', 'POST', '/messages', letter(['ben']));
    for (const mangled of ['{half a file', JSON.stringify({ version: 2, messages: [] }), JSON.stringify({ version: 1, messages: [{ id: 'x', from: 'ada' }] })]) {
      writeFileSync(f.mailPath, mangled);
      const read = await f.call('ben', 'GET');
      assert.equal(read.status, 503);
      assert.equal(read.code, 'STORAGE_UNAVAILABLE');
      assert.equal((await f.call('ada', 'POST', '/messages', letter(['ben']))).status, 503);
      assert.equal(readFileSync(f.mailPath, 'utf8'), mangled, 'what could not be read is not overwritten');
    }
    // The board is a separate file: it still answers, just not through the shared listing.
    assert.equal((await f.call('ada', 'POST', '/requests', { title: 'Still here' })).status, 201);
    rmSync(f.mailPath);
    assert.equal((await f.snapshot('ben')).mail.inbox.length, 0, 'no file at all is an empty mailbox, not a broken one');
    mkdirSync(f.mailPath);
    assert.equal((await f.call('ben', 'GET')).status, 503);
  } finally { await f.close(); }
});

test('sending is limited per person, so one account cannot fill everyone\'s mailbox', async () => {
  const f = await fixture();
  try {
    f.at(Date.now() + 1000);
    for (let i = 0; i < 30; i++) assert.equal((await f.call('ada', 'POST', '/messages', letter(['ben'], { subject: `Message ${i}` }))).status, 201);
    const blocked = await f.call('ada', 'POST', '/messages', letter(['ben']));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.code, 'RATE_LIMITED');
    assert.equal((await f.call('cy', 'POST', '/messages', letter(['ben']))).status, 201, 'somebody else is not held back by it');
    assert.equal((await f.snapshot('ben')).mail.unread, 31);
  } finally { await f.close(); }
});

test('with sign-in off there is one person: the board works and there is nobody to write to', async () => {
  const f = await fixture(false);
  try {
    const view = await f.snapshot('local');
    assert.deepEqual(view.me, { name: 'local', canTriage: true, isAdmin: true });
    assert.deepEqual(view.members, ['local']);
    assert.equal((await f.call('local', 'POST', '/messages', letter(['ada']))).status, 400);
    assert.equal((await f.call('local', 'POST', '/requests', { title: 'Works on a laptop too' })).status, 201);
    assert.equal((await f.call<TaskView>('local', 'POST', '/tasks', { title: 'Mine', assignee: 'local' })).data.assignee, 'local');
  } finally { await f.close(); }
});

test('the algo console serves the workspace behind its sign-in, with its own small body limit', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tm-workspace-algo-'));
  // startAlgo takes its data directory from the environment when it is given
  // an auth config; without this the store would land in the checkout.
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const usersPath = join(dataDir, 'users.json');
  const users = new AlgoUsers(usersPath);
  await users.add('ada', password('ada'), 'admin');
  await users.add('ben', password('ben'), 'viewer');
  const config: EdgeConfig = { edgeId: 'workspace-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir,
    recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null,
    pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null,
    nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
  const runtime = createEdgeRuntime(config, buildRegistry(siteJson(), nodesJson()));
  const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: 'a'.repeat(64), ALGO_USERS_FILE: usersPath, DATA_DIR: dataDir }, config.adminPassword));
  await new Promise<void>((resolve) => handle.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/workspace`)).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: password('ada') }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const post = (path: string, body: string) => fetch(`${base}/api/workspace${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-tm-algo': '1' }, body });
    assert.equal((await post('/messages', JSON.stringify(letter(['ben'])))).status, 201);
    // 4000 characters is the limit people are told, and in Chinese that is
    // 12 kB on the wire: more than the sign-in router's parser would take.
    const longest = JSON.stringify(letter(['ben'], { body: '座'.repeat(4000) }));
    assert.ok(Buffer.byteLength(longest) > 12_000);
    assert.equal((await post('/messages', longest)).status, 201, 'a message of the stated length is accepted in any script');
    const big = await post('/messages', JSON.stringify(letter(['ben'], { body: 'x'.repeat(20_000) })));
    assert.equal(big.status, 400, 'a body past 16 kB is refused before it is read as a message');
    assert.deepEqual(await big.json(), { data: null, error: { code: 'VALIDATION', message: 'Invalid or oversized JSON body.' } });
    const view = (await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json() as { data: Snapshot }).data;
    assert.equal(view.mail.sent.length, 2);
    assert.equal(existsSync(join(dataDir, 'algo', 'workspace', 'mail.json')), true, 'kept in the data directory, which outlives a release');
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 200, 'the routes after it still parse their own bodies');
  } finally {
    await handle.dispose();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    await runtime.stop();
    if (before === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = before;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
