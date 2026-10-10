import type { HealthSnapshot, HealthSource } from '../domain/operational-health.js';
import type { OperationalQueries } from '../repositories/operational-queries.js';

/** Isolates source failures and bounds slow queries without dispatching work. */
export class ReadOperationalHealth {
  private readonly inFlight = new Set<string>();
  constructor(private readonly queries: OperationalQueries, private readonly now: () => number = Date.now) {}

  async execute(owner: string): Promise<HealthSnapshot> {
    const now = this.now();
    const [sensors, training, firmware, parameters] = await Promise.all([
      this.source({ key: 'sensors', query: () => this.queries.sensors(now), staleAfterMs: 15_000 }),
      this.source({ key: `training:${owner}`, query: () => this.queries.training(owner), staleAfterMs: 60_000 }),
      this.source({ key: 'firmware', query: () => this.queries.firmware(), staleAfterMs: 15_000 }),
      this.source({ key: 'parameters', query: () => this.queries.parameters(), staleAfterMs: 15_000 }),
    ]);
    return { generatedAt: this.now(), sensors, training, firmware, parameters };
  }

  private async source<T>({ key, query, staleAfterMs }: { key: string; query: () => T | null | Promise<T | null>; staleAfterMs: number }): Promise<HealthSource<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.inFlight.has(key) || this.inFlight.size >= 128) return { state: 'unavailable', observedAt: null, staleAfterMs, data: null };
    this.inFlight.add(key);
    const observation = Promise.resolve().then(query).then(
      (data) => { this.inFlight.delete(key); return { data }; },
      (error: unknown) => { this.inFlight.delete(key); throw error; },
    );
    try {
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); });
      const result = await Promise.race([observation, timeout]);
      if (!result) return { state: 'unavailable', observedAt: null, staleAfterMs, data: null };
      return { state: result.data === null ? 'disabled' : 'available', observedAt: result.data === null ? null : this.now(), staleAfterMs, data: result.data };
    } catch {
      return { state: 'unavailable', observedAt: null, staleAfterMs, data: null };
    } finally { if (timer) clearTimeout(timer); }
  }
}
