/**
 * Claims about ML-data download keys: a machine credential that may fetch its
 * owner's exports and do nothing else. The failures these guard against: a
 * key that outlives a password change, reads someone else's export, reaches
 * the database or any other route, or lands on disk or in a log in clear.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { TrainingDatabase } from '../src/algo/ml-data/database.js';
import { DownloadKeys } from '../src/algo/ml-data/download-keys.js';
import { Exports, type ExportJob } from '../src/algo/ml-data/exports.js';
import { createMlData } from '../src/algo/ml-data/routes.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

const db: TrainingDatabase = {
  schema: async () => [{ name: 'training.frames', kind: 'table' as const, columns: [], estimatedRows: 1, bytes: 500 }],
  query: async () => ({ columns: ['id'], rows: [['safe']], truncated: false, elapsedMs: 1 }), close: async () => undefined,
};
const dump = () => spawn(process.execPath, ['-e', 'process.stdout.write("CREATE TABLE training.frames(id text);\\nCOPY training.frames FROM stdin;\\nsafe\\n\\\\.\\n");']);

async function finished(exports: Exports, job: ExportJob) {
  for (let i = 0; i < 200; i++) {
    const state = exports.get(job.id, job.owner, job.epoch);
    if (!['queued', 'processing'].includes(state.state)) return state;
    await delay(10);
  }
  throw new Error('export did not finish');
}

/** A console with two accounts whose passwords and epochs the test can change. */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-keys-'));
  const subjects: Record<string, string | null> = { ada: 'ada:v1', bob: 'bob:v1' };
  const epochs: Record<string, string> = { ada: 'e1', bob: 'e1' };
  const auth = {
    principalOf: (req: { headers: { cookie?: string } }) => (req.headers.cookie === 'ada' ? principal('ada', 'operator') : req.headers.cookie === 'bob' ? principal('bob', 'viewer') : null),
    accountEpoch: (name: string) => epochs[name] ?? null,
    accountSubject: (name: string) => subjects[name] ?? null,
  };
  const exports = new Exports(join(dir, 'exports'), db, dump, 1_000_000, 1);
  const service = createMlData(auth, { env: {}, dataDir: dir, db, exports });
  const app = express();
  app.use(express.json());
  app.use('/api/ml-data/keyed', service.keyed);
  app.use('/api/ml-data', service.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ml-data`;
  const session = (who: string) => ({ cookie: who, 'Content-Type': 'application/json', 'x-tm-algo': '1' });
  const issue = async (who: string, body: unknown = { label: 'iw-g2 training', hours: 24 }) =>
    fetch(`${base}/keys`, { method: 'POST', headers: session(who), body: JSON.stringify(body) });
  const close = async () => { server.close(); await exports.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, subjects, epochs, exports, base, session, issue, close };
}

test('a download key fetches its owner\'s finished export, resumably, and is shown only once', async () => {
  const h = await harness();
  try {
    const job = await finished(h.exports, h.exports.start('ada', 'e1', ['training.frames']));
    const made = await (await h.issue('ada')).json() as { id: string; key: string; expiresAt: number };
    assert.match(made.key, /^tmdata_[0-9a-f]{64}$/);
    const bearer = { authorization: `Bearer ${made.key}` };
    const list = await (await fetch(`${h.base}/keyed/exports`, { headers: bearer })).json() as { jobs: { id: string }[] };
    assert.deepEqual(list.jobs.map((j) => j.id), [job.id]);
    const part = await fetch(`${h.base}/keyed/exports/${job.id}/download`, { headers: { ...bearer, Range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.match(part.headers.get('cache-control') ?? '', /no-store/);
    const listed = await (await fetch(`${h.base}/keys`, { headers: h.session('ada') })).json() as { keys: Record<string, unknown>[] };
    assert.equal(listed.keys.length, 1);
    assert.equal(JSON.stringify(listed).includes(made.key), false, 'the key is never shown again');
  } finally { await h.close(); }
});

test('only the key\'s digest is stored, privately, and no log or audit line carries it', async () => {
  const h = await harness();
  try {
    const made = await (await h.issue('ada')).json() as { key: string; id: string };
    await fetch(`${h.base}/keys/${made.id}`, { method: 'DELETE', headers: h.session('ada') });
    const file = join(h.dir, 'algo', 'ml-download-keys.json');
    assert.equal(statSync(file).mode & 0o077, 0, 'the key file is readable by its owner only');
    for (const f of [file, `${file}.audit.jsonl`]) assert.equal(readFileSync(f, 'utf8').includes(made.key.slice(7)), false, `${f} holds the key`);
  } finally { await h.close(); }
});

test('a key reads only its owner\'s exports and reaches nothing else in the console', async () => {
  const h = await harness();
  try {
    const bobs = await finished(h.exports, h.exports.start('bob', 'e1', ['training.frames']));
    const { key } = await (await h.issue('ada')).json() as { key: string };
    const bearer = { authorization: `Bearer ${key}` };
    assert.equal((await fetch(`${h.base}/keyed/exports/${bobs.id}`, { headers: bearer })).status, 404);
    assert.equal((await fetch(`${h.base}/keyed/exports/${bobs.id}/download`, { headers: bearer })).status, 404);
    assert.equal((await fetch(`${h.base}/keyed/exports`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{"tables":["training.frames"]}' })).status, 405,
      'a key cannot start an export');
    // The signed-in API does not take keys: the database, schema and key management stay behind the human sign-in.
    for (const [method, path] of [['POST', '/query'], ['GET', '/schema'], ['GET', '/keys'], ['GET', '/exports']] as const) {
      assert.equal((await fetch(`${h.base}${path}`, { method, headers: { ...bearer, 'Content-Type': 'application/json', 'x-tm-algo': '1' }, body: method === 'POST' ? '{"sql":"SELECT 1"}' : undefined })).status, 401, path);
    }
    assert.equal((await fetch(`${h.base}/keyed/exports`, { headers: { cookie: 'ada' } })).status, 401, 'the key door looks at no cookie');
    assert.equal((await fetch(`${h.base}/keyed/exports`, { headers: { authorization: 'Bearer tmdata_' + '0'.repeat(64) } })).status, 401);
  } finally { await h.close(); }
});

test('a key stops working when its owner\'s password changes, the account goes, or it is revoked', async () => {
  const h = await harness();
  try {
    const keyOf = async () => (await (await h.issue('ada')).json() as { key: string; id: string });
    const works = async (key: string) => (await fetch(`${h.base}/keyed/exports`, { headers: { authorization: `Bearer ${key}` } })).status === 200;

    const a = await keyOf();
    assert.equal(await works(a.key), true);
    h.subjects.ada = 'ada:v2';                       // password changed
    assert.equal(await works(a.key), false);

    const b = await keyOf();
    h.epochs.ada = 'e2';                             // account deleted and recreated under the same name
    assert.equal(await works(b.key), false);

    const c = await keyOf();
    h.subjects.ada = null;                           // account disabled
    assert.equal(await works(c.key), false);
    h.subjects.ada = 'ada:v2';
    assert.equal(await works(c.key), true);

    assert.equal((await fetch(`${h.base}/keys/${c.id}`, { method: 'DELETE', headers: h.session('bob') })).status, 404, 'nobody revokes another person\'s key');
    assert.equal((await fetch(`${h.base}/keys/${c.id}`, { method: 'DELETE', headers: h.session('ada') })).status, 204);
    assert.equal(await works(c.key), false);
  } finally { await h.close(); }
});

test('keys expire on their own, take one of three lifetimes, and an account holds at most eight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-keys-unit-'));
  let now = 1_800_000_000_000;
  try {
    const keys = new DownloadKeys(join(dir, 'keys.json'), () => 'ada:v1', () => 'e1', () => now);
    assert.throws(() => keys.issue('ada', 'x', 2), /1 hour, 24 hours or 7 days/);
    assert.throws(() => keys.issue('ada', '', 24), /label/);
    const hour = keys.issue('ada', 'short', 1);
    assert.equal(keys.authorize(hour.key)?.owner, 'ada');
    now += 3600_000;
    assert.equal(keys.authorize(hour.key), null, 'an hour later the one-hour key is gone');
    for (let i = 0; i < 8; i++) keys.issue('ada', `k${i}`, 168);
    assert.throws(() => keys.issue('ada', 'ninth', 24), /Revoke an old download key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
