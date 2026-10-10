/**
 * Gauges over time at three resolutions: ten seconds for the last hour, a
 * minute for the last day, fifteen minutes for the last month.
 *
 * Each sample lands in all three at once, so the month view is not computed
 * from a month of ten-second points and nothing has to be re-read to draw it.
 * A bucket nothing was measured in stays empty and is returned as `null`:
 * a sensor that went quiet, a web tier that was down or an edge that was not
 * running must show as a gap, never as a line along zero.
 */
import type { GaugeTierId, SeriesFrame } from '../../../shared/analytics.js';
import type { BucketLog, LogPeriod } from '../../../infrastructure/analytics/bucket-log.js';

interface TierSpec { id: GaugeTierId; stepMs: number; capacity: number; period: LogPeriod | null }

const TIERS: readonly TierSpec[] = [
  // 70 minutes: the hour view plus slack for a slow sampler.
  { id: 'raw', stepMs: 10_000, capacity: 420, period: null },
  // 26 hours on disk as one file per day.
  { id: 'minute', stepMs: 60_000, capacity: 1560, period: 'day' },
  // 32 days on disk as one file per month.
  { id: 'quarter', stepMs: 900_000, capacity: 3072, period: 'month' },
];

type Stat = [avg: number, max: number];
type PersistedBucket = Record<string, Stat>;
interface Accumulator { index: number; sum: Map<string, number>; count: Map<string, number>; max: Map<string, number> }
interface PersistedState { index: number; metrics: Record<string, [sum: number, count: number, max: number]> }

class Tier {
  /** Which bucket each slot currently holds; a slot whose stamp differs is empty for the bucket asked about. */
  private readonly stamps: Float64Array;
  private readonly avg = new Map<string, Float32Array>();
  private readonly max = new Map<string, Float32Array>();
  acc: Accumulator = { index: -1, sum: new Map(), count: new Map(), max: new Map() };
  earliest: number | null = null;

  constructor(readonly spec: TierSpec) {
    this.stamps = new Float64Array(spec.capacity).fill(-1);
  }

  private column(map: Map<string, Float32Array>, metric: string): Float32Array {
    let c = map.get(metric);
    if (!c) { c = new Float32Array(this.spec.capacity).fill(NaN); map.set(metric, c); }
    return c;
  }

  private claim(index: number): number {
    const slot = index % this.spec.capacity;
    if (this.stamps[slot] !== index) {
      this.stamps[slot] = index;
      for (const c of this.avg.values()) c[slot] = NaN;
      for (const c of this.max.values()) c[slot] = NaN;
    }
    return slot;
  }

  put(index: number, metric: string, avg: number, max: number): void {
    const slot = this.claim(index);
    this.column(this.avg, metric)[slot] = avg;
    this.column(this.max, metric)[slot] = max;
    const at = index * this.spec.stepMs;
    if (this.earliest === null || at < this.earliest) this.earliest = at;
  }

  read(index: number, metric: string): Stat | null {
    const slot = index % this.spec.capacity;
    if (index < 0 || this.stamps[slot] !== index) return null;
    const avg = this.avg.get(metric)?.[slot];
    const max = this.max.get(metric)?.[slot];
    return avg === undefined || max === undefined || Number.isNaN(avg) ? null : [avg, max];
  }

  /** Reads many buckets of one metric without looking its columns up each time. */
  reader(metric: string): (index: number) => Stat | null {
    const avg = this.avg.get(metric), max = this.max.get(metric);
    if (!avg || !max) return () => null;
    const { stamps } = this, capacity = this.spec.capacity;
    return (index) => {
      const slot = index % capacity;
      if (index < 0 || stamps[slot] !== index) return null;
      const a = avg[slot];
      return a === undefined || Number.isNaN(a) ? null : [a, max[slot] ?? a];
    };
  }

  finished(index: number): PersistedBucket {
    const out: PersistedBucket = {};
    for (const metric of this.avg.keys()) {
      const stat = this.read(index, metric);
      if (stat) out[metric] = [round(stat[0]), round(stat[1])];
    }
    return out;
  }
}

/** Four significant figures: plenty for a chart, a third of the bytes on disk. */
function round(value: number): number {
  return Number(value.toPrecision(4));
}

export class MetricHistory {
  private readonly tiers = new Map<GaugeTierId, Tier>(TIERS.map((spec) => [spec.id, new Tier(spec)]));
  private lastPruneDay = '';

  constructor(private readonly name: string, private readonly log: BucketLog, now: number = Date.now()) {
    for (const tier of this.tiers.values()) {
      const { spec } = tier;
      if (!spec.period) continue;
      for (const line of log.load<PersistedBucket>(`${name}-${spec.id}`, now - spec.capacity * spec.stepMs)) {
        const index = Math.floor(line.t / spec.stepMs);
        for (const [metric, stat] of Object.entries(line.v)) {
          if (Array.isArray(stat) && Number.isFinite(stat[0]) && Number.isFinite(stat[1])) tier.put(index, metric, stat[0], stat[1]);
        }
      }
      // The bucket that was in progress at the last shutdown: carry on from it
      // if it is still the current one, otherwise it is simply finished.
      const state = log.takeState<PersistedState>(`${name}-${spec.id}`);
      if (state && Number.isSafeInteger(state.index) && state.index > Math.floor(now / spec.stepMs) - spec.capacity && state.metrics) {
        tier.acc.index = state.index;
        for (const [metric, value] of Object.entries(state.metrics)) {
          if (!Array.isArray(value) || !value.every(Number.isFinite) || value[1] <= 0) continue;
          tier.acc.sum.set(metric, value[0]); tier.acc.count.set(metric, value[1]); tier.acc.max.set(metric, value[2]);
          tier.put(state.index, metric, value[0] / value[1], value[2]);
        }
      }
    }
  }

