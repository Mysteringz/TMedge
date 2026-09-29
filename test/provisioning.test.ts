/**
 * Claims about admitting a node TMflash has just flashed.
 *
 * The thing worth protecting here is the gap between asking and being let
 * in. A provisioning token is held by every laptop that flashes a node, so
 * it has to be worth as little as possible: it buys a row in a list, and a
 * person at the console decides. And what it buys is an identity, never a
 * placement -- a node admitted this way must not be able to move a number a
 * student sees until somebody has been up a ladder with it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Provisioning } from '../src/edge/provisioning.js';
import { buildRegistry } from '../src/edge/registry.js';
import { nodesJson, siteJson } from './fixtures.js';

const TOKEN = 'x'.repeat(32);
const NEW_UID = '30:ed:a0:11:22:33';

function setup(now = () => 1_000) {
  const dir = mkdtempSync(join(tmpdir(), 'tmedge-prov-'));
  const nodesPath = join(dir, 'nodes.json');
  writeFileSync(nodesPath, JSON.stringify(nodesJson(), null, 2));
  const reg = buildRegistry(siteJson(), nodesJson());
  const p = new Provisioning(reg, { token: TOKEN, nodesPath, auditPath: join(dir, 'audit.jsonl'), now });
  return { p, reg, nodesPath, dir };
}

test('a provisioning token queues a request and cannot admit anything by itself', () => {
  const { p, reg, nodesPath } = setup();

  assert.equal(p.authorise(TOKEN), true);
  assert.equal(p.authorise('nearly' + 'x'.repeat(26)), false, 'a wrong token of the same length');
  assert.equal(p.authorise(null), false);

  const out = p.request({ uid: NEW_UID, label: 'Above M11', firmware: '1.4.2' }, '10.0.0.9');
  assert.equal(out.status, 'pending');

  // The whole point: asking changed nothing that matters.
  assert.equal(reg.nodes.has(NEW_UID), false, 'not registered by asking');
  assert.equal(p.statusOf(NEW_UID), 'pending');
  const onDisk = JSON.parse(readFileSync(nodesPath, 'utf8')) as { nodes: { uid: string }[] };
  assert.ok(!onDisk.nodes.some((n) => n.uid === NEW_UID), 'and nothing was written to nodes.json');
});

test('an edge with no token configured refuses every request, including an empty one', () => {
  const reg = buildRegistry(siteJson(), nodesJson());
  const p = new Provisioning(reg, { token: null, nodesPath: '', auditPath: '' });
  assert.equal(p.enabled, false);
  assert.equal(p.authorise(''), false);
  assert.equal(p.authorise(TOKEN), false);
  assert.equal(p.authorise(null), false, 'no token configured is not "anything goes"');
});

test('approval admits an identity, never a placement', () => {
  const { p, reg, nodesPath } = setup();
  const before = [...reg.tables.values()].map((t) => ({ id: t.id, owner: t.owner, covered: [...t.coveredBy] }));

  const out = p.request({ uid: NEW_UID, label: 'Above M11' }, '10.0.0.9');
  assert.equal(out.status, 'pending');
  const node = p.approve(out.status === 'pending' ? out.request.id : '', 'console');

  assert.equal(node.floorId, null, 'admitted nowhere');
  assert.equal(node.pose, null, 'with no pose to project through');
  assert.deepEqual(node.owns, [], 'and owning nothing');
  assert.equal(node.rgb, false);

  // It can authenticate now -- that is what admission is for.
  assert.equal(reg.nodes.has(NEW_UID), true);
  assert.equal(p.statusOf(NEW_UID), 'registered');

  // And not one table's ownership or coverage moved, which is what makes it
  // safe to do to a running edge.
  const after = [...reg.tables.values()].map((t) => ({ id: t.id, owner: t.owner, covered: [...t.coveredBy] }));
  assert.deepEqual(after, before, 'no table changed hands');

  // Written as an unplaced entry, and the rest of the file is intact.
  const onDisk = JSON.parse(readFileSync(nodesPath, 'utf8')) as { nodes: Record<string, unknown>[] };
  const written = onDisk.nodes.find((n) => n.uid === NEW_UID);
  assert.deepEqual(written, { uid: NEW_UID, label: 'Above M11' }, 'only uid and label');
  assert.equal(onDisk.nodes.length, nodesJson().nodes.length + 1, 'everything else still there');

  // And the file it wrote still loads: an admission that stopped the edge
  // from starting next time would be worse than no admission at all.
  const reloaded = buildRegistry(siteJson(), onDisk);
  assert.equal(reloaded.nodes.get(NEW_UID)?.pose, null);
});

test('a denied request leaves nothing behind, and a stale one expires', () => {
  let now = 1_000;
  const { p, reg, nodesPath } = setup(() => now);

  const denied = p.request({ uid: NEW_UID, label: 'Nope' }, '10.0.0.9');
  p.deny(denied.status === 'pending' ? denied.request.id : '', 'console');
  assert.equal(p.statusOf(NEW_UID), 'unknown');
  assert.equal(reg.nodes.has(NEW_UID), false);
  assert.ok(!readFileSync(nodesPath, 'utf8').includes(NEW_UID));

  const stale = p.request({ uid: NEW_UID, label: 'Later' }, '10.0.0.9');
  const id = stale.status === 'pending' ? stale.request.id : '';
  now += 31 * 60_000;
  assert.equal(p.statusOf(NEW_UID), 'unknown', 'an unanswered request does not wait forever');
  assert.throws(() => p.approve(id, 'console'), /no such request/);
});

test('a request is checked before it reaches anyone, and cannot flood the console', () => {
  const { p } = setup();

  assert.throws(() => p.request({ uid: 'not-a-mac' }, 'x'), /uid must be a MAC/);
  assert.throws(() => p.request({ uid: NEW_UID, label: '<script>x</script>' }, 'x'), /label may only contain/);

  // A node already in the config is answered, not queued: re-flashing one
  // should not ask an admin to approve what is already true.
  const known = nodesJson().nodes[0]?.uid as string;
  assert.equal(p.request({ uid: known }, 'x').status, 'already-registered');

  // Asking twice for the same node is one question.
  const a = p.request({ uid: NEW_UID }, 'x');
  const b = p.request({ uid: NEW_UID }, 'x');
  assert.equal(a.status === 'pending' && b.status === 'pending' && a.request.id, b.status === 'pending' ? b.request.id : '');
  assert.equal(p.requests().length, 1);

  for (let i = 0; i < 31; i++) p.request({ uid: `aa:bb:cc:00:00:${i.toString(16).padStart(2, '0')}` }, 'x');
  assert.throws(() => p.request({ uid: 'aa:bb:cc:00:01:00' }, 'x'), /too many requests/);
});
