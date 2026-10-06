/**
 * Sign in. The photographic hero stays; what changes is that it now posts
 * over fetch and honours ?next=, so a student sent here from a page they
 * asked for lands back on it rather than the dashboard.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { GoogleButton, googleError } from '../GoogleButton.tsx';
import { Turnstile, turnstileOn, type TurnstileHandle } from '../Turnstile.tsx';

import { safeNext } from '../../../src/web/navigation.js';
export { safeNext } from '../../../src/web/navigation.js';

export default function Login() {
  // A Google sign-in the server refused comes back here as ?error=.
  const [error, setError] = useState<string | null>(() => googleError(new URLSearchParams(location.search).get('error')));
  const [busy, setBusy] = useState(false);
  const [human, setHuman] = useState<string | null>(null);
  const check = useRef<TurnstileHandle>(null);
  const next = safeNext(new URLSearchParams(location.search).get('next'));

  useEffect(() => {
    document.title = 'Sign in · HKUMySeat';
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password'), next, 'cf-turnstile-response': human }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? 'That UID and PIN do not match.');
        check.current?.reset();   // the token was spent on this attempt
        return;
      }
      location.href = safeNext(body.redirect ?? next);
    } catch {
      setError('Could not reach the server. Try again.');
      check.current?.reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-photos" aria-hidden="true">
        <img className="slide" src="/assets/images/Library.jpg" alt="" />
        <img className="slide" src="/assets/images/chi-wah.jpg" alt="" />
        <img className="slide" src="/assets/images/twf-innovation-wing.jpg" alt="" />
        <div className="auth-veil" />
      </div>

      <div className="auth-hero">
        <div className="brandline">
          <div className="mark" />
          <div className="name">HKUMySeat</div>
          <div className="bar" />
          <div className="uni">The University of Hong Kong</div>
        </div>
        <div className="auth-copy">
          <div className="rule" />
          <h1>Every vacant seat<br />on campus, live.</h1>
          <p>
            Real-time occupancy for HKU libraries and co-working spaces. Search for the number of seats your
            group needs and see every table with room.
          </p>
        </div>
        <div className="auth-foot">Pilot — Tam Wing Fan Innovation Wing</div>
      </div>

      <div className="auth-panel">
        <h2>Student sign in</h2>
        <p className="sub text-muted">Use your HKUMySeat account to see live seat availability.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <form onSubmit={submit}>
          <div className="fields">
            <div className="field">
              <label className="field-label" htmlFor="uid">HKU email or UID</label>
              <input className="input" id="uid" name="email" maxLength={254} type="text" placeholder="u3xxxxxxx" autoComplete="username" required autoFocus />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pin">PIN</label>
              <input className="input" id="pin" name="password" maxLength={1024} type="password" placeholder="••••••••" autoComplete="current-password" required />
            </div>
          </div>
          <Turnstile ref={check} action="login" onToken={setHuman} />
          <button className="btn btn-primary" type="submit" disabled={busy || (turnstileOn && !human)}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <GoogleButton next={next} />
        <div className="auth-links">
          <Link to={`/signup/?next=${encodeURIComponent(next)}`}>Create an account</Link>
          <span className="text-muted">HKU UID or Google account</span>
        </div>
        <div className="auth-spacer" />
        <hr className="hr" />
        <p className="fine text-muted">
          Seats are counted by ceiling heat sensors: temperature only, no cameras, and nothing that can identify you.
        </p>
      </div>
    </div>
  );
}
