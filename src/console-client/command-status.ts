import type { CommandReceipt } from '../modules/nodes/domain/command-receipt.js';

/** One selected receipt, one readonly poll; changing nodes never dispatches work. */
export class CommandStatus {
  private receipt: CommandReceipt | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private selected: string | null = null;
  private ended = false;
  private readonly visible = (): void => { if (document.hidden) this.cancel(); else void this.poll(); };
  constructor(private readonly output: HTMLElement) {
    output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite');
    document.addEventListener('visibilitychange', this.visible);
  }
  select(uid: string | null): void {
    this.cancel(); this.selected = uid;
    if (this.receipt?.uid !== uid) { this.receipt = null; this.output.textContent = 'No recent command.'; }
    else { this.render(); void this.poll(); }
  }
  show(receipt: CommandReceipt): void { this.cancel(); this.receipt = receipt; this.render(); void this.poll(); }
  message(message: string): void { if (this.output.textContent !== message) this.output.textContent = message; }
  refresh(): void { void this.poll(); }
  dispose(): void { this.ended = true; this.cancel(); document.removeEventListener('visibilitychange', this.visible); }
  private cancel(): void { if (this.timer) clearTimeout(this.timer); this.controller?.abort(); }
  private render(): void {
    const receipt = this.receipt; if (!receipt || receipt.uid !== this.selected) return;
    const value = `${receipt.uid} · ${receipt.operation} · sequence ${receipt.sequence ?? 'unavailable'} · ${receipt.message} Updated ${new Date(receipt.updatedAt).toLocaleTimeString()}`;
    if (this.output.textContent !== value) this.output.textContent = value;
  }
  private async poll(): Promise<void> {
    const receipt = this.receipt;
    if (this.ended || document.hidden || this.controller || !receipt || receipt.uid !== this.selected) return;
    if (this.timer) clearTimeout(this.timer);
    const request = new AbortController(); this.controller = request;
    const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const response = await fetch(`api/nodes/${encodeURIComponent(receipt.uid)}/commands/${encodeURIComponent(receipt.id)}`, { signal: request.signal });
      if (request.signal.aborted || receipt !== this.receipt) return;
      if (response.status === 404) { this.receipt = null; this.message('Command status is no longer available. Outcome uncertain; check device state before sending again.'); return; }
      if (response.status === 401 || response.status === 403) { this.receipt = null; this.message('Command status access changed.'); return; }
      if (!response.ok) throw new Error('status unavailable');
      const body = await response.json() as { data: CommandReceipt }; this.receipt = body.data; this.render();
    } catch { if (!request.signal.aborted) this.message('Status unavailable. Outcome uncertain; check device state before sending again.'); }
    finally { clearTimeout(timeout); this.controller = null; if (!this.ended && !document.hidden && this.receipt) this.timer = setTimeout(() => void this.poll(), 5000); }
  }
}
