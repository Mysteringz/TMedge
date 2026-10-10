import { useEffect, useRef, useState } from 'react';
import { AnalyticsAccessError, readAnalytics } from '../api/read-analytics.ts';
import type { AnalyticsSnapshot, RangeId } from './types.ts';

/** How often each range is worth asking again: the hour view moves every ten seconds, the month view barely at all. */
const REFRESH_MS: Record<RangeId, number> = { '1h': 10_000, '24h': 30_000, '7d': 60_000, '30d': 120_000 };

export interface AnalyticsState {
  snapshot: AnalyticsSnapshot | null;
  /** A request is in flight. With a snapshot on screen the charts hold their last render, dimmed. */
  loading: boolean;
  error: string;
  /** The snapshot on screen is for a different range than the one now selected. */
  pending: boolean;
  now: number;
  refresh(): void;
}

/** One request at a time; a hidden tab stops asking and picks up again when it is looked at. */
export function useAnalytics(range: RangeId): AnalyticsState {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false, failures = 0, controller: AbortController | null = null;
    let next: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (disposed || document.hidden || controller) return;
      if (next) clearTimeout(next);
      const request = new AbortController();
      controller = request;
      setLoading(true);
      const timeout = setTimeout(() => request.abort('timeout'), 12_000);
      try {
        const result = await readAnalytics(range, request.signal);
        if (disposed) return;
        setSnapshot(result); setError(''); failures = 0;
      } catch (cause) {
        if (disposed || document.hidden) return;
        if (cause instanceof AnalyticsAccessError) { disposed = true; setSnapshot(null); }
        // What is on screen stays; it is labelled with its age, not replaced by an error page.
        setError('Analytics could not be refreshed. Showing the last data received.');
        failures++;
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!disposed) { setLoading(false); next = setTimeout(() => void poll(), Math.min(120_000, REFRESH_MS[range] * 2 ** Math.min(failures, 3))); }
      }
    };
    const visible = (): void => {
      if (document.hidden) { controller?.abort(); if (next) clearTimeout(next); } else void poll();
    };
    refreshRef.current = () => void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', visible);
    void poll();
    return () => {
      disposed = true; controller?.abort();
      if (next) clearTimeout(next);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', visible);
      refreshRef.current = () => undefined;
    };
  }, [range]);

  return { snapshot, loading, error, now, pending: !!snapshot && snapshot.range.id !== range, refresh: () => refreshRef.current() };
}
