import { randomUUID } from 'node:crypto';
import type { CommandReceipt, ReceiptState } from '../domain/command-receipt.js';
import type { NodeCommand } from './execute-node-command.js';
import { ApplicationError } from '../../shared/application/contracts.js';

interface StoredReceipt { receipt: CommandReceipt; issuer: string; generation: number }
interface Observation { sequence: number; boot: number | null; generation: number; at: number }
interface ReceiptDependencies {
  dispatch(command: NodeCommand, authorized: () => boolean): Promise<number>;
  boot(uid: string): number | null;
  now?: () => number;
  dispatchTimeoutMs?: number;
}
const TERMINAL = new Set<ReceiptState>(['acknowledged', 'timed-out', 'uncertain', 'failed']);
const MAX_RECEIPTS = 512;
const RECEIPT_TTL_MS = 15 * 60_000;
const ACK_TIMEOUT_MS = 60_000;

export class ReceiptDispatchError extends ApplicationError {
  constructor(readonly receipt: CommandReceipt, kind: 'conflict' | 'unavailable' = 'conflict') { super(kind, receipt.message); }
}

/** Bounded issuer-private live observations; dispatch is never replayed. */
export class LiveCommandReceipts {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly observations = new Map<string, Observation>();
  private generation = 0;
  private readonly dispatching = new Set<string>();
  private stopped = false;
  constructor(private readonly deps: ReceiptDependencies) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  async send(command: NodeCommand, context: { issuer: string; authorized(): boolean }): Promise<CommandReceipt> {
    this.sweep(); this.reserve();
    const receipt: CommandReceipt = { id: randomUUID(), uid: command.uid, operation: operation(command.opcode),
      sequence: null, boot: this.deps.boot(command.uid), state: 'requested', requestedAt: this.now(), updatedAt: this.now(), message: 'Requested.' };
    const stored = { receipt, issuer: context.issuer, generation: this.generation }; this.receipts.set(receipt.id, stored);
    try {
      if (!context.authorized()) { this.update(stored, 'failed', 'Access changed; no command was sent.'); throw new ReceiptDispatchError({ ...receipt }); }
      const sequence = await this.dispatchBounded(command, context, stored);
      if (sequence === null) return { ...receipt };
      receipt.sequence = sequence;
      if (TERMINAL.has(receipt.state)) return { ...receipt };
      if (this.stopped) { this.update(stored, 'uncertain', 'Service stopped; command outcome is uncertain.'); return { ...receipt }; }
      this.update(stored, 'sent', 'Sent — waiting for device.');
      const observed = this.observations.get(command.uid);
      if (observed) this.correlate(stored, observed);
      return { ...receipt };
    } catch (error) {
      if (!(error instanceof ReceiptDispatchError)) this.update(stored, 'uncertain', 'Delivery could not be confirmed. Check device state before sending again.');
      throw new ReceiptDispatchError({ ...receipt }, error instanceof ApplicationError && error.kind === 'unavailable' ? 'unavailable' : 'conflict');
    }
  }

  private async dispatchBounded(command: NodeCommand, context: { authorized(): boolean }, stored: StoredReceipt): Promise<number | null> {
    const id = stored.receipt.id; this.dispatching.add(id); let timer: ReturnType<typeof setTimeout> | undefined;
    const dispatch = Promise.resolve().then(() => this.deps.dispatch(command, context.authorized)).then(
      (sequence) => { this.dispatching.delete(id); return sequence; },
      (error: unknown) => { this.dispatching.delete(id); throw error; },
    );
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => {
      this.update(stored, 'uncertain', 'Dispatch status timed out. Check device state before sending again.'); resolve(null);
    }, this.deps.dispatchTimeoutMs ?? ACK_TIMEOUT_MS); });
    try { return await Promise.race([dispatch, timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  get(issuer: string, uid: string, id: string): CommandReceipt | null {
    this.sweep(); const stored = this.receipts.get(id);
    return stored?.issuer === issuer && stored.receipt.uid === uid ? { ...stored.receipt } : null;
  }

  observeStatus(input: { uid: string; sequence: number; boot: number | null; at: number }): void {
    this.sweep();
    if (this.observations.size >= MAX_RECEIPTS) this.observations.delete(this.observations.keys().next().value ?? '');
    const observation = { sequence: input.sequence, boot: input.boot, at: input.at, generation: ++this.generation };
    this.observations.set(input.uid, observation);
    for (const stored of this.receipts.values()) if (stored.receipt.uid === input.uid) this.correlate(stored, observation);
  }

  dispose(): void {
    this.stopped = true;
    for (const stored of this.receipts.values()) if (!TERMINAL.has(stored.receipt.state)) this.update(stored, 'uncertain', 'Service stopped; command outcome is uncertain.');
    this.observations.clear();
  }

  private correlate(stored: StoredReceipt, observation: Observation): void {
    const receipt = stored.receipt;
    if (receipt.state !== 'sent' || observation.generation <= stored.generation || observation.at < receipt.requestedAt) return;
    if (receipt.boot !== null && observation.boot !== receipt.boot) { this.update(stored, 'uncertain', 'Device restarted; check device state before sending again.'); return; }
    if (observation.sequence === receipt.sequence) this.update(stored, 'acknowledged', 'Device acknowledged. Acknowledgement does not confirm execution or persistence.');
  }
  private update(stored: StoredReceipt, state: ReceiptState, message: string): void {
    stored.receipt.state = state; stored.receipt.message = message; stored.receipt.updatedAt = this.now();
  }
  private sweep(): void {
    const now = this.now();
    for (const [id, stored] of this.receipts) {
      if (TERMINAL.has(stored.receipt.state) && now - stored.receipt.updatedAt >= RECEIPT_TTL_MS) this.receipts.delete(id);
      else if (stored.receipt.state === 'requested' && now - stored.receipt.requestedAt >= ACK_TIMEOUT_MS) this.update(stored, 'uncertain', 'Dispatch status timed out. Check device state before sending again.');
      else if (stored.receipt.state === 'sent' && now - stored.receipt.updatedAt >= ACK_TIMEOUT_MS) this.update(stored, 'timed-out', 'Outcome uncertain: device acknowledgement timed out. Check device state before sending again.');
    }
  }
  private reserve(): void {
    if (this.stopped) throw new ApplicationError('unavailable', 'Command status service is stopping.');
    if (this.dispatching.size >= MAX_RECEIPTS) throw new ApplicationError('unavailable', 'Too many outstanding dispatches; wait before sending again.');
    if (this.receipts.size < MAX_RECEIPTS) return;
    for (const [id, stored] of this.receipts) if (TERMINAL.has(stored.receipt.state)) { this.receipts.delete(id); return; }
    throw new ApplicationError('unavailable', 'Too many pending commands; wait for their status before sending again.');
  }
}
function operation(opcode: number): string { return ({ 1: 'Set parameter', 2: 'Relearn background', 3: 'Identify', 4: 'Reboot', 5: 'Save parameters' } as Record<number, string>)[opcode] ?? 'Device command'; }
