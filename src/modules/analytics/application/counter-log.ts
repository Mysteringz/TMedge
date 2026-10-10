/**
 * Counts of things that happened, by name, in five-minute and hourly buckets.
 *
 * Unlike a gauge, a bucket with no entry really is zero: nobody searched in
 * that hour. What is *not* known is anything before `earliest`, and callers
 * say so rather than drawing a flat line back to the start of the chart.
 */
import { dayKey, type CounterFrame, type CounterTierId } from '../../../shared/analytics.js';
import type { BucketLog, LogPeriod } from '../../../infrastructure/analytics/bucket-log.js';

interface TierSpec { id: CounterTierId; stepMs: number; capacity: number; period: LogPeriod }

const TIERS: readonly TierSpec[] = [
  { id: 'fine', stepMs: 300_000, capacity: 576, period: 'day' },      // 48 hours
  { id: 'hour', stepMs: 3_600_000, capacity: 24 * 35, period: 'month' }, // 35 days
];

/**
 * Names are built from floor and table IDs. Those are checked against the
 * live campus before they get here, but a counter store must not be the place
 * an unexpected flood of distinct names turns into unbounded memory.
 */
const MAX_KEYS_PER_BUCKET = 512;
const OVERFLOW_KEY = 'other';

type Counts = Record<string, number>;
interface PersistedState { fine: { t: number; v: Counts } | null; hour: { t: number; v: Counts } | null }

class Tier {
  readonly buckets = new Map<number, Map<string, number>>();
  current = -1;
  earliest: number | null = null;
  constructor(readonly spec: TierSpec) {}

  set(at: number, counts: Counts): void {
    const bucket = new Map<string, number>();
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && bucket.size < MAX_KEYS_PER_BUCKET) bucket.set(key, value);
    }
    this.buckets.set(at, bucket);
    if (this.earliest === null || at < this.earliest) this.earliest = at;
  }
}

export class CounterLog {
  private readonly tiers = new Map<CounterTierId, Tier>(TIERS.map((spec) => [spec.id, new Tier(spec)]));
  private dirty = false;
  private lastSave = 0;
  private lastPruneDay = '';

  constructor(private readonly name: string, private readonly log: BucketLog, now: number = Date.now()) {
    const state = log.takeState<PersistedState>(`${name}-counters`);
    for (const tier of this.tiers.values()) {
      const { spec } = tier;
      for (const line of log.load<Counts>(`${name}-${spec.id}`, now - spec.capacity * spec.stepMs)) {
        if (line.v && typeof line.v === 'object') tier.set(Math.floor(line.t / spec.stepMs) * spec.stepMs, line.v);
      }
      const open = state?.[spec.id];
      // A bucket already on disk as finished wins over a saved partial copy of it.
      if (open && Number.isFinite(open.t) && open.t > now - spec.capacity * spec.stepMs && !tier.buckets.has(open.t) && open.v) {
        tier.set(open.t, open.v);
        tier.current = open.t;
      }
    }
  }

  get earliest(): number | null {
    return this.tiers.get('hour')?.earliest ?? null;
  }

  add(at: number, key: string, amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.roll(at);
    for (const tier of this.tiers.values()) {
      const start = Math.floor(at / tier.spec.stepMs) * tier.spec.stepMs;
      if (start < tier.current) continue;
      let bucket = tier.buckets.get(start);
      if (!bucket) {
        bucket = new Map();
        tier.buckets.set(start, bucket);
        if (tier.earliest === null || start < tier.earliest) tier.earliest = start;
      }
      // The last slot is kept for the overflow name, so the bound is exact.
      const name = bucket.has(key) || bucket.size < MAX_KEYS_PER_BUCKET - 1 ? key : OVERFLOW_KEY;
      bucket.set(name, (bucket.get(name) ?? 0) + amount);
    }
    this.dirty = true;
  }

