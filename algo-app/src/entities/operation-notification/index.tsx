import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { KINDS, WINDOW_MS, markNotificationsRead, mergeSeen, notificationStorageKey, pruneSeen, type NotificationItem, type NotificationSnapshot, type SeenNotification } from './model.ts';

interface Feed {
  items: NotificationItem[]; unread: number | null; open: boolean; loading: boolean; error: string; updatedAt: number | null; storageFailed: boolean; unavailable: boolean;
  sources: NotificationSnapshot['sources']; summaries: NotificationSnapshot['summaries']; omittedCount: number;
  toggle(): void; close(): void; retry(): void; markRead(ids: string[]): void; isRead(id: string): boolean;
}
const Context = createContext<Feed | null>(null);
export const useNotifications = (): Feed | null => useContext(Context);
interface FeedState { scope: string; snapshot: NotificationSnapshot | null; loading: boolean; error: string; entries: SeenNotification[]; storageFailed: boolean }

export function NotificationProvider({ owner, scope, announce, clearNotice, children }: { owner: string | null; scope: string; announce(message: string): void; clearNotice(): void; children: ReactNode }) {
  const [state, setState] = useState<FeedState>({ scope: '', snapshot: null, loading: false, error: '', entries: [], storageFailed: false });
  const [open, setOpen] = useState(false);
  const refreshRef = useRef<(() => Promise<void>) | null>(null), writeRef = useRef<((ids: string[]) => void) | null>(null);
  useEffect(() => {
    setOpen(false); refreshRef.current = null; writeRef.current = null;
    clearNotice();
    if (!owner) { setState({ scope, snapshot: null, loading: false, error: '', entries: [], storageFailed: false }); return; }
    const controller = new AbortController(), key = notificationStorageKey(owner);
    let alive = true, busy = false, entries: SeenNotification[] = [], storageFailed = false, snapshot: NotificationSnapshot | null = null;
    const baseline: Partial<Record<NotificationItem['kind'], boolean>> = {};
    const mountedIds = new Map<NotificationItem['kind'], Set<string>>();
    try { const raw = localStorage.getItem(key); if (raw && raw.length <= 100_000) { try { entries = pruneSeen(JSON.parse(raw), Date.now()); } catch { entries = []; } } } catch { storageFailed = true; }
    const persist = () => { try { localStorage.setItem(key, JSON.stringify(entries)); } catch { storageFailed = true; } };
    setState({ scope, snapshot: null, loading: true, error: '', entries, storageFailed });
    const refresh = async () => {
      if (!alive || busy || document.hidden) return;
      busy = true; setState((value) => value.scope === scope ? { ...value, loading: !snapshot, error: '' } : value);
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 10000);
      try {
        const response = await fetch('/api/admin/notifications', { signal: request.signal });
        if (response.status === 401 || response.status === 403) { window.dispatchEvent(new CustomEvent('admin-access-change', { detail: response.status })); throw new Error('Access changed.'); }
        if (!response.ok) throw new Error('Could not refresh notifications.');
        const body = await response.json() as { data: NotificationSnapshot };
        if (!alive || !body.data || !Array.isArray(body.data.items) || body.data.items.length > 100) return;
        const next = body.data;
        // Keep a failed source's last rows explicitly labelled as unavailable; forbidden rows are removed.
        next.items = [...next.items, ...(snapshot?.items.filter((item) => next.sources[item.kind] === 'unavailable' && (item.classification === 'active' || (item.occurredAt ?? entries.find((entry) => entry.id === item.id)?.at ?? 0) >= Date.now() - WINDOW_MS) && !next.items.some((row) => row.id === item.id)) ?? [])].slice(0, 100);
        const merged = mergeSeen(entries, next.items, Date.now(), new Set(KINDS.filter((kind) => next.sources[kind] === 'available'))); entries = merged.entries; persist();
        const fresh = merged.fresh.filter((item) => baseline[item.kind] && next.sources[item.kind] === 'available' && !mountedIds.get(item.kind)?.has(item.id));
        if (fresh.length) announce(fresh.length === 1 ? `${fresh[0]!.label}: ${fresh[0]!.outcome}` : `${fresh.length} new operation outcomes.`);
        for (const kind of KINDS) { if (next.sources[kind] === 'available') { baseline[kind] = true; mountedIds.set(kind, new Set(next.items.filter((item) => item.kind === kind).map((item) => item.id))); } else if (next.sources[kind] === 'forbidden') { baseline[kind] = false; mountedIds.delete(kind); } }
        snapshot = next;
        setState({ scope, snapshot, loading: false, error: '', entries, storageFailed });
      } catch { if (alive && !controller.signal.aborted) setState({ scope, snapshot, loading: false, error: 'Could not refresh notifications.', entries, storageFailed }); }
      finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); busy = false; }
    };
    refreshRef.current = refresh;
    writeRef.current = (ids) => { entries = markNotificationsRead(entries, ids, Date.now()); persist(); setState((value) => value.scope === scope ? { ...value, entries, storageFailed } : value); };
    const visible = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(() => void refresh(), 15000); document.addEventListener('visibilitychange', visible); void refresh();
    return () => { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); refreshRef.current = null; writeRef.current = null; };
  }, [owner, scope, announce, clearNotice]);
  const current = state.scope === scope && owner ? state : null;
  const read = new Set(current?.entries.filter((entry) => entry.read).map((entry) => entry.id));
  const items = current?.snapshot?.items ?? [];
  const countKnown = !!current?.snapshot && !current.error && !Object.values(current.snapshot.sources).includes('unavailable');
  const value: Feed | null = owner ? { items, sources: current?.snapshot?.sources ?? {}, summaries: current?.snapshot?.summaries, omittedCount: current?.snapshot?.omittedCount ?? 0, unread: countKnown ? items.filter((item) => !read.has(item.id)).length : null, open, loading: current?.loading ?? true, error: current?.error ?? '', updatedAt: current?.snapshot?.generatedAt ?? null, storageFailed: current?.storageFailed ?? false, unavailable: !!current?.snapshot && Object.values(current.snapshot.sources).includes('unavailable'),
    toggle: () => setOpen((value) => !value), close: () => setOpen(false), retry: () => void refreshRef.current?.(), markRead: (ids) => writeRef.current?.(ids), isRead: (id) => read.has(id) } : null;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