  /** The oldest moment anything is retained for: what a chart may honestly claim to cover. */
  get earliest(): number | null {
    let out: number | null = null;
    for (const tier of this.tiers.values()) if (tier.earliest !== null && (out === null || tier.earliest < out)) out = tier.earliest;
    return out;
  }

  /** One sample. Missing and non-finite values are skipped, which is how a gap is recorded. */
  record(at: number, values: Record<string, number | null | undefined>): void {
    for (const tier of this.tiers.values()) {
      const { spec, acc } = tier;
      const index = Math.floor(at / spec.stepMs);
      if (index < acc.index) continue;
      if (index !== acc.index) {
        this.finish(tier);
        acc.index = index;
        acc.sum.clear(); acc.count.clear(); acc.max.clear();
      }
      for (const [metric, value] of Object.entries(values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const sum = (acc.sum.get(metric) ?? 0) + value;
        const count = (acc.count.get(metric) ?? 0) + 1;
        const max = Math.max(acc.max.get(metric) ?? -Infinity, value);
        acc.sum.set(metric, sum); acc.count.set(metric, count); acc.max.set(metric, max);
        // Written through, so the bucket in progress is already on the chart.
        tier.put(index, metric, sum / count, max);
      }
    }
    const day = new Date(at).toISOString().slice(0, 10);
    if (day !== this.lastPruneDay) { this.lastPruneDay = day; this.prune(at); }
  }

  private finish(tier: Tier): void {
    const { spec, acc } = tier;
    if (acc.index < 0 || !spec.period || acc.count.size === 0) return;
    this.log.append(`${this.name}-${spec.id}`, spec.period, { t: acc.index * spec.stepMs, v: tier.finished(acc.index) });
  }

  private prune(now: number): void {
    for (const { spec } of this.tiers.values()) {
      if (spec.period) this.log.prune(`${this.name}-${spec.id}`, spec.period, now - spec.capacity * spec.stepMs);
    }
  }

  /**
   * `metrics` over [from, to) on `stepMs`, read from `tierId` and combined when
   * the step is coarser than the tier: the mean of the means that exist, and
   * the highest maximum. A step with nothing in it is `null`.
   */
  frame(tierId: GaugeTierId, from: number, to: number, stepMs: number, metrics: { key: string; label: string; stat?: 'avg' | 'max' }[]): SeriesFrame {
    const tier = this.tiers.get(tierId);
    if (!tier) throw new Error(`unknown tier ${tierId}`);
    const step = Math.max(stepMs, tier.spec.stepMs);
    const per = Math.max(1, Math.round(step / tier.spec.stepMs));
    const first = Math.floor(from / step) * step;
    const times: number[] = [];
    for (let t = first; t < to; t += step) times.push(t);
    const series = metrics.map(({ key, label, stat }) => {
      const read = tier.reader(key);
      return {
        key, label,
        values: times.map((t) => {
          const start = Math.floor(t / tier.spec.stepMs);
          let sum = 0, n = 0, max = -Infinity;
          for (let i = 0; i < per; i++) {
            const value = read(start + i);
            if (!value) continue;
            sum += value[0]; n += 1; max = Math.max(max, value[1]);
          }
          return n === 0 ? null : round(stat === 'max' ? max : sum / n);
        }),
      };
    });
    return { times, stepMs: step, series };
  }

  /** The newest finished-or-current value of one metric, or null if the last few steps are empty. */
  latest(metric: string, now: number, withinSteps = 3): number | null {
    const tier = this.tiers.get('raw');
    if (!tier) return null;
    const index = Math.floor(now / tier.spec.stepMs);
    for (let i = 0; i <= withinSteps; i++) {
      const value = tier.read(index - i, metric);
      if (value) return value[0];
    }
    return null;
  }

  /** Every bucket of the coarse tier in [from, to): for per-day and hour-of-week summaries. */
  quarters(metric: string, from: number, to: number): { at: number; avg: number; max: number }[] {
    const tier = this.tiers.get('quarter');
    if (!tier) return [];
    const out: { at: number; avg: number; max: number }[] = [];
    const read = tier.reader(metric);
    for (let index = Math.floor(from / tier.spec.stepMs); index * tier.spec.stepMs < to; index++) {
      const value = read(index);
      if (value) out.push({ at: index * tier.spec.stepMs, avg: value[0], max: value[1] });
    }
    return out;
  }

  /** Keep the buckets in progress, so stopping for a deploy does not cut a notch in every chart. */
  close(): Promise<void> {
    for (const tier of this.tiers.values()) {
      const { spec, acc } = tier;
      if (!spec.period || acc.index < 0) continue;
      const metrics: PersistedState['metrics'] = {};
      for (const [metric, count] of acc.count) metrics[metric] = [acc.sum.get(metric) ?? 0, count, acc.max.get(metric) ?? 0];
      this.log.writeState(`${this.name}-${spec.id}`, { index: acc.index, metrics } satisfies PersistedState);
    }
    return this.log.flush();
  }
}
