/**
 * Which parts of the console this person actually opens, kept in their own
 * browser, so the landing page can offer those first.
 *
 * It is a convenience and is treated as one: per browser, never sent
 * anywhere, and the page works the same where storage is blocked.
 */
export interface Visit { path: string; count: number; last: number }

const key = (user: string) => `tm-algo-usage:v1:${encodeURIComponent(user)}`;
const DAY = 86_400_000;

export function readVisits(user: string): Visit[] {
  try {
    const raw = localStorage.getItem(key(user));
    if (!raw || raw.length > 20_000) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((row): row is Visit => !!row && typeof row.path === 'string' && /^\/[a-z0-9/-]{1,60}$/.test(row.path)
      && Number.isFinite(row.count) && row.count > 0 && Number.isFinite(row.last)).slice(0, 40);
  } catch { return []; }
}

export function recordVisit(user: string, path: string, now = Date.now()): void {
  if (!user || !/^\/[a-z0-9/-]{1,60}$/.test(path)) return;
  const visits = readVisits(user);
  const found = visits.find((visit) => visit.path === path);
  if (found) { found.count += 1; found.last = now; } else visits.push({ path, count: 1, last: now });
  try { localStorage.setItem(key(user), JSON.stringify(visits)); } catch { /* private window */ }
}

/**
 * Used often and used lately both count; a module opened daily last spring
 * should not outrank the one opened every day this week. Each week of
 * silence halves what a visit count is worth.
 */
export function visitScore(visit: Visit, now = Date.now()): number {
  return visit.count * 0.5 ** (Math.max(0, now - visit.last) / (7 * DAY));
}

/** `paths` reordered: the ones this person uses first, by score; the rest after, in the order given. */
export function byPersonalUse<T extends { path: string }>(items: readonly T[], visits: Visit[], now = Date.now()): { item: T; used: boolean }[] {
  const score = new Map(visits.map((visit) => [visit.path, visitScore(visit, now)]));
  return items.map((item, index) => ({ item, index, score: score.get(item.path) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score: s }) => ({ item, used: s > 0 }));
}
