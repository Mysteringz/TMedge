import assert from 'node:assert/strict';
import { fsync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_NODE_LIMITS } from '../src/edge/config.js';
import { Ingest, type DirectSession } from '../src/edge/ingest.js';
import { NodeServer } from '../src/edge/nodelink.js';
import { ReplayStore } from '../src/edge/replay.js';
import { DirectNodeClient } from '../src/tools/directnode.js';
import { identity, KEY, report } from './fixtures.js';

const UID = '30:ed:a0:cb:f5:f8';
const journalPath = () => join(mkdtempSync(join(tmpdir(), 'durable-ingest-')), 'replay.jsonl');
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(condition(), 'expected state reached');
};
const actualSync = (fd: number) => new Promise<void>((resolve, reject) => fsync(fd, (error) => error ? reject(error) : resolve()));

test('a cursor made durable after a session closes cannot be replayed through its older live link', async () => {
  let finish: (() => void) | undefined;
  let isOpen = true;
  let syncs = 0;
  const path = journalPath();
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY, cursorPath: path,
    journalSync: (fd) => {
      if (syncs++ > 0) return actualSync(fd);
      return new Promise<void>((resolve, reject) => {
        finish = () => { void actualSync(fd).then(resolve, reject); };
      });
    },
  });
  const id = identity(UID, 5);
  assert.equal(ing.handle(report(id, [], 1), '10.0.0.1').ok, true);
  const later = report(id, [], 2);
  const session: DirectSession = {
    uid: UID, sessionId: 'closing', key: KEY, send: () => true, grantOta: () => true,
    admit: () => null, isOpen: () => isOpen,
  };
  const pending = ing.handleDurable(later, { kind: 'direct', address: `ws:${UID}:closing`, session });
  await until(() => Boolean(finish));
  isOpen = false;
  finish!();
  assert.equal((await pending).ok, false, 'a closed session receives no admission');
  assert.equal(ing.links.get(UID)?.seq, 0, 'the prior accepted link survives');
  const replayed = await ing.handleDurable(later, '10.0.0.2');
  assert.equal(replayed.ok, false, 'durable cursor still protects the unacknowledged packet');
  assert.equal(ing.links.get(UID)?.address, '10.0.0.1');
  await ing.stop();
});

test('direct node ACKs and routes wait for actual durable journal completion', async () => {
  let finish: (() => void) | undefined;
  const path = journalPath();
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY, cursorPath: path,
    journalSync: (fd) => new Promise<void>((resolve, reject) => {
      finish = () => { void actualSync(fd).then(resolve, reject); };
    }),
  });
  const server = new NodeServer({ port: 0, host: '127.0.0.1', limits: DEFAULT_NODE_LIMITS, keys: [KEY],
    isRegistered: (uid) => uid === UID, ingest: (d, route) => ing.handleDurable(d, route),
    dropRoute: (uid, sid) => void ing.dropDirectRoute(uid, sid), image: () => null, otaApproved: () => false,
  });
  const port = await server.listen();
  const client = new DirectNodeClient(`ws://127.0.0.1:${port}/tmnode`, UID, KEY);
  try {
    await client.connect();
    const packet = report(identity(UID, 5), [], 1);
    client.send(packet);
    await until(() => Boolean(finish));
    assert.equal(client.acks.length, 0);
    assert.equal(ing.links.size, 0);
    assert.equal(server.sessions()[0]?.active, false);
    finish!();
    await client.until(() => client.acks.length === 1);
    assert.equal(ing.links.get(UID)?.route?.kind, 'direct');
    assert.equal(new ReplayStore(path).cursors.get(UID)?.seq, 0);
    client.send(packet);
    await until(() => server.sessions()[0]?.rejected === 1);
    assert.equal(client.acks.length, 1, 'a concurrent/retried duplicate receives no new ACK');
  } finally { client.close(); await server.close(); await ing.stop(); }
});

test('a delayed STATUS command observation cannot lower a newer durable command cursor', async () => {
  const path = journalPath();
  let finish: (() => void) | undefined;
  const store = new ReplayStore(path, { sync: (fd) => new Promise<void>((resolve, reject) => {
    finish = () => { void actualSync(fd).then(resolve, reject); };
  }) });
  const pending = store.acceptAsync(UID, { boot: 1, seq: 1 }, 100);
  store.command(200); // Durable before the older STATUS batch even starts.
  await until(() => Boolean(finish));
  finish!();
  await pending;
  assert.equal(store.commandSeq, 200);
  assert.equal(new ReplayStore(path).commandSeq, 200, 'startup preserves high water independent of record order');
});
