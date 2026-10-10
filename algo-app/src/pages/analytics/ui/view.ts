import type { AnalyticsSnapshot, CounterFrame, RangeId, SeriesFrame } from '../../../entities/analytics/index.ts';

export interface ViewProps {
  snapshot: AnalyticsSnapshot;
  range: RangeId;
  /** A different range is on its way: charts hold their last render, dimmed. */
  loading: boolean;
  now: number;
}

/**
 * Counts as a line chart's series. Zero is a real count -- but only from the
 * moment counting began; steps wholly before that become gaps.
 */
export function counted(frame: CounterFrame, knownFrom: number | null): SeriesFrame {
  const step = frame.daily ? 86_400_000 : frame.stepMs;
  return {
    times: frame.times, stepMs: frame.stepMs,
    series: frame.series.map((s) => ({ ...s, values: s.values.map((v, i) => (knownFrom === null || (frame.times[i] ?? 0) + step <= knownFrom ? null : v)) })),
  };
}
