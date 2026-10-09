export const WINDOW_MS = 7 * 24 * 60 * 60_000;
export const KINDS = ['sensor', 'training', 'firmware', 'parameter'] as const;
export type NotificationKind = typeof KINDS[number];
export interface NotificationItem { id: string; kind: NotificationKind; resourceId: string; label: string; outcome: string; occurredAt: number | null; href: string; classification?: 'active' | 'outcome'; detail?: string; deadlineAt?: number | null }
export interface NotificationSummary { total: number; issues: number; status: string; observedAt: number | null; stale: boolean; active?: number; progress?: number }
export interface NotificationSnapshot { generatedAt: number; items: NotificationItem[]; sources: Partial<Record<NotificationKind, string>>; summaries?: Partial<Record<NotificationKind, NotificationSummary>>; omittedCount?: number; historyLimited: true }
export interface SeenNotification { id: string; at: number; read: boolean }
export const notificationStorageKey = (owner: string): string => `tm-algo-notifications:v1:${encodeURIComponent(owner)}`;
export function pruneSeen(value: unknown, now: number): SeenNotification[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, SeenNotification>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Partial<SeenNotification>;
    if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 1024 || typeof entry.at !== 'number' || !Number.isFinite(entry.at) || entry.at < now - WINDOW_MS || entry.at > now || typeof entry.read !== 'boolean') continue;
    unique.set(entry.id, { id: entry.id, at: entry.at, read: entry.read });
  }
  return [...unique.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 200);
}
export function mergeSeen(previous: SeenNotification[], items: NotificationItem[], now: number, availableKinds?: ReadonlySet<NotificationKind>): { entries: SeenNotification[]; fresh: NotificationItem[] } {
  const active = new Set(items.filter((item) => item.classification === 'active' && (!availableKinds || availableKinds.has(item.kind))).map((item) => item.id));
  const entries = pruneSeen(previous.map((entry) => active.has(entry.id) ? { ...entry, at: now } : entry), now), ids = new Set(entries.map((row) => row.id));
  const fresh = items.filter((item) => !ids.has(item.id));
  return { entries: pruneSeen([...entries, ...fresh.map((item) => ({ id: item.id, at: now, read: false }))], now), fresh };
}
export function markNotificationsRead(previous: SeenNotification[], ids: string[], now: number): SeenNotification[] {
  const selected = new Set(ids);
  return pruneSeen(previous.map((entry) => selected.has(entry.id) ? { ...entry, read: true } : entry), now);
}
