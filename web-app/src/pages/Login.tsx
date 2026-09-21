/**
 * Sign in. The photographic hero stays; what changes is that it now posts
 * over fetch and honours ?next=, so a student sent here from a page they
 * asked for lands back on it rather than the dashboard.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

/** Only a path on this site: never an absolute URL someone put in a link. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard/';
  return raw;
}

export default function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
        body: JSON.stringify({ email: form.get('email'), password: form.get('password'), next }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? 'That UID and PIN do not match.');
        return;
      }
      location.href = safeNext(body.redirect ?? next);
    } catch {
      setError('Could not reach the server. Try again.');
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
        <p className="sub text-muted">Use your HKU Portal credentials to see live seat availability.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <form onSubmit={submit}>
          <div className="fields">
            <div className="field">
              <label className="field-label" htmlFor="uid">HKU Portal UID</label>
              <input className="input" id="uid" name="email" type="text" placeholder="u3xxxxxxx" autoComplete="username" required autoFocus />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="pin">PIN</label>
              <input className="input" id="pin" name="password" type="password" placeholder="••••••••" autoComplete="current-password" required />
            </div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="auth-links">
          <Link to={`/signup/?next=${encodeURIComponent(next)}`}>Create an account</Link>
          <span className="text-muted">HKU credentials only</span>
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
