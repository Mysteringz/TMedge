import { ApplicationError } from '../../shared/application/contracts.js';

export type CursorReset = (uid: string) => boolean;

/** Applies the existing per-node command-cursor reset through an injected port. */
export class ResetNodeCursor {
  constructor(private readonly reset: CursorReset) {}

  execute(uid: string): { reset: boolean } {
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(uid)) {
      throw new ApplicationError('validation', 'uid must be a lowercase MAC address');
    }
    return { reset: this.reset(uid) };
  }
}
