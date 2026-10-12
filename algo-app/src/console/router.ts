/**
 * These screens do not need a router library: the path is the state, and the
 * server serves the same shell for each of them (src/algo/server.ts).
 */
import { useEffect, useState } from 'react';

export type Screen = 'login' | 'home' | 'flow' | 'train' | 'ml-data' | 'console' | 'updates' | 'analytics' | 'accounts' | 'account' | 'adoption' | 'flash' | 'tmflash-download' | 'tmflash-connect';

export function screenOf(path: string): Screen {
  if (path.startsWith('/login')) return 'login';
  if (path.startsWith('/flow')) return 'flow';
  if (path === '/ml-data' || path.startsWith('/ml-data/')) return 'ml-data';
  if (path.startsWith('/train')) return 'train';
  if (path === '/accounts' || path.startsWith('/accounts/')) return 'accounts';
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
window.addEventListener('popstate', () => listeners.forEach((f) => f()));

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
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
