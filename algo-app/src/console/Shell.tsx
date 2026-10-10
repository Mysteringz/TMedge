/**
 * The console around everything: sign-in, module select, and the modules.
 * Module 01 is the algo debugger exactly as it was (App.tsx), and module 03
 * the edge's debug console (formerly console.hkumyseat.com), each under the
 * console's top bar. Module 04 owns firmware builds and OTA rollouts.
 */
import { AdminSessionContext, type AdminSession } from '../entities/admin-session/index.tsx';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NotificationProvider } from '../entities/operation-notification/index.tsx';
import { NotificationCenter, NotificationToggle } from '../widgets/notification-center/index.tsx';
import { Root as FlowApp } from '../App.tsx';
import { Home } from './Home.tsx';
import { Login } from './Login.tsx';
import { Nav, Toast, useToast } from './parts.tsx';
import { navigate, screenOf, toLogin, usePath } from './router.ts';
import './console.css';

// The editor (CodeMirror) is most of module 02's weight; sign-in and the
// home screen should not wait for it.
const Train = lazy(() => import('./Train.tsx').then((m) => ({ default: m.Train })));
const Updates = lazy(() => import('./Updates.tsx').then((m) => ({ default: m.Updates })));
const Accounts = lazy(() => import('../pages/admin-accounts/index.tsx').then((m) => ({ default: m.Accounts })));
const Adoption = lazy(() => import('./Adoption.tsx').then((m) => ({ default: m.Adoption })));
const TMflashConnect = lazy(() => import('./TMflashConnect.tsx').then((m) => ({ default: m.TMflashConnect })));

export function Shell() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [toast, rawFlash] = useToast();
  const notificationToast = useRef(false);
  const flash = useCallback((message: string) => { notificationToast.current = false; rawFlash(message); }, [rawFlash]);
  const announce = useCallback((message: string) => { notificationToast.current = true; rawFlash(message); }, [rawFlash]);
  const clearNotice = useCallback(() => { if (notificationToast.current) { notificationToast.current = false; rawFlash(''); } }, [rawFlash]);
  return (
    <AdminSessionContext.Provider value={session}>
      <NotificationProvider owner={session?.capabilities.includes('algo.read') ? session.user : null} scope={session ? `${session.user}:${session.role}:${session.capabilities.join(',')}` : ''} announce={announce} clearNotice={clearNotice}>
        <ShellContent session={session} onSession={setSession} flash={flash} />
      </NotificationProvider>
      <div className="cx"><Toast text={toast} /></div>
    </AdminSessionContext.Provider>
  );
}

function ShellContent({ session, onSession, flash }: { session: AdminSession | null; onSession(value: AdminSession | null): void; flash(message: string): void }) {
  const path = usePath();
  const screen = screenOf(path);
  // undefined: still asking the server; null: not signed in.
  const [user, setUser] = useState<string | null | undefined>(undefined);

  const [accessError, setAccessError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch('/api/me', { signal: controller.signal });
        if (response.status === 401) { onSession(null); setUser(null); return; }
        if (!response.ok) throw new Error('Could not check access.');
        const value = await response.json() as AdminSession;
        if (!value.user || !['viewer', 'operator', 'engineer', 'admin'].includes(value.role) || !Array.isArray(value.capabilities)) throw new Error('Access information is unavailable.');
        onSession(value); setUser(value.user); setAccessError('');
      } catch (error) { if (!controller.signal.aborted) { onSession(null); setAccessError(error instanceof Error ? error.message : 'Could not check access.'); } }
      finally { busy = false; }
    };
    const changed = (event: Event) => {
      const status = (event as CustomEvent<number>).detail;
      onSession(null);
      if (status === 401) { setUser(null); flash('Your session ended. Sign in again.'); }
      else { flash('Your access has changed. This action is unavailable.'); void refresh(); }
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener('admin-access-change', changed);
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('admin-access-change', changed); document.removeEventListener('visibilitychange', visible); };
  }, [retry, onSession, flash]);

  // The server already redirects a page load; this covers moving around
  // inside the app after the session has gone (expired, account removed).
  useEffect(() => {
    if (user === null && screen !== 'login') toLogin();
    if (user && screen === 'login') navigate('/', true);
  }, [user, screen]);

  const signOut = async () => {
    try {
      const response = await fetch('/auth/logout', { method: 'POST', headers: { 'x-tm-algo': '1' } });
      if (!response.ok) throw new Error('logout refused');
    } catch {
      flash('could not reach the console; you may still be signed in');
      return;
    }
    onSession(null); setUser(null);
    navigate('/login', true);
  };

  if (accessError) return <main className="cx cx-page"><p role="alert">{accessError}</p><button onClick={() => setRetry((value) => value + 1)}>Retry</button></main>;
  if (user === undefined) return <div className="cx cx-page" aria-busy="true">Checking access…</div>;

  if (screen === 'login' || !user) {
    return (
      <div className="cx cx-page">
        <Backdrop />
        <Login onSignedIn={(value) => { setUser(value); setRetry((current) => current + 1); }} />
      </div>
    );
  }

  if (!session) return <div className="cx cx-page" aria-busy="true">Checking access…</div>;

  if (screen === 'console') {
    return (
      <div className="cx-flow">
        <div className="cx cx-flow-bar"><ShellNavigation user={user} onSignOut={signOut} /></div>
        {/* Its own document: the console's global stylesheet and run-once
            module stay out of this app (see src/algo/server.ts). */}
        <iframe className="cx-frame" src="/console-app/" title="Debug console" />
      </div>
    );
  }

  if (screen === 'flow') {
    return (
      <div className="cx-flow">
        <div className="cx cx-flow-bar"><ShellNavigation user={user} onSignOut={signOut} /></div>
        <FlowApp />
      </div>
    );
  }

  return (
    <div className="cx cx-page">
      <Backdrop />
      <ShellNavigation user={user} onSignOut={signOut} />
      {screen === 'accounts' ? <Suspense fallback={<main aria-busy="true">Loading accounts…</main>}><Accounts /></Suspense>
        : screen === 'train' ? <Suspense fallback={null}><Train /></Suspense>
        : screen === 'updates' ? <Suspense fallback={<main className="cx-train cx-hint">Loading updates…</main>}><Updates /></Suspense>
          : screen === 'adoption' ? <Suspense fallback={<main className="cx-train cx-hint">Loading adoption…</main>}><Adoption /></Suspense>
          : screen === 'tmflash-connect' ? <Suspense fallback={null}><TMflashConnect user={user} /></Suspense>
          : <Home user={user} />}
    </div>
  );
}

/** The faint 2x Grid behind the page. Decoration only. */
function Backdrop() {
  return <div className="cx-grid" aria-hidden="true" />;
}

function ShellNavigation({ user, onSignOut }: { user: string; onSignOut(): void }) {
  return <Nav user={user} onSignOut={onSignOut} notificationToggle={<NotificationToggle />} notificationPanel={<NotificationCenter />} />;
}
