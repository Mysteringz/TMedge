/**
 * One background action (submit, refresh, cancel) and the events it emits,
 * which the browser follows over Server-Sent Events (HANDOVER.md §7.1).
 * Events carry steps and outcomes, never anything a person typed.
 */
import { randomBytes } from 'node:crypto';

export interface OpEvent { seq: number; type: string; at: number; data: Record<string, unknown> }

export class Op {
  readonly id = randomBytes(12).toString('base64url');
  readonly events: OpEvent[] = [];
  done = false;
  finishedAt = 0;
  private listeners = new Set<(e: OpEvent) => void>();

  constructor(readonly user: string, readonly jobId: string | null, readonly action: string) {}

  emit(type: string, data: Record<string, unknown> = {}): void {
    if (this.done) return;
    const e = { seq: this.events.length + 1, type, at: Date.now(), data };
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }

  /** The last event: "done" or "error". */
  finish(type: 'done' | 'error', data: Record<string, unknown> = {}): void {
    this.emit(type, data);
    this.done = true;
    this.finishedAt = Date.now();
    this.listeners.clear();
  }

  subscribe(l: (e: OpEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export class Ops {
  private ops = new Map<string, Op>();

  create(user: string, jobId: string | null, action: string): Op {
    this.sweep();
    const op = new Op(user, jobId, action);
    this.ops.set(op.id, op);
    return op;
  }

  /** Someone else's operation is a 404, like their jobs. */
  get(user: string, id: string): Op | undefined {
    const op = this.ops.get(id);
    return op && op.user === user ? op : undefined;
  }

  running(user: string): Op | undefined {
    return [...this.ops.values()].find((o) => o.user === user && !o.done);
  }

  private sweep(): void {
    const old = Date.now() - 10 * 60_000;
    for (const [id, op] of this.ops) if (op.done && op.finishedAt < old) this.ops.delete(id);
  }
}
