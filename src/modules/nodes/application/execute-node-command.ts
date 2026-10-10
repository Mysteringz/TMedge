import { ApplicationError } from '../../shared/application/contracts.js';
import type { CommandReceipt } from '../domain/command-receipt.js';
import { ReceiptDispatchError } from './live-command-receipts.js';
import { CMD_IDENTIFY, CMD_REBOOT, CMD_RESET_BACKGROUND, CMD_SAVE_PARAMS, CMD_SET_PARAM, PARAM_LIMITS, PARAM_NAMES } from '../../../edge/protocol.js';

export type NodeCommand = { uid: string; opcode: number; argument: number; value: number };
export type NodeCommandDispatch = (command: NodeCommand, authorized?: () => boolean, issuer?: string) => Promise<void | CommandReceipt>;

/** Validates a console command and maps it to the existing node protocol. */
export class ExecuteNodeCommand {
  constructor(private readonly dispatch: NodeCommandDispatch) {}

  async execute(uid: string, input: unknown, context?: (() => boolean) | { authorized(): boolean; issuer: string }): Promise<void | CommandReceipt> {
    const command = makeCommand(uid, input);
    try {
      return await this.dispatch(command, typeof context === 'function' ? context : context?.authorized, typeof context === 'object' ? context.issuer : undefined);
    } catch (error: unknown) {
      if (error instanceof ReceiptDispatchError || error instanceof ApplicationError && error.kind === 'unavailable') throw error;
      throw new ApplicationError('conflict', error instanceof Error ? error.message : String(error));
    }
  }
}

function makeCommand(uid: string, input: unknown): NodeCommand {
  const body = toCommandBody(input);
  if (body.op === 'set') return makeSetCommand(uid, body);
  if (body.op === 'reset-bg') return { uid, opcode: CMD_RESET_BACKGROUND, argument: 0, value: 0 };
  if (body.op === 'identify') return { uid, opcode: CMD_IDENTIFY, argument: 0, value: typeof body.value === 'number' ? body.value : 10 };
  if (body.op === 'save') return { uid, opcode: CMD_SAVE_PARAMS, argument: 0, value: 0 };
  if (body.op === 'reboot') return { uid, opcode: CMD_REBOOT, argument: 0, value: 0 };
  throw new ApplicationError('validation', 'op must be set | reset-bg | identify | save | reboot');
}

function makeSetCommand(uid: string, body: CommandBody): NodeCommand {
  const parameter = PARAM_NAMES.find((name) => name === body.param);
  if (!parameter || typeof body.value !== 'number' || !Number.isInteger(body.value)) {
    throw new ApplicationError('validation', `set needs param (one of ${PARAM_NAMES.join(', ')}) and an integer value`);
  }
  const limits = PARAM_LIMITS[parameter];
  if (body.value < limits.lo || body.value > limits.hi) {
    throw new ApplicationError('validation', `the node only accepts ${parameter} between ${limits.lo} and ${limits.hi}; it would ignore ${body.value}`);
  }
  return { uid, opcode: CMD_SET_PARAM, argument: PARAM_NAMES.indexOf(parameter), value: body.value };
}

interface CommandBody {
  op?: unknown;
  param?: unknown;
  value?: unknown;
}

function toCommandBody(input: unknown): CommandBody {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  return input;
}
