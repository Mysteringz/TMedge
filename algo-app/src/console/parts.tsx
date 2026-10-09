/** Pieces every console screen shares: the brand, the top bar, the toast. */

import { useAdminSession } from '../entities/admin-session/index.tsx';

import { useCallback, useRef, useState } from 'react';

import { navigate, screenOf, usePath } from './router.ts';

import { SignOut } from './icons.tsx';



export const MODULES = [

  { n: '01', title: 'Algorithm flow', path: '/flow', desc: 'Compose and pipe algorithms into the seat-allocation pipeline.' },

  { n: '02', title: 'ML training', path: '/train', desc: 'Write a training script, run it on collected data, batch-test and export the model.' },

  { n: '03', title: 'Debug console', path: '/console', desc: 'Live thermal frames, floor fusion, node health and commands, and admitting nodes.' },

  { n: '04', title: 'Updates', path: '/updates', desc: 'Upload firmware source, build an image, and roll it out to nodes one pilot at a time.' },

] as const;



/** A square of the accent with the letter in it: the console's only logo. */

export function BrandMark({ size = 24 }: { size?: number }) {

  return <span className="cx-mark" style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">a</span>;

}



export function Wordmark() {

  return <span className="cx-word"><b>algo</b>.hkumyseat</span>;

}



/** Carbon's UI shell header: the name, the modules, the person. */

export function Nav({ user, onSignOut }: { user: string; onSignOut(): void }) {

  const session = useAdminSession();

  const path = usePath();

  const screen = screenOf(path);

  const here = MODULES.find((m) => screenOf(m.path) === screen);

  return (

    <header className="cx-header" aria-label="algo.hkumyseat">

      <button className="cx-home" onClick={() => navigate('/')} aria-label="Home">

        <BrandMark size={20} />

        <Wordmark />

      </button>

      <nav className="cx-header-nav" aria-label="Modules">

        {MODULES.map((m) => (

          <a key={m.n} className="cx-header-item" href={m.path} aria-current={here === m ? 'page' : undefined}

            onClick={(e) => { e.preventDefault(); navigate(m.path); }}>{m.title}</a>

        ))}

      </nav>

      {here && <span className="cx-crumb">{here.title}</span>}

      <span className="cx-who"><span className="cx-online" />{user}@team <span className="tag tag-neutral">{session?.namedAccount ? session.role.charAt(0).toUpperCase() + session.role.slice(1) : 'Local operator'}</span></span>

      <button className="cx-header-action cx-out" onClick={onSignOut} aria-label="Sign out" title="Sign out"><SignOut /></button>

    </header>

  );

}



/** A short message bottom-left that clears itself. */

export function useToast(): [string, (msg: string) => void] {

  const [toast, setToast] = useState('');

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {

    if (timer.current) clearTimeout(timer.current);

    setToast(msg);

    timer.current = setTimeout(() => setToast(''), 2800);

  }, []);

  return [toast, flash];

}



export function Toast({ text }: { text: string }) {

  if (!text) return null;

  return <div className="cx-toast" role="status"><span className="cx-sq" />{text}</div>;

}
