import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecuteNodeCommand } from '../src/modules/nodes/application/execute-node-command.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import { CMD_IDENTIFY, CMD_REBOOT, CMD_RESET_BACKGROUND, CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_NAMES } from '../src/edge/protocol.js';

test('node command use case preserves supported operations and protocol arguments', async () => {
  const sent: { uid: string; opcode: number; argument: number; value: number }[] = [];
  const useCase = new ExecuteNodeCommand(async (command) => { sent.push(command); });
  await useCase.execute('node-a', { op: 'set', param: PARAM_NAMES[0], value: 10 });
  await useCase.execute('node-a', { op: 'reset-bg' });
  await useCase.execute('node-a', { op: 'identify' });
  await useCase.execute('node-a', { op: 'save' });
  await useCase.execute('node-a', { op: 'reboot' });
  assert.deepEqual(sent.map((command) => command.opcode), [CMD_SET_PARAM, CMD_RESET_BACKGROUND, CMD_IDENTIFY, CMD_SAVE_PARAMS, CMD_REBOOT]);
  assert.equal(sent[0]?.argument, 0);
  assert.equal(sent[2]?.value, 10);
});

test('node command use case rejects bad input before dispatch', async () => {
  let dispatched = false;
  const useCase = new ExecuteNodeCommand(async () => { dispatched = true; });
  await assert.rejects(useCase.execute('node-a', { op: 'set', param: 'unknown', value: 1 }),
    (error: unknown) => error instanceof ApplicationError && error.kind === 'validation');
  await assert.rejects(useCase.execute('node-a', { op: 'set', param: PARAM_NAMES[0], value: 100_000 }),
    (error: unknown) => error instanceof ApplicationError && error.kind === 'validation');
  assert.equal(dispatched, false);
});

test('node dispatch failures map to a conflict without changing sent acknowledgment semantics', async () => {
  const useCase = new ExecuteNodeCommand(async () => { throw new Error('node is offline'); });
  await assert.rejects(useCase.execute('node-a', { op: 'reboot' }),
    (error: unknown) => error instanceof ApplicationError && error.kind === 'conflict' && error.message === 'node is offline');
});
