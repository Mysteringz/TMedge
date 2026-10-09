/**
 * The sign-in page. It replaces the browser's Basic-auth dialog: a real form
 * (so password managers fill it), each engineer's own account, and Turnstile
 * in front of the password check. The server sets an HttpOnly cookie; this
 * page never sees or stores anything but what was typed.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeSlash } from './icons.tsx';
import { BrandMark } from './parts.tsx';
import { navigate } from './router.ts';
import { drawDotWave, type Pointer } from './dotwave.ts';
import { Turnstile, turnstileOn, type TurnstileHandle } from './Turnstile.tsx';

export function Login({ onSignedIn }: { onSignedIn(user: string): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [human, setHuman] = useState<string | null>(null);
  const check = useRef<TurnstileHandle>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return setError('username and password required');
    if (turnstileOn && !human) return setError('complete the verification first');
    setBusy(true);
    setError('');
    try {
      const next = new URLSearchParams(location.search).get('next') ?? '/';
      const r = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, next, 'cf-turnstile-response': human }),
      });
      const out = (await r.json().catch(() => ({}))) as { user?: string; redirect?: string; error?: string };
      if (!r.ok || !out.user) {
        setError(out.error ?? `sign-in failed (HTTP ${r.status})`);
        // A token is spent once Cloudflare has seen it; get a fresh one.
        check.current?.reset();
        return;
      }
      setPassword('');
      onSignedIn(out.user);
      navigate(out.redirect ?? '/', true);
    } catch {
      setError('cannot reach the console; try again');
      check.current?.reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="cx-login">
      <DotWave />
      <section className="cx-login-left">
        <div className="cx-row">
          <BrandMark size={28} />
          <span className="cx-team">HKU MySeat · Algorithm team</span>
        </div>

        <div className="cx-login-body">
          <p className="cx-eyebrow">Internal console</p>
          <h1 className="cx-title">algo<span className="cx-accent">.</span></h1>
          <p className="cx-lede">Console and test bench for the MySeat algorithm team — pipe algorithms, train models on collected data, ship them.</p>

          <form className="cx-form" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="u">Username</label>
              <input id="u" name="username" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                placeholder="e.g. hlam" value={username} onChange={(e) => { setUsername(e.target.value); setError(''); }} />
            </div>
            <div className="field">
              <label htmlFor="p">Password</label>
              <div className="cx-pw">
                <input id="p" name="password" className="input" type={showPw ? 'text' : 'password'} autoComplete="current-password"
                  placeholder="••••••••" value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} />
                <button type="button" className="cx-eye" onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeSlash /> : <Eye />}</button>
              </div>
            </div>
            <Turnstile ref={check} action="algo-login" onToken={setHuman} />
            {error && <div className="cx-error" role="alert">{error}</div>}
            <button type="submit" className="btn btn-primary cx-submit" disabled={busy}>
              <span>{busy ? 'Signing in…' : 'Sign in'}</span><ArrowRight />
            </button>
          </form>
        </div>

        <div className="cx-meta"><span>algo.hkumyseat.com</span><span>accounts: npm run algo-user</span></div>
      </section>

    </main>
  );
}

/**
 * Behind the whole page, faded out under the form (console.css), so the
 * orange field rises out of the background rather than sitting in a box.
 */
function DotWave() {
  const el = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = el.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const ink = getComputedStyle(cv).getPropertyValue('--interactive').trim() || '#ff832b';
    // Someone who asked for less motion gets one still frame.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, raf = 0, pt: Pointer | null = null, visible = true;
    const t0 = performance.now();
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const frame = (now: number) => {
      drawDotWave(ctx, (still ? 2400 : now - t0) + 2400, W, H, ink, pt);
      if (!still && visible) raf = requestAnimationFrame(frame);
    };
    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    const onLeave = () => { pt = null; };
    // A background tab has no reason to keep drawing.
    const onVis = () => {
      visible = !document.hidden;
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(frame);
    };
    const onResize = () => { fit(); if (still) frame(t0); };
    fit();
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return <canvas ref={el} className="cx-dotwave" aria-hidden="true" />;
}
