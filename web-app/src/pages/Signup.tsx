/**
 * Create an account. Deliberately a different shape from sign-in -- a single
 * card on a plain field rather than the photographic split -- so nobody has
 * to read the heading to know the site changed screens.
 *
 * The form asks for the HKU UID on its own, because the domain is not a
 * choice a student makes: `@connect.hku.hk` is printed beside the box and
 * joined on before the request leaves the browser. The server joins it again
 * from the raw UID, so a request that skips this page cannot invent an
 * address either.
 *
 * The password rules are the same list the server enforces
 * (src/shared/password-rules.ts), drawn as a live checklist. Each line turns
 * green by itself, so the form never has to say "your password is too weak".
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { GoogleButton } from '../GoogleButton.tsx';
import { Turnstile, turnstileOn, type TurnstileHandle } from '../Turnstile.tsx';
import { safeNext } from './Login.tsx';
import { STUDENT_EMAIL_DOMAIN } from '../../../src/shared/student-email.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_REQUIREMENTS, unmetPasswordRequirements } from '../../../src/shared/password-rules.js';

export default function Signup() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [human, setHuman] = useState<string | null>(null);
  const [uid, setUid] = useState('');
  const [password, setPassword] = useState('');
  const check = useRef<TurnstileHandle>(null);
  const next = safeNext(new URLSearchParams(location.search).get('next'));

  // The browser cannot be trusted to have assembled the address, so the page
  // checks the UID itself and the server checks it again from the same box.
  const uidOk = /^u\d{7}$/.test(uid.trim().toLowerCase());
  const unmet = useMemo(() => unmetPasswordRequirements(password), [password]);

  useEffect(() => {
    document.title = 'Create an account · HKUMySeat';
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (String(form.get('name')).trim() === '') {
      setError('Missing name');
      return;
    }
    if (!uidOk) {
      setError('UID does not match the required format (e.g. u3123456)');
      return;
    }
    if (String(form.get('password')) !== String(form.get('confirm'))) {
      setError('Confirmed password does not match');
      return;
    }
    if (unmet.length > 0) {
      setError(`Password does not fulfill requirements`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${uid.trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`,
          name: form.get('name'), password: form.get('password'), next,
          'cf-turnstile-response': human,
        }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? 'That account could not be created.');
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
    <div className="signup">
      <div className="signup-card">
        <div className="brandline dark">
          <div className="mark" />
          <div className="name">HKUMySeat</div>
          <div className="bar" />
          <div className="uni">The University of Hong Kong</div>
        </div>
        <h1>Create an account</h1>
        {error && <p className="form-error" role="alert">{error}</p>}
        {/* The UID form and the password checklist are enforced here and on the
            server. Turning the browser's own popups off keeps one voice:
            the form-error line below the heading. */}
        <form onSubmit={submit} noValidate>
          <div className="fields">
            <div className="field">
              <label className="field-label" htmlFor="name">Full name</label>
              <input className="input" id="name" name="name" type="text" placeholder="Chan Tai Man" autoComplete="name" maxLength={60} required />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="uid">HKU UID</label>
              <div className="input-split" data-uid={uid === '' ? 'empty' : uidOk ? 'ok' : 'bad'}>
                <input
                  className="input-split-field"
                  id="uid"
                  name="uid"
                  type="text"
                  placeholder="u3123456"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={8}
                  value={uid}
                  onChange={(e) => setUid(e.target.value.replace(/\s/g, ''))}
                  aria-describedby="uid-hint"
                  required
                />
                <span className="input-suffix">@{STUDENT_EMAIL_DOMAIN}</span>
              </div>
            </div>
            <div className="two-up">
              <div className="field">
                <label className="field-label" htmlFor="pin">Password</label>
                <input
                  className="input" id="pin" name="password" type="password" maxLength={PASSWORD_MAX_LENGTH}
                  placeholder="••••••••" autoComplete="new-password"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="pin-rules" required
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="confirm">Confirm password</label>
                {/* The ceiling is the same one the server enforces, so the field
                    stops accepting characters rather than letting the student
                    discover the limit by being refused. */}
                <input className="input" id="confirm" name="confirm" type="password" maxLength={PASSWORD_MAX_LENGTH} placeholder="••••••••" autoComplete="new-password" required />
              </div>
            </div>
          </div>

          <ul className="pw-rules" id="pin-rules">
            {PASSWORD_REQUIREMENTS.map((requirement) => {
              const met = !unmet.includes(requirement);
              return (
                <li key={requirement.id} className={met ? 'met' : ''}>
                  <span className="tick" aria-hidden="true" />
                  {requirement.label}
                  <span className="sr-only">{met ? ' — met' : ' — not met yet'}</span>
                </li>
              );
            })}
          </ul>

          <Turnstile ref={check} action="signup" onToken={setHuman} />
          <button className="btn btn-primary" type="submit" disabled={busy || (turnstileOn && !human)}>{busy ? 'Creating…' : 'Create account'}</button>
        </form>
        <GoogleButton next={next} />
        <hr className="hr" />
        <div className="signup-foot">
          <Link to={`/login/?next=${encodeURIComponent(next)}`}>Sign in with an existing account</Link>
        </div>
      </div>
    </div>
  );
}
