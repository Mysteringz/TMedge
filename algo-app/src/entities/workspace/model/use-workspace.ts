import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, WorkspaceRequestError } from '../api/workspace-api.ts';
import type { WorkspaceSnapshot } from './types.ts';

/** New mail is worth knowing about within half a minute; nothing here is worth a socket. */
const REFRESH_MS = 20_000;

export interface WorkspaceState {
  snapshot: WorkspaceSnapshot | null;
  /** No answer yet. Once there is a snapshot, a refresh happens behind it. */
  loading: boolean;
  /** Why what is on screen may be out of date; empty when it is current. */
  error: string;
  refresh(): void;
  /** Runs one write, then re-reads so the page shows what the server now holds. Rejects with the server's own words. */
  act<T>(work: () => Promise<T>): Promise<T>;
}

/** One request at a time; a hidden tab stops asking and picks up again when it is looked at. */
export function useWorkspace(user: string): WorkspaceState {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pollRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    let disposed = false, failures = 0, controller: AbortController | null = null, again = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null); setLoading(true); setError('');
    const poll = async (force = false): Promise<void> => {
      if (disposed || (document.hidden && !force)) return;
      // A write that lands while a read is in flight must not be shown the
      // answer from before it: ask once more when that read returns.
      if (controller) { again = again || force; return; }
      if (next) clearTimeout(next);
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort('timeout'), 10_000);
      try {
        const result = await workspaceApi.snapshot(request.signal);
        if (disposed) return;
        setSnapshot(result); setError(''); failures = 0;
      } catch (cause) {
        if (disposed) return;
        if (cause instanceof WorkspaceRequestError && cause.status === 401) { disposed = true; setSnapshot(null); return; }
        // What is on screen stays, labelled, instead of being replaced by an error.
        setError(cause instanceof WorkspaceRequestError && cause.code === 'STORAGE_UNAVAILABLE'
          ? 'Team storage is unavailable on the server. Messages, requests and tasks cannot be read or saved until it is repaired.'
          : 'The team workspace could not be refreshed. Showing what was last received.');
        failures++;
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!disposed) {
          setLoading(false);
          if (again) { again = false; void poll(true); }
          else next = setTimeout(() => void poll(), Math.min(120_000, REFRESH_MS * 2 ** Math.min(failures, 3)));
        }
      }
    };
    const visible = (): void => { if (document.hidden) { if (next) clearTimeout(next); } else void poll(); };
    pollRef.current = poll;
    document.addEventListener('visibilitychange', visible);
    void poll(true);
    return () => {
      disposed = true; controller?.abort();
      if (next) clearTimeout(next);
      document.removeEventListener('visibilitychange', visible);
      pollRef.current = async () => undefined;
    };
  }, [user]);

  const refresh = useCallback(() => { void pollRef.current(true); }, []);
  const act = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    // Refused or not, the page is re-read: a refusal usually means it was showing something stale.
    finally { void pollRef.current(true); }
  }, []);

  return { snapshot, loading, error, refresh, act };
}
