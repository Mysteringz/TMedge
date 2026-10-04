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
import { newSnake, NN, stepSnake, type SnakeState } from './snake.ts';
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
      <section className="cx-login-left">
        <div className="cx-row">
          <BrandMark px={5} />
          <span className="cx-team">HKU MySeat · Algorithm Team</span>
        </div>

        <div className="cx-login-body">
          <div className="cx-kicker">&gt; INTERNAL CONSOLE_<span className="cx-blink">█</span></div>
          <h1 className="cx-title">algo<span className="cx-accent">.</span></h1>
          <p className="cx-lede">Console and test bench for the MySeat algorithm team — pipe algorithms, train models on collected data, ship them.</p>

          <form className="cx-form" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="u">USERNAME</label>
              <input id="u" name="username" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                placeholder="e.g. hlam" value={username} onChange={(e) => { setUsername(e.target.value); setError(''); }} />
            </div>
            <div className="field">
              <label htmlFor="p">PASSWORD</label>
              <div className="cx-pw">
                <input id="p" name="password" className="input" type={showPw ? 'text' : 'password'} autoComplete="current-password"
                  placeholder="••••••••" value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} />
                <button type="button" className="btn btn-ghost cx-eye" onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeSlash /> : <Eye />}</button>
              </div>
            </div>
            <Turnstile ref={check} action="algo-login" onToken={setHuman} />
            {error && <div className="cx-error" role="alert">! {error}</div>}
            <button type="submit" className="btn btn-primary cx-submit" disabled={busy}>
              <span>{busy ? 'AUTHENTICATING…' : 'SIGN IN'}</span><ArrowRight />
            </button>
          </form>
        </div>

        <div className="cx-meta"><span>algo.hkumyseat.com</span><span>accounts: npm run algo-user</span></div>
      </section>

      <section className="cx-login-right" aria-hidden="true">
        <SnakeBoard />
      </section>
    </main>
  );
}

const EMPTY = 'color-mix(in srgb, var(--color-text) 5%, transparent)';

/** Crisp 8-bit steps: no transitions, one tick every 110 ms. */
function SnakeBoard() {
  const [s, setS] = useState<SnakeState>(newSnake);
  useEffect(() => {
    const t = setInterval(() => setS((prev) => stepSnake(prev)), 110);
    return () => clearInterval(t);
  }, []);
  const pos = new Map(s.snake.map((c, i) => [c, i]));
  const L = s.snake.length;
  return (
    <div className="cx-board">
      {Array.from({ length: NN }, (_, i) => {
        let bg = EMPTY, glow = 'none';
        const k = pos.get(i);
        if (i === s.food) { bg = 'var(--color-accent-200)'; glow = '0 0 10px color-mix(in srgb, #ffe3cf 60%, transparent)'; }
        else if (k === 0) { bg = 'var(--color-accent)'; glow = '0 0 12px color-mix(in srgb, #f28c38 70%, transparent)'; }
        else if (k !== undefined) bg = k / L < 0.4 ? 'var(--color-accent-500)' : k / L < 0.75 ? 'var(--color-accent-600)' : 'var(--color-accent-700)';
        return <div key={i} style={{ background: bg, boxShadow: glow }} />;
      })}
    </div>
  );
}
