import { useEffect, useRef, useState } from 'react';
import { navigate } from './router.ts';
import './adoption.css';

async function authorize(challenge: string, state: string): Promise<string> {
  const response = await fetch('/api/tmflash/authorize', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, body: JSON.stringify({ challenge, state }),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The console returned a sign-in page. Start again from TMflash.');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') throw new Error('Could not verify the TMflash sign-in.');
  if (!response.ok) throw new Error('error' in body && typeof body.error === 'string' ? body.error : 'Could not verify the TMflash sign-in.');
  if (!('redirect' in body) || typeof body.redirect !== 'string') throw new Error('Invalid TMflash return address.');
  const callback = new URL(body.redirect);
  if (callback.protocol !== 'hk.hkumyseat.tmflash:' || callback.hostname !== 'login' || callback.pathname || callback.username || callback.password || callback.port || callback.hash
    || [...callback.searchParams].length !== 2 || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state
    || callback.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(callback.searchParams.get('code') ?? '')) throw new Error('Invalid TMflash return address.');
  return callback.toString();
}

export function TMflashConnect({ user }: { user: string }) {
  const query = new URLSearchParams(location.search);
  const challenge = query.get('challenge') ?? '', state = query.get('state') ?? '';
  const valid = query.getAll('challenge').length === 1 && query.getAll('state').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(challenge) && /^[A-Za-z0-9_-]{43}$/.test(state);
  const [busy, setBusy] = useState(valid), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [handoff, setHandoff] = useState<{ url: string; expiresAt: number } | null>(null);
  const request = useRef<{ challenge: string; state: string; attempt: number; result: Promise<string> } | null>(null);

  useEffect(() => {
    if (!valid) return;
    let gone = false;
    setBusy(true); setError(''); setHandoff(null);
    // StrictMode can mount an effect twice. Reuse the same one-use code
    // request rather than authorizing a second sign-in or losing its result.
    if (!request.current || request.current.challenge !== challenge || request.current.state !== state || request.current.attempt !== attempt) {
      request.current = { challenge, state, attempt, result: authorize(challenge, state) };
    }
    void request.current.result.then(url => {
      if (gone) return;
      setHandoff({ url, expiresAt: Date.now() + 55_000 });
      location.assign(url);
    }).catch(cause => {
      if (!gone) setError(cause instanceof Error ? cause.message : 'Could not reach the console.');
    }).finally(() => { if (!gone) setBusy(false); });
    return () => { gone = true; };
  }, [valid, challenge, state, attempt]);

  function returnToApp() {
    if (handoff && handoff.expiresAt > Date.now()) location.assign(handoff.url);
    else setAttempt(value => value + 1);
  }
  function cancel() {
    if (!valid) { navigate('/adoption'); return; }
    const callback = new URL('hk.hkumyseat.tmflash://login');
    callback.searchParams.set('error', 'cancelled'); callback.searchParams.set('state', state);
    location.assign(callback.toString());
  }
  return <main className="cx-adoption">
    <p className="cx-eyebrow">TMflash · Account verification</p><h1>Connect TMflash</h1>
    <section className="ad-panel">
      <h2>Signed in as {user}</h2>
      {valid && <p className="ad-notice" role="status">{busy ? 'Completing sign-in… TMflash will open automatically.' : handoff ? 'Returning to TMflash… If this window stays open, click Return to TMflash.' : 'Sign-in could not finish. Retry to return to TMflash.'}</p>}
      <p>This Mac's access lasts 24 hours and lets TMflash queue new devices for adoption and check their approval status.</p>
      <p>Device approval requires your signed-in console account and the UID and request code from the physical board. You can revoke this Mac's access in Adoption.</p>
      {!valid && <p className="ad-error" role="alert">This sign-in request is invalid. Start again from TMflash.</p>}
      {error && <p className="ad-error" role="alert">{error}</p>}
      <div className="ad-match"><button className="ad-primary" disabled={!valid || busy} onClick={returnToApp}>{busy ? 'Connecting…' : handoff ? 'Return to TMflash' : 'Retry connection'}</button><button disabled={busy} onClick={cancel}>{valid ? 'Cancel' : 'Back to Adoption'}</button></div>
    </section>
  </main>;
}
