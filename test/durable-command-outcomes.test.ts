import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurableCommandOutcomes } from '../src/modules/nodes/application/durable-command-outcomes.js';
import type { CommandOutcomeRepository } from '../src/modules/nodes/repositories/command-outcome-repository.js';

test('command intent commits before dispatch and STATUS.lastCmd becomes acknowledged', async () => {
  const events: string[] = [];
  const repository: CommandOutcomeRepository = {
    record: async ({ outcome }) => { events.push(outcome); },
    markInFlightUncertain: async () => {},
  };
  const service = new DurableCommandOutcomes(repository, async () => { events.push('dispatch'); return 41; }, () => 100);
  await service.initialize();
  await service.send({ uid: '00:01:02:03:04:05', opcode: 1, argument: 0, value: 0 }, { id: 'console', kind: 'console' });
  assert.deepEqual(events, ['requested', 'dispatch', 'sent']);
  service.observeStatus('00:01:02:03:04:05', 41);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['requested', 'dispatch', 'sent', 'acknowledged']);
  await service.dispose();
});

test('command persistence outage prevents transport dispatch', async () => {
  let dispatched = false;
  const repository: CommandOutcomeRepository = {
    record: async () => { throw new Error('database offline'); },
  };
  const service = new DurableCommandOutcomes(repository, async () => { dispatched = true; return 1; });
  await assert.rejects(
    service.send({ uid: '00:01:02:03:04:05', opcode: 1, argument: 0, value: 0 }, { id: 'console', kind: 'console' }),
    /persistence is unavailable/,
  );
  assert.equal(dispatched, false);
  await service.dispose();
});
