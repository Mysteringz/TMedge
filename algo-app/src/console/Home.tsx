/** Where an engineer lands after signing in: a welcome, and under it the workspace. */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { donutFrame } from './donut.ts';

// Nobody needs a mailbox to sign in: the workspace arrives with the page
// that shows it, and the welcome does not wait for it.
const Workspace = lazy(() => import('../widgets/workspace/index.ts').then((m) => ({ default: m.Workspace })));

export function Home({ user, flash }: { user: string; flash(message: string): void }) {
  return (
    <>
    {/* Behind everything, and bigger than the tab: a slow, soft ring of light. */}
    <div className="cx-donut-stage" aria-hidden="true"><Donut /></div>
    <main className="cx-home-main">
      <Welcome user={user} />
      <Suspense fallback={null}><Workspace user={user} flash={flash} /></Suspense>
    </main>
    </>
  );
}

/**
 * "Welcome back" in the languages of the people this is for and around. Each
 * is written with its own punctuation; the name is never translated.
 */
interface Greeting { lang: string; text: string; before: string; after: string }
const ENGLISH: Greeting = { lang: 'en', text: 'Welcome back', before: ', ', after: '.' };
const GREETINGS: Greeting[] = [
  ENGLISH,
  { lang: 'zh-Hant', text: '歡迎回來', before: '，', after: '。' },
  { lang: 'th', text: 'ยินดีต้อนรับกลับมา', before: ' ', after: '' },
  { lang: 'ja', text: 'おかえりなさい', before: '、', after: '。' },
  { lang: 'es', text: 'Bienvenido de nuevo', before: ', ', after: '.' },
  { lang: 'ko', text: '다시 오신 것을 환영합니다', before: ', ', after: '.' },
  { lang: 'fr', text: 'Bon retour', before: ', ', after: '.' },
  { lang: 'de', text: 'Willkommen zurück', before: ', ', after: '.' },
];

/** What a person would call one character: a Thai consonant keeps its vowel marks, a Korean syllable stays whole. */
function letters(text: string, lang: string): string[] {
  try { return [...new Intl.Segmenter(lang, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment); }
  catch { return Array.from(text); }
}

const TYPE_MS = 75, ERASE_MS = 38, HOLD_MS = 3200, GAP_MS = 450;

/**
 * The greeting types itself out, rests, erases and comes back in another
 * language. It is decoration and is treated as such: the heading's name for
 * a screen reader is always the plain English line, and someone who asked
 * for less motion gets that line, still.
 */
function Welcome({ user }: { user: string }) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(() => letters(ENGLISH.text, ENGLISH.lang).length);
  const greeting = GREETINGS[index % GREETINGS.length] ?? ENGLISH;
  const parts = letters(greeting.text, greeting.lang);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout>;
    let at = 0, count = letters(ENGLISH.text, ENGLISH.lang).length, erasing = true;
    const step = () => {
      // A tab nobody is looking at does not need to be typing.
      if (document.hidden) { timer = setTimeout(step, 1000); return; }
      const next = GREETINGS[at] ?? ENGLISH;
      const total = letters(next.text, next.lang).length;
      if (erasing) {
        if (count > 0) { count--; setShown(count); timer = setTimeout(step, ERASE_MS); return; }
        erasing = false; at = (at + 1) % GREETINGS.length; setIndex(at);
        timer = setTimeout(step, GAP_MS); return;
      }
      if (count < total) { count++; setShown(count); timer = setTimeout(step, TYPE_MS); return; }
      erasing = true; timer = setTimeout(step, HOLD_MS);
    };
    timer = setTimeout(step, HOLD_MS);
    return () => clearTimeout(timer);
  }, []);

  const whole = shown >= parts.length;
  return (
    <h1 className="cx-welcome" aria-label={`Welcome back, ${user}.`}>
      <span aria-hidden="true" lang={greeting.lang}>
        <span className="cx-welcome__typed">{parts.slice(0, shown).join('')}</span>
        <span className={`cx-welcome__caret ${whole ? 'is-resting' : ''}`} />
        {/* The name stays put and stays bold while the words around it change. */}
        <span className="cx-welcome__rest">{greeting.before}<b>{user}</b>{greeting.after}</span>
      </span>
    </h1>
  );
}

/**
 * Radians per second: about 80 s per turn. Time-based rather than per-frame,
 * so it keeps the same stately pace on a 60 Hz laptop and a 120 Hz display.
 */
const SPIN_A = 0.08;
const SPIN_B = 0.035;
/** Blurred to a glow, the ring needs a dozen frames a second, not sixty: each one is a large blurred repaint. */
const FRAME_MS = 80;

function Donut() {
  const el = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Someone who asked for less motion gets a still torus.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, drawn = -Infinity;
    const t0 = performance.now();
    // Start mid-turn: a torus seen exactly edge-on or face-on is the least
    // interesting frame there is, and a slow spin would hold it for seconds.
    const tick = (now: number) => {
      if (now - drawn >= FRAME_MS && !document.hidden) {
        drawn = now;
        const t = (now - t0) / 1000;
        if (el.current) el.current.textContent = donutFrame(1.1 + t * SPIN_A, 0.6 + t * SPIN_B);
      }
      if (!still) raf = requestAnimationFrame(tick);
    };
    tick(t0);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <pre ref={el} className="cx-donut" />;
}
