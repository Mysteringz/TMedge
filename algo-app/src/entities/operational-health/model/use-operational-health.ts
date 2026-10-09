import { useEffect, useRef, useState } from 'react';
import { HealthAccessError, readHealth } from '../api/read-health.ts';
import type { HealthSnapshot } from './types.ts';

/** One bounded request at a time; hidden/unmounted pages abort their read. */
export function useOperationalHealth(user: string): {
  snapshot: HealthSnapshot | null; error: string; busy: boolean; stale: boolean; now: number; announcement: string; refresh(): void;
} {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [lastSuccess, setLastSuccess] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false, failures = 0, controller: AbortController | null = null;
    let previousIssues: number | null = null;
    let next: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null); setLastSuccess(0); setError(''); setAnnouncement('');
    const poll = async (manual = false): Promise<void> => {
      if (disposed || document.hidden || controller) return;
      if (next) clearTimeout(next);
      const request = new AbortController(); controller = request; setBusy(true);
      const timeout = setTimeout(() => request.abort('timeout'), 10_000);
      try {
        const result = await readHealth(request.signal);
        if (disposed || request.signal.aborted) return;
        setSnapshot(result); setLastSuccess(Date.now()); setError(''); failures = 0;
        const issues = (result.sensors.data?.offline ?? 0) + (result.sensors.data?.unknown ?? 0) + (result.training.data?.failed ?? 0)
          + (result.firmware.data?.rollout?.failed ?? 0) + (result.firmware.data?.rollout?.uncertain ?? 0);
        if (manual) setAnnouncement('System status refreshed.');
        else if (previousIssues !== null && issues > previousIssues) setAnnouncement(`System status changed: ${issues} issues need attention.`);
        previousIssues = issues;
      } catch (cause) {
        if (disposed || document.hidden) return;
        if (cause instanceof HealthAccessError) { setSnapshot(null); setLastSuccess(0); disposed = true; }
        setError('System status could not be refreshed.'); failures++;
        if (manual) setAnnouncement('Refresh failed. Last available data is retained.');
      } finally {
        clearTimeout(timeout); controller = null;
        if (!disposed) { setBusy(false); next = setTimeout(() => void poll(), Math.min(30_000, 5000 * 2 ** Math.min(failures, 3))); }
      }
    };
    const visible = (): void => { if (document.hidden) { controller?.abort(); if (next) clearTimeout(next); } else void poll(); };
    refreshRef.current = () => void poll(true);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', visible); void poll();
    return () => { disposed = true; controller?.abort(); if (next) clearTimeout(next); clearInterval(clock); document.removeEventListener('visibilitychange', visible); refreshRef.current = () => undefined; };
  }, [user]);
  return { snapshot, error, busy, now, announcement, stale: !!snapshot && now - lastSuccess > 15_000, refresh: () => refreshRef.current() };
}
