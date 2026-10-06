/**
 * Pushes occupancy snapshots to the web tier(s).
 *
 * Push, not pull: the edge sits on a campus network behind NAT, and the web
 * tier may be on EC2. An outbound HTTPS POST needs no inbound firewall hole
 * and no VPN. Several targets can be listed (e.g. a local web tier and the
 * cloud one); each is tried independently, so one being down does not stall
 * the others.
 *
 * Only the snapshot leaves: seat states and totals. That is the privacy
 * boundary -- see src/shared/types.ts.
 */
import type { OccupancySnapshot } from '../shared/types.js';
import { operationalLog } from '../shared/logging/operational-logger.js';

export interface PublishTarget {
  target: string;
  ok: boolean;
  lastOkAt: number | null;
  lastError: string | null;
}

export class Publisher {
  readonly status: PublishTarget[];
  private inFlight = new Set<string>();

  constructor(private readonly urls: string[], private readonly token: string) {
    this.status = urls.map((u) => ({ target: u, ok: false, lastOkAt: null, lastError: null }));
  }

  publish(snapshot: OccupancySnapshot): void {
    const body = JSON.stringify(snapshot);
    for (const st of this.status) {
      // Never queue behind a slow target: skip this round, the next snapshot supersedes it.
      if (this.inFlight.has(st.target)) continue;
      this.inFlight.add(st.target);
      fetch(new URL('/api/edge/snapshot', st.target), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body,
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      })
        .then(async (res) => {
          // Do not buffer an unbounded error body or expose its contents in the console.
          if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
          await res.body?.cancel();
          const recovered = !st.ok;
          st.ok = true;
          st.lastOkAt = Date.now();
          st.lastError = null;
          if (recovered) operationalLog('snapshot_publisher.state', { component: 'snapshot-publisher', outcome: 'recovered' });
        })
        .catch((err: unknown) => {
          const wasHealthy = st.ok;
          st.ok = false;
          st.lastError = err instanceof Error ? err.message : String(err);
          if (wasHealthy) operationalLog('snapshot_publisher.state', { component: 'snapshot-publisher', outcome: 'degraded' });
        })
        .finally(() => this.inFlight.delete(st.target));
    }
  }
}
