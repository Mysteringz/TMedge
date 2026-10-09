/** Module select: where an engineer lands after signing in. */
import { useEffect, useRef, useState } from 'react';
import { donutFrame } from './donut.ts';
import { ArrowRight } from './icons.tsx';
import { MODULES } from './parts.tsx';
import { navigate } from './router.ts';

export function Home({ user }: { user: string }) {
  const [sel, setSel] = useState(0);
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % MODULES.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s + MODULES.length - 1) % MODULES.length); }
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= MODULES.length) setSel(Number(e.key) - 1);
      // A focused module button handles Enter itself; this is for the page.
      else if (e.key === 'Enter' && document.activeElement === document.body) {
        navigate(MODULES[selRef.current]?.path ?? '/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
    {/* Behind everything, and bigger than the tab: only part of the ring is
        ever on screen, turning slowly past the modules. */}
    <div className="cx-donut-stage" aria-hidden="true"><Donut /></div>
    <main className="cx-home-main">
      <section className="cx-home-left">
        <p className="cx-eyebrow">Select module</p>
        <h1 className="cx-welcome">Welcome back, {user}.</h1>
        <p className="cx-help">Pick where to work. Use <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>Enter</kbd>, or <kbd>1</kbd>–<kbd>4</kbd>.</p>
        <div className="cx-modules">
          {MODULES.map((m, i) => (
            <button key={m.n} className={`cx-module ${sel === i ? 'is-on' : ''}`}
              onClick={() => navigate(m.path)} onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)}>
              <span className="cx-n">{m.n}</span>
              <span className="cx-mod-text">
                <span className="cx-mod-title">{m.title}<span className="cx-path">{m.path}</span></span>
                <span className="cx-mod-desc">{m.desc}</span>
              </span>
              <span className="cx-arrow"><ArrowRight /></span>
            </button>
          ))}
        </div>
      </section>
    </main>
    </>
  );
}

/**
 * Radians per second: about 80 s per turn. Time-based rather than per-frame,
 * so it keeps the same stately pace on a 60 Hz laptop and a 120 Hz display.
 */
const SPIN_A = 0.08;
const SPIN_B = 0.035;

function Donut() {
  const el = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Someone who asked for less motion gets a still torus.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const t0 = performance.now();
    // Start mid-turn: a torus seen exactly edge-on or face-on is the least
    // interesting frame there is, and a slow spin would hold it for seconds.
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      if (el.current) el.current.textContent = donutFrame(1.1 + t * SPIN_A, 0.6 + t * SPIN_B);
      if (!still) raf = requestAnimationFrame(tick);
    };
    tick(t0);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <pre ref={el} className="cx-donut" />;
}
