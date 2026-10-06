import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rollouts, type RolloutNode } from '../src/edge/rollout.js';

const OLD_BUILD = 'a'.repeat(16);
const NEW_BUILD = 'b'.repeat(16);
const IMAGE = { bytes: Buffer.from('image'), sha256: 'a'.repeat(64), size: 5, version: '1.0.0' };

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(transport: 'direct' | 'gateway', ota: () => Promise<void> = async () => undefined) {
  const commits: ReturnType<typeof deferred>[] = [];
  const images: string[] = [];
  const requests: string[] = [];
  const node: RolloutNode = {
    uid: 'same-node', label: 'Node', floorId: 'f1', online: true, transport,
    address: transport === 'gateway' ? 'gw:g1|10.0.0.2:5200' : 'ws:same-node:session',
  };
  const rollouts = new Rollouts({
    image: () => IMAGE,
    nodes: () => [node],
    beforeDispatch: () => {
      const commit = deferred();
      commits.push(commit);
      return commit.promise;
    },
    sendImageToGateway: (_gateway, image) => { images.push(image.id); return true; },
    sendOta: async (_uid, image) => { requests.push(image.path); await ota(); },
    directPort: 8090,
    now: () => 100,
  });
  return { rollouts, commits, images, requests };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const transport of ['direct', 'gateway'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`${transport} dispatch stays cancelled when pending persistence ${outcome}s`, async () => {
      const h = harness(transport);
      const stopped = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
      assert.equal(h.commits.length, 1);

      h.rollouts.cancel('operator');
      const cancelled = JSON.stringify(stopped);
      if (outcome === 'resolve') h.commits[0]?.resolve();
      else h.commits[0]?.reject(new Error('database disconnected'));
      await settle();

      assert.equal(stopped.stage, 'stopped');
      assert.equal(stopped.nodes[0]?.state, 'skipped', 'no OTA was sent before cancellation');
      assert.equal(JSON.stringify(stopped), cancelled, 'stale persistence does not mutate stopped history');
      assert.deepEqual(h.images, []);
      assert.deepEqual(h.requests, []);
    });

    test(`${transport} replacement stays isolated when old persistence ${outcome}s`, async () => {
      const h = harness(transport);
      const old = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
      h.rollouts.cancel('operator');
      const stopped = JSON.stringify(old);
      const replacement = h.rollouts.start(NEW_BUILD, { kind: 'all' }, 'operator');
      assert.equal(h.commits.length, 2, 'the same UID can launch in the replacement immediately');
      const pendingReplacement = JSON.stringify(replacement);

      if (outcome === 'resolve') h.commits[0]?.resolve();
      else h.commits[0]?.reject(new Error('old persistence failed'));
      await settle();
      h.rollouts.tick();

      assert.equal(h.commits.length, 2, 'old cleanup cannot release the replacement launch lock');
      assert.equal(JSON.stringify(replacement), pendingReplacement);
      assert.equal(JSON.stringify(old), stopped);
      assert.deepEqual(h.images, []);
      assert.deepEqual(h.requests, []);

      h.commits[1]?.resolve();
      await settle();
      h.rollouts.tick();
      if (transport === 'direct') assert.deepEqual(h.requests, [`/fw/${NEW_BUILD}.bin`]);
      else assert.deepEqual(h.images, [NEW_BUILD], 'old failure cannot clear the replacement gateway request');
      assert.equal(h.rollouts.current(), replacement);
    });
  }

  test(`${transport} dispatch rechecks node eligibility after persistence`, async () => {
    const h = harness(transport);
    const current = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
    if (transport === 'gateway') {
      h.commits[0]?.resolve();
      await settle();
      assert.deepEqual(h.images, [OLD_BUILD], 'gateway receives the image before node delivery starts');
      h.rollouts.onImageReady('g1', { id: OLD_BUILD, ok: true, port: 8080 });
      assert.equal(h.commits.length, 2, 'node dispatch has its own persistence gate');
    }
    h.rollouts.onOtaStatus('same-node', { state: 'confirmed', percent: 100, error: '', image: OLD_BUILD.slice(0, 8) });
    assert.equal(current.stage, 'done');

    h.commits[transport === 'direct' ? 0 : 1]?.resolve();
    await settle();

    assert.deepEqual(h.images, transport === 'direct' ? [] : [OLD_BUILD]);
    assert.deepEqual(h.requests, []);
    assert.equal(current.nodes[0]?.state, 'confirmed');
  });

  test(`${transport} can retry a failed pre-dispatch persistence write`, async () => {
    const h = harness(transport);
    const current = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
    h.commits[0]?.reject(new Error('temporary database failure'));
    await settle();
    assert.equal(current.nodes[0]?.state, 'queued');

    h.rollouts.tick();
    assert.equal(h.commits.length, 2);
    h.commits[1]?.resolve();
    await settle();

    if (transport === 'direct') assert.deepEqual(h.requests, [`/fw/${OLD_BUILD}.bin`]);
    else assert.deepEqual(h.images, [OLD_BUILD]);
  });
}

for (const replace of [false, true]) {
  test(`late OTA rejection leaves ${replace ? 'replacement' : 'cancelled'} rollout unchanged`, async () => {
    const dispatch = deferred();
    const h = harness('direct', () => dispatch.promise);
    const old = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
    h.commits[0]?.resolve();
    await settle();
    assert.deepEqual(h.requests, [`/fw/${OLD_BUILD}.bin`]);

    h.rollouts.cancel('operator');
    assert.equal(old.nodes[0]?.state, 'sending', 'already dispatched OTA keeps its current state');
    const stopped = JSON.stringify(old);
    const current = replace ? h.rollouts.start(NEW_BUILD, { kind: 'all' }, 'operator') : old;
    const snapshot = JSON.stringify(current);
    dispatch.reject(new Error('old node session closed'));
    await settle();

    assert.equal(JSON.stringify(old), stopped);
    assert.equal(JSON.stringify(current), snapshot);
    assert.equal(h.rollouts.current(), current);
    if (replace) {
      h.rollouts.cancel('operator');
      h.commits[1]?.resolve();
      await settle();
    }
  });
}

test('cancellation still accepts progress from an OTA already dispatched', async () => {
  const h = harness('direct');
  const current = h.rollouts.start(OLD_BUILD, { kind: 'all' }, 'operator');
  h.commits[0]?.resolve();
  await settle();
  h.rollouts.cancel('operator');

  h.rollouts.onOtaStatus('same-node', { state: 'confirmed', percent: 100, error: '', image: OLD_BUILD.slice(0, 8) });

  assert.deepEqual(h.requests, [`/fw/${OLD_BUILD}.bin`]);
  assert.equal(current.stage, 'stopped');
  assert.equal(current.nodes[0]?.state, 'confirmed');
});
