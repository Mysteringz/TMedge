import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserStore, Sessions, AuthBusyError } from '../src/web/auth.js';
import { SnapshotPublishers } from '../src/web/publishers.js';
import { withPrivateFileLock, FileBusyError } from '../src/shared/private-file.js';
import { GatewayKeys } from '../src/edge/secure.js';
import { HelloReplayStore } from '../src/edge/hello-replay.js';

const directory = () => mkdtempSync(join(tmpdir(), 'auth-commits-'));

test('independent account writers preserve registrations and lock contention never replaces data', async () => {
  const path = join(directory(), 'users.json');
  const a = new UserStore(path, []), b = new UserStore(path, []);
  await a.create('a@example.com', 'A', 'password-for-tests');
  await b.create('b@example.com', 'B', 'password-for-tests');
  assert.equal(a.size, 2); assert.equal(b.size, 2);
  const prior = readFileSync(path);
  writeFileSync(`${path}.lock`, '{}', { mode: 0o600 });
  await assert.rejects(a.create('c@example.com', 'C', 'password-for-tests'), AuthBusyError);
  assert.deepEqual(readFileSync(path), prior); unlinkSync(`${path}.lock`);
  const outcomes = await Promise.allSettled([a.create('same@example.com', 'A', 'password-for-tests'), b.create('same@example.com', 'B', 'password-for-tests')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
});

test('separate Node processes serialize account commits without dropping another writer', async () => {
  const path = join(directory(), 'users.json');
  const module = pathToFileURL(resolve('dist/src/web/auth.js')).href;
  const script = `const {UserStore,AuthBusyError}=await import(process.argv[1]); const s=new UserStore(process.argv[2],[]); for(let i=0;i<20;i++){try{await s.create(process.argv[3],"Test","password-for-tests");break;}catch(e){if(!(e instanceof AuthBusyError)||i===19)throw e;await new Promise(r=>setTimeout(r,10));}}`;
  await Promise.all(['one', 'two', 'three'].map(n => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, module, path, `${n}@example.com`])));
  assert.equal(new UserStore(path, []).size, 3);
});

test('Google-linked legacy passwords are unusable and account version changes revoke sessions', async () => {
  const path = join(directory(), 'users.json'), store = new UserStore(path, []);
  const user = await store.create('owner@example.com', 'Owner', 'password-for-tests');
  writeFileSync(path, JSON.stringify([{ ...user, google: 'verified-subject' }]), { mode: 0o600 });
  assert.equal(await store.verify(user.email, 'password-for-tests'), null);
  assert.equal(store.google({ sub: 'verified-subject', email: user.email, name: 'Owner' }, false).email, user.email);
  let version = 'one'; const sessions = new Sessions(Buffer.alloc(32, 1), undefined, undefined, () => version);
  const token = sessions.issue(user.email); assert.equal(sessions.read(token), user.email);
  version = 'two'; assert.equal(sessions.read(token), null);
  const old = new Sessions(Buffer.alloc(32, 1)).issue(user.email); assert.equal(sessions.read(old), null);
});

test('independent revocation writers merge their committed state and stale locks fail closed', () => {
  const path = join(directory(), 'revocations.json'), secret = Buffer.alloc(32, 1);
  const a = new Sessions(secret, undefined, path), b = new Sessions(secret, undefined, path);
  const t1 = a.issue('one'), t2 = b.issue('two'); a.revoke(t1); b.revoke(t2);
  assert.equal(a.read(t2), null); assert.equal(b.read(t1), null);
  withPrivateFileLock(path, () => assert.throws(() => withPrivateFileLock(path, () => undefined), FileBusyError));
});

test('publisher credentials bind edge identity and exclusive floor ownership', () => {
  const policy = new SnapshotPublishers({ version: 1, edges: { edge1: { token: '11'.repeat(32), floors: ['floor1'] }, edge2: { token: '22'.repeat(32), floors: ['floor2'] } } });
  assert.equal(policy.authenticate('edge1', Buffer.from('11'.repeat(32))), true);
  assert.equal(policy.authenticate('edge2', Buffer.from('11'.repeat(32))), false);
  assert.equal(policy.authenticate('invented', Buffer.from('11'.repeat(32))), false);
  assert.equal(policy.authorizes({ edgeId: 'edge1', floors: [{ id: 'floor2' }] } as never), false);
  assert.equal(policy.authorizes({ edgeId: 'edge1', floors: [{ id: 'floor1' }] } as never), true);
  assert.throws(() => new SnapshotPublishers({ version: 1, edges: { a: { token: '11'.repeat(32), floors: ['floor1'] }, b: { token: '22'.repeat(32), floors: ['floor1'] } } }), /one authorized/);
});

test('gateway credentials isolate identities and rotation expires without shared-token fallback', () => {
  let now = 1000;
  const keys = new GatewayKeys({ version: 1, gateways: { gw1: { current: '11'.repeat(32), previous: { secret: '22'.repeat(32), expiresAt: 2000 } }, gw2: { current: '33'.repeat(32), revoked: true } } }, () => now);
  assert.equal(keys.tokens('gw1').length, 2); assert.equal(keys.tokens('gw2').length, 0); assert.equal(keys.tokens('unknown').length, 0);
  now = 2000; assert.equal(keys.tokens('gw1').length, 1);
});

test('gateway HELLO proofs stay spent across restart, reject clock rollback, and refuse corrupt journals', () => {
  const path = join(directory(), 'hello.json');
  assert.equal(new HelloReplayStore(path).accept('gw1', 'nonce1', 61000, 1000), true);
  assert.equal(new HelloReplayStore(path).accept('gw1', 'nonce1', 61000, 1001), false);
  assert.equal(new HelloReplayStore(path).accept('gw1', 'nonce2', 60999, 999), false);
  writeFileSync(path, '{'); assert.throws(() => new HelloReplayStore(path));
});
