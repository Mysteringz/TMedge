import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdoptionCredentials } from '../src/edge/adoption-credentials.js';

test('flasher credentials persist as private digests, expire and can be revoked after a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-adoption-')), 'credentials.json');
  let now = Date.now();
  const store = new AdoptionCredentials(path, () => now);
  assert.equal(store.authorize(null), false);
  const issued = store.issue('Bench Mac', 1, 'algo:alice');
  assert.equal(statSync(path).mode & 0o077, 0);
  assert.ok(!readFileSync(path, 'utf8').includes(issued.token));
  const restarted = new AdoptionCredentials(path, () => now);
  assert.equal(restarted.authorize(issued.token), true);
  assert.equal(restarted.authorize(issued.token + 'extra'), false);
  assert.ok(!JSON.stringify(restarted.list()).includes('digest'));
  now += 3600_000;
  assert.equal(restarted.authorize(issued.token), false);
  const replacement = restarted.issue('Replacement', 24, 'algo:bob');
  restarted.revoke(replacement.id);
  assert.equal(restarted.authorize(replacement.token), false);
  assert.deepEqual(new AdoptionCredentials(path).list(), []);
});

test('malformed credential storage fails closed and cannot expose its contents', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-adoption-')), 'credentials.json');
  const store = new AdoptionCredentials(path);
  const issued = store.issue('Bench', 24, 'algo:alice');
  writeFileSync(path, '{private credential data');
  assert.equal(store.authorize(issued.token), false);
  assert.throws(() => store.list(), /flasher credential storage is unavailable/);
  assert.throws(() => store.issue('Other', 24, 'algo:alice'), /storage is unavailable/);
});

test('account-bound sessions fail closed until bound and disappear when the account changes', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-account-session-')), 'credentials.json');
  let subject: string | null = 'alice:password-fingerprint';
  const store = new AdoptionCredentials(path);
  store.bindAccounts(name => name === 'alice' ? subject : null);
  const session = store.issueForAccount('TMflash on Mac', 24, 'alice');
  assert.equal(store.authorize(session.token), true);
  assert.equal(new AdoptionCredentials(path).authorize(session.token), false);
  subject = 'alice:changed-password';
  assert.equal(store.authorize(session.token), false);
  assert.deepEqual(store.list(), []);
  const next = store.issueForAccount('TMflash on Mac', 24, 'alice');
  assert.equal(store.authorize(next.token), true);
  subject = null;
  assert.equal(store.authorize(next.token), false);
  assert.throws(() => store.issueForAccount('TMflash on Mac', 24, 'alice'), /active algo account/);
});
