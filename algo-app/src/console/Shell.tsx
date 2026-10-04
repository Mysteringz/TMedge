/**
 * The console around everything: sign-in, module select, and the modules.
 * Module 01 is the algo debugger exactly as it was (App.tsx), and module 03
 * the edge's debug console (formerly console.hkumyseat.com), each under the
 * console's top bar; nothing inside either changed.
 */
import { useEffect, useState } from 'react';
import { Root as FlowApp } from '../App.tsx';
import { Home } from './Home.tsx';
import { Login } from './Login.tsx';
import { Nav, Toast, useToast } from './parts.tsx';
import { navigate, screenOf, toLogin, usePath } from './router.ts';
import { Train } from './Train.tsx';
import './console.css';

export function Shell() {
  const path = usePath();
  const screen = screenOf(path);
  // undefined: still asking the server; null: not signed in.
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [toast, flash] = useToast();

  useEffect(() => {
    let gone = false;
    fetch('/api/me')
      .then(async (r) => (r.ok ? ((await r.json()) as { user?: string }).user ?? null : null))
      .catch(() => null)
      .then((u) => { if (!gone) setUser(u); });
    return () => { gone = true; };
  }, []);

  // The server already redirects a page load; this covers moving around
  // inside the app after the session has gone (expired, account removed).
  useEffect(() => {
    if (user === null && screen !== 'login') toLogin();
    if (user && screen === 'login') navigate('/', true);
  }, [user, screen]);

  const signOut = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST', headers: { 'x-tm-algo': '1' } });
    } catch {
      flash('could not reach the console; you may still be signed in');
      return;
    }
    setUser(null);
    navigate('/login', true);
  };

  if (user === undefined) return <div className="cx cx-page" />;

  if (screen === 'login' || !user) {
    return (
      <div className="cx cx-page">
        <Backdrop />
        <Login onSignedIn={setUser} />
      </div>
    );
  }

  if (screen === 'console') {
    return (
      <div className="cx-flow">
        <div className="cx cx-flow-bar"><Nav user={user} crumb="debug-console" onSignOut={signOut} /></div>
        {/* Its own document: the console's global stylesheet and run-once
            module stay out of this app (see src/algo/server.ts). */}
        <iframe className="cx-frame" src="/console-app/" title="Debug console" />
      </div>
    );
  }

  if (screen === 'flow') {
    return (
      <div className="cx-flow">
        <div className="cx cx-flow-bar"><Nav user={user} crumb="algorithm-flow" onSignOut={signOut} /></div>
        <FlowApp />
      </div>
    );
  }

  return (
    <div className="cx cx-page">
      <Backdrop />
      <Nav user={user} crumb={screen === 'train' ? 'ml-training' : undefined} onSignOut={signOut} />
      {screen === 'train' ? <Train /> : <Home user={user} />}
      <Toast text={toast} />
    </div>
  );
}

/** The faint grid and CRT scanlines from the design. Decoration only. */
function Backdrop() {
  return <><div className="cx-grid" aria-hidden="true" /><div className="cx-scan" aria-hidden="true" /></>;
}
