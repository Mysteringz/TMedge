import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rollouts } from '../src/edge/rollout.js';
import { DurableRolloutService } from '../src/modules/rollouts/application/durable-rollout-service.js';
import type { RolloutRecord, RolloutRepository } from '../src/modules/rollouts/repositories/rollout-repository.js';

const node = { uid: 'aa', label: 'A', floorId: 'f1', address: '10.0.0.2', transport: 'direct' as const, online: true };
const image = { bytes: Buffer.from('image'), sha256: 'a'.repeat(64), size: 5, version: '1.0.0' };

function core(events: string[], shouldFail = false) {
  return new Rollouts({
    image: () => image,
    nodes: () => [node],
    sendImageToGateway: () => true,
    sendOta: async () => { events.push('dispatch'); },
    directPort: 8090,
    now: () => 100,
  });
}

function repository(events: string[], fail = false): RolloutRepository {
  let saved: RolloutRecord | null = null;
  return {
    current: async () => saved,
    history: async () => saved?.stage === 'done' || saved?.stage === 'stopped' ? [saved] : [],
    saveSnapshot: async (current, history) => {
      events.push('commit');
      if (fail) throw new Error('database unavailable');
      saved = current ?? history[0] ?? null;
    },
    interruptActive: async () => null,
  };
}

test('rollout snapshot commits before OTA dispatch', async () => {
  const events: string[] = [];
  const rollouts = core(events);
  const service = new DurableRolloutService(rollouts, repository(events));
  await service.initialize();
  await service.start('a'.repeat(16), { kind: 'all' }, 'console');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 2), ['commit', 'commit']);
  assert.equal(events.at(-1), 'dispatch');
  assert.ok(events.indexOf('commit') < events.indexOf('dispatch'));
  await service.dispose();
});

test('failed rollout persistence restores idle state and prevents dispatch', async () => {
  const events: string[] = [];
  const rollouts = core(events, true);
  const service = new DurableRolloutService(rollouts, repository(events, true));
  await service.initialize();
  await assert.rejects(service.start('a'.repeat(16), { kind: 'all' }, 'console'), /persistence is unavailable/);
  assert.equal(rollouts.current(), null);
  assert.equal(events.includes('dispatch'), false);
  await service.dispose();
});

test('durable cancellation prevents OTA dispatch waiting for its commit', async () => {
  const events: string[] = [];
  let finishDispatchCommit: () => void = () => undefined;
  let dispatchCommitStarted: () => void = () => undefined;
  const pendingCommit = new Promise<void>((resolve) => { finishDispatchCommit = resolve; });
  const dispatchCommit = new Promise<void>((resolve) => { dispatchCommitStarted = resolve; });
  const rollouts = new Rollouts({
    image: () => image,
    nodes: () => [node],
    sendImageToGateway: () => { events.push('image'); return true; },
    sendOta: async () => { events.push('ota'); },
    directPort: 8090,
    now: () => 100,
  });
  const repo = repository(events);
  const saveSnapshot = repo.saveSnapshot;
  let writes = 0;
  repo.saveSnapshot = async (current, history) => {
    writes += 1;
    if (writes === 2) {
      dispatchCommitStarted();
      await pendingCommit;
    }
    await saveSnapshot(current, history);
  };
  const service = new DurableRolloutService(rollouts, repo);
  await service.initialize();
  await service.start('a'.repeat(16), { kind: 'all' }, 'console');
  await dispatchCommit;

  const cancellation = service.cancel('console');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rollouts.current()?.stage, 'stopped');
  finishDispatchCommit();
  await cancellation;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(events.includes('ota'), false);
  assert.equal(events.includes('image'), false);
  assert.equal(rollouts.current()?.nodes[0]?.state, 'skipped');
  assert.equal((await repo.current())?.stage, 'stopped');
  await service.dispose();
});

test('failed cancellation requeues an OTA whose dispatch commit was still pending', async () => {
  const events: string[] = [];
  let finishDispatchCommit: () => void = () => undefined;
  let dispatchCommitStarted: () => void = () => undefined;
  const pendingCommit = new Promise<void>((resolve) => { finishDispatchCommit = resolve; });
  const dispatchCommit = new Promise<void>((resolve) => { dispatchCommitStarted = resolve; });
  const rollouts = core(events);
  const repo = repository(events);
  const saveSnapshot = repo.saveSnapshot;
  let writes = 0;
  repo.saveSnapshot = async (current, history) => {
    writes += 1;
    if (writes === 2) {
      dispatchCommitStarted();
      await pendingCommit;
    }
    if (writes === 3) throw new Error('cancellation commit failed');
    await saveSnapshot(current, history);
  };
  const service = new DurableRolloutService(rollouts, repo);
  await service.initialize();
  await service.start('a'.repeat(16), { kind: 'all' }, 'console');
  await dispatchCommit;

  const cancellation = assert.rejects(service.cancel('console'), /cancellation was not committed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rollouts.current()?.stage, 'stopped');
  finishDispatchCommit();
  await cancellation;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(events.includes('dispatch'), false);
  assert.equal(rollouts.current()?.stage, 'pilot');
  assert.equal(rollouts.current()?.nodes[0]?.state, 'queued');
  assert.equal(rollouts.current()?.nodes[0]?.startedAt, null);
  await service.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === 'dispatch').length, 1, 'retry dispatches only after new durable commits');
  assert.equal(rollouts.current()?.nodes[0]?.state, 'sending');
  assert.equal((await repo.current())?.nodes[0]?.state, 'sending');
  await service.dispose();
});

test('failed cancellation never requeues or retries an OTA already dispatched', async () => {
  const events: string[] = [];
  let finishOta: () => void = () => undefined;
  const pendingOta = new Promise<void>((resolve) => { finishOta = resolve; });
  const rollouts = new Rollouts({
    image: () => image,
    nodes: () => [node],
    sendImageToGateway: () => true,
    sendOta: async () => { events.push('dispatch'); await pendingOta; },
    directPort: 8090,
    now: () => 100,
  });
  const repo = repository(events);
  const saveSnapshot = repo.saveSnapshot;
  let writes = 0;
  repo.saveSnapshot = async (current, history) => {
    writes += 1;
    if (writes === 3) throw new Error('cancellation commit failed');
    await saveSnapshot(current, history);
  };
  const service = new DurableRolloutService(rollouts, repo);
  await service.initialize();
  await service.start('a'.repeat(16), { kind: 'all' }, 'console');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === 'dispatch').length, 1);

  await assert.rejects(service.cancel('console'), /cancellation was not committed/);
  assert.equal(rollouts.current()?.stage, 'pilot');
  assert.equal(rollouts.current()?.nodes[0]?.state, 'sending');
  assert.equal(rollouts.current()?.nodes[0]?.startedAt, 100);
  await service.tick();
  finishOta();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(events.filter((event) => event === 'dispatch').length, 1);
  rollouts.onOtaStatus('aa', { state: 'confirmed', percent: 100, error: '', image: 'a'.repeat(8) });
  assert.equal(rollouts.current()?.nodes[0]?.state, 'confirmed');
  await service.dispose();
});
