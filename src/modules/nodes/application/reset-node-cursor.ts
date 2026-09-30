export type CursorReset = (uid: string) => boolean;

/** Applies the existing per-node command-cursor reset through an injected port. */
export class ResetNodeCursor {
  constructor(private readonly reset: CursorReset) {}

  execute(uid: string): { reset: boolean } {
    return { reset: this.reset(uid) };
  }
}
