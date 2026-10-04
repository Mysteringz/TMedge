/** Pieces every console screen shares: the brand, the top bar, the toast. */
import { useCallback, useRef, useState } from 'react';
import { navigate } from './router.ts';
import { SignOut } from './icons.tsx';

/** The 5x5 pixel "a". */
const BRAND = ['.###.', '....#', '.####', '#...#', '.####'].join('');

export function BrandMark({ px }: { px: number }) {
  return (
    <span className="cx-mark" style={{ gridTemplateColumns: `repeat(5, ${px}px)` }} aria-hidden="true">
      {BRAND.split('').map((c, i) => <span key={i} style={{ width: px, height: px, background: c === '#' ? 'var(--color-accent)' : 'transparent' }} />)}
    </span>
  );
}

export function Wordmark() {
  return <span className="cx-word">algo<span className="cx-dot">.</span>hkumyseat</span>;
}

export function Nav({ user, crumb, onSignOut }: { user: string; crumb?: string; onSignOut(): void }) {
  return (
    <nav className="cx-nav">
      <button className="cx-home" onClick={() => navigate('/')} aria-label="Home">
        <BrandMark px={4} />
        <Wordmark />
        {crumb && <span className="cx-crumb"><span>/</span><span className="cx-accent">{crumb}</span></span>}
      </button>
      <span className="tag tag-neutral cx-who"><span className="cx-online" />{user}@team</span>
      <button className="btn btn-secondary cx-out" onClick={onSignOut}><SignOut />Sign out</button>
    </nav>
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
