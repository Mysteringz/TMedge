/** Module select: where an engineer lands after signing in. */
import { useEffect, useRef, useState } from 'react';
import { donutFrame } from './donut.ts';
import { ArrowRight } from './icons.tsx';
import { navigate } from './router.ts';

const MODULES = [
  { n: '01', title: 'Algorithm Flow', path: '/flow', desc: 'Compose and pipe algorithms into the seat-allocation pipeline.' },
  { n: '02', title: 'ML Training', path: '/train', desc: 'Write a training script, run it on collected data, batch-test and export the model.' },
];

export function Home({ user }: { user: string }) {
  const [sel, setSel] = useState(0);
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s + 1) % MODULES.length); }
      else if (e.key === '1' || e.key === '2') setSel(Number(e.key) - 1);
      // A focused module button handles Enter itself; this is for the page.
      else if (e.key === 'Enter' && document.activeElement === document.body) {
        navigate(MODULES[selRef.current]?.path ?? '/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <main className="cx-home-main">
      <section className="cx-home-left">
        <div className="cx-kicker">&gt; SELECT MODULE</div>
        <h1 className="cx-welcome">Welcome back, {user}.</h1>
        <p className="cx-help">Pick where to work. Use <kbd>↑ ↓</kbd> and <kbd>enter</kbd>.</p>
        <div className="cx-modules">
          {MODULES.map((m, i) => (
            <button key={m.n} className={`cx-module ${sel === i ? 'is-on' : ''}`}
              onClick={() => navigate(m.path)} onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)}>
              <span className="cx-caret">&gt;</span>
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
      <section className="cx-home-right" aria-hidden="true">
        <Donut />
      </section>
    </main>
  );
}

function Donut() {
  const el = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Someone who asked for less motion gets a still torus.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let a = 0, b = 0, raf = 0;
    const tick = () => {
      a += 0.035; b += 0.017;
      if (el.current) el.current.textContent = donutFrame(a, b);
      if (!still) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <pre ref={el} className="cx-donut" />;
}
