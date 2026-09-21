/**
 * Create an account. Deliberately a different shape from sign-in -- a single
 * card on a plain field rather than the photographic split -- so nobody has
 * to read the heading to know the site changed screens.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { safeNext } from './Login.tsx';

export default function Signup() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(new URLSearchParams(location.search).get('next'));

  useEffect(() => {
    document.title = 'Create an account · HKUMySeat';
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (String(form.get('password')) !== String(form.get('confirm'))) {
      setError('The two PINs do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: form.get('email'), name: form.get('name'), password: form.get('password'), next,
        }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? 'That account could not be created.');
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
    <div className="signup">
      <div className="signup-card">
        <div className="brandline dark">
          <div className="mark" />
          <div className="name">HKUMySeat</div>
          <div className="bar" />
          <div className="uni">The University of Hong Kong</div>
        </div>
        <h1>Create an account</h1>
        <p className="sub text-muted">
          Your HKU Portal UID is your account. It takes a moment and then you can see every free seat on the pilot floors.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <form onSubmit={submit}>
          <div className="fields">
            <div className="field">
              <label className="field-label" htmlFor="name">Full name</label>
              <input className="input" id="name" name="name" type="text" placeholder="Chan Tai Man" autoComplete="name" maxLength={60} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="uid">HKU Portal UID</label>
              <input className="input" id="uid" name="email" type="text" placeholder="u3xxxxxxx" autoComplete="username" required />
            </div>
            <div className="two-up">
              <div className="field">
                <label className="field-label" htmlFor="pin">PIN (10+ characters)</label>
                <input className="input" id="pin" name="password" type="password" placeholder="••••••••" autoComplete="new-password" minLength={10} required />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="confirm">Confirm PIN</label>
                <input className="input" id="confirm" name="confirm" type="password" placeholder="••••••••" autoComplete="new-password" minLength={10} required />
              </div>
            </div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        </form>
        <hr className="hr" />
        <div className="signup-foot">
          <span className="text-muted">Already have an account?</span>
          <Link to={`/login/?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </div>
      </div>
    </div>
  );
}