  /** Call on a timer: finishes buckets time has moved past and keeps the open ones safe on disk. */
  tick(now: number): void {
    this.roll(now);
    if (this.dirty && now - this.lastSave >= 60_000) this.save(now);
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.lastPruneDay) {
      this.lastPruneDay = day;
      for (const { spec } of this.tiers.values()) this.log.prune(`${this.name}-${spec.id}`, spec.period, now - spec.capacity * spec.stepMs);
    }
  }

  private roll(now: number): void {
    let rolled = false;
    for (const tier of this.tiers.values()) {
      const { spec } = tier;
      const start = Math.floor(now / spec.stepMs) * spec.stepMs;
      if (start <= tier.current) continue;
      const finished = tier.buckets.get(tier.current);
      if (tier.current >= 0 && finished && finished.size > 0) {
        this.log.append(`${this.name}-${spec.id}`, spec.period, { t: tier.current, v: Object.fromEntries(finished) });
      }
      tier.current = start;
      const oldest = start - spec.capacity * spec.stepMs;
      for (const at of tier.buckets.keys()) if (at < oldest) tier.buckets.delete(at);
      rolled = true;
    }
    // Straight away, so a crash cannot leave a saved partial of a bucket that
    // has just been written out in full.
    if (rolled) this.save(now);
  }

  private save(now: number): void {
    const open = (id: CounterTierId) => {
      const tier = this.tiers.get(id);
      const bucket = tier ? tier.buckets.get(tier.current) : undefined;
      return tier && bucket && bucket.size > 0 ? { t: tier.current, v: Object.fromEntries(bucket) } : null;
    };
    this.log.writeState(`${this.name}-counters`, { fine: open('fine'), hour: open('hour') } satisfies PersistedState);
    this.dirty = false;
    this.lastSave = now;
  }

  /** How many of `key` in [from, to). */
  sum(tierId: CounterTierId, from: number, to: number, key: string): number {
    let total = 0;
    for (const [at, bucket] of this.tiers.get(tierId)?.buckets ?? []) if (at >= from && at < to) total += bucket.get(key) ?? 0;
    return total;
  }

  /** Totals of every key that starts with `prefix`, by what follows it. */
  sumByPrefix(tierId: CounterTierId, from: number, to: number, prefix: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [at, bucket] of this.tiers.get(tierId)?.buckets ?? []) {
      if (at < from || at >= to) continue;
      for (const [key, value] of bucket) if (key.startsWith(prefix)) out.set(key.slice(prefix.length), (out.get(key.slice(prefix.length)) ?? 0) + value);
    }
    return out;
  }

  /** `keys` summed onto a fixed step from the tier's own buckets. */
  frame(tierId: CounterTierId, from: number, to: number, stepMs: number, keys: { key: string; label: string }[]): CounterFrame {
    const tier = this.tiers.get(tierId);
    if (!tier) throw new Error(`unknown tier ${tierId}`);
    const step = Math.max(stepMs, tier.spec.stepMs);
    const first = Math.floor(from / step) * step;
    const times: number[] = [];
    for (let t = first; t < to; t += step) times.push(t);
    return {
      times, stepMs: step, daily: false,
      series: keys.map(({ key, label }) => ({ key, label, values: times.map((t) => this.sum(tierId, t, t + step, key)) })),
    };
  }

  /** `keys` per site-local day, for the days that overlap [from, to). */
  daily(from: number, to: number, timeZone: string, keys: { key: string; label: string }[]): CounterFrame {
    const tier = this.tiers.get('hour');
    const days = new Map<string, { at: number; counts: Map<string, number> }>();
    // Walk the hours so empty days still get a row.
    for (let t = Math.floor(from / 3_600_000) * 3_600_000; t < to; t += 3_600_000) {
      const day = dayKey(t, timeZone);
      let entry = days.get(day);
      if (!entry) { entry = { at: t, counts: new Map() }; days.set(day, entry); }
      const bucket = tier?.buckets.get(t);
      if (bucket) for (const { key } of keys) entry.counts.set(key, (entry.counts.get(key) ?? 0) + (bucket.get(key) ?? 0));
    }
    const rows = [...days.values()];
    return {
      times: rows.map((row) => row.at), stepMs: 86_400_000, daily: true,
      series: keys.map(({ key, label }) => ({ key, label, values: rows.map((row) => row.counts.get(key) ?? 0) })),
    };
  }

  close(now: number = Date.now()): Promise<void> {
    this.save(now);
    return this.log.flush();
  }
}
