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
