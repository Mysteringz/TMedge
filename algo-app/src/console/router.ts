/**
 * These screens do not need a router library: the path is the state, and the
 * server serves the same shell for each of them (src/algo/server.ts).
 */
import { useEffect, useState } from 'react';

export type Screen = 'login' | 'home' | 'flow' | 'train' | 'ml-data' | 'console' | 'updates' | 'analytics' | 'accounts' | 'account' | 'adoption' | 'flash' | 'tmflash-download' | 'tmflash-connect' | 'locations';

export function screenOf(path: string): Screen {
  if (path.startsWith('/login')) return 'login';
  if (path.startsWith('/flow')) return 'flow';
  if (path === '/ml-data' || path.startsWith('/ml-data/')) return 'ml-data';
  if (path.startsWith('/train')) return 'train';
  if (path === '/accounts' || path.startsWith('/accounts/')) return 'accounts';
  if (path === '/locations' || path.startsWith('/locations/')) return 'locations';
  // One person's own settings; /accounts above is the admin's list of everyone.
  if (path === '/account') return 'account';
  if (path === '/console' || path.startsWith('/console/')) return 'console';
  if (path === '/updates' || path.startsWith('/updates/')) return 'updates';
  if (path === '/analytics' || path.startsWith('/analytics/')) return 'analytics';
  if (path === '/adoption' || path.startsWith('/adoption/')) return 'adoption';
  if (path === '/flash' || path.startsWith('/flash/')) return 'flash';
  if (path === '/tmflash-download' || path.startsWith('/tmflash-download/')) return 'tmflash-download';
  if (path === '/tmflash/connect') return 'tmflash-connect';
  return 'home';
}

const listeners = new Set<() => void>();
type NavigationGuard = (to: string) => boolean;
const navigationGuards = new Set<NavigationGuard>();
const historyIndex = (state: unknown): number | null => {
  if (!state || typeof state !== 'object' || !('tmNavigationIndex' in state)) return null;
  return typeof state.tmNavigationIndex === 'number' && Number.isSafeInteger(state.tmNavigationIndex) ? state.tmNavigationIndex : null;
};
let currentIndex = historyIndex(history.state) ?? 0;
let currentUrl = location.pathname + location.search + location.hash;
let restoringHistory = false;
history.replaceState({ ...history.state, tmNavigationIndex: currentIndex }, '', currentUrl);
const canNavigate = (to: string): boolean => [...navigationGuards].every((guard) => guard(to));

window.addEventListener('popstate', () => {
  if (restoringHistory) { restoringHistory = false; return; }
  const to = location.pathname + location.search + location.hash;
  const targetIndex = historyIndex(history.state);
  if (!canNavigate(to)) {
    if (targetIndex !== null && targetIndex !== currentIndex) {
      restoringHistory = true;
      history.go(currentIndex - targetIndex);
    } else history.replaceState({ ...history.state, tmNavigationIndex: currentIndex }, '', currentUrl);
    return;
  }
  currentIndex = targetIndex ?? currentIndex;
  currentUrl = to;
  listeners.forEach((f) => f());
});

/** Register a synchronous leave check shared by app links and browser Back/Forward. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  navigationGuards.add(guard);
  return () => { navigationGuards.delete(guard); };
}

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (!canNavigate(to)) return;
  if (replace) history.replaceState({ tmNavigationIndex: currentIndex }, '', to);
  else history.pushState({ tmNavigationIndex: ++currentIndex }, '', to);
  currentUrl = location.pathname + location.search + location.hash;
  listeners.forEach((f) => f());
}

/** The current path, re-rendering on navigate() and the back button. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return path;
}

/** Where to send someone who has to sign in first: back here afterwards. */
export function toLogin(): void {
  if (screenOf(location.pathname) === 'login') return;
  navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, true);
}
