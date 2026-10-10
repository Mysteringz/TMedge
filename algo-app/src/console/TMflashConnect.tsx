import { useState } from 'react';
import { useCapability } from '../entities/admin-session/index.tsx';
import { navigate } from './router.ts';
import './adoption.css';

export function TMflashConnect({ user }: { user: string }) {
  const canCommission = useCapability('nodes.admin');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const query = new URLSearchParams(location.search);
  const challenge = query.get('challenge'), state = query.get('state');
  const valid = /^[A-Za-z0-9_-]{43}$/.test(challenge ?? '') && /^[A-Za-z0-9_-]{43}$/.test(state ?? '');
  function cancel() {
    if (!valid) { navigate('/adoption'); return; }
    const callback = new URL('hk.hkumyseat.tmflash://login');
    callback.searchParams.set('error', 'cancelled'); callback.searchParams.set('state', state ?? '');
    location.assign(callback.toString());
  }
  async function authorize() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/tmflash/authorize', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, body: JSON.stringify({ challenge, state }),
      });
      const body = await response.json() as { redirect?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not authorize TMflash.');
      const callback = new URL(body.redirect ?? '');
      if (callback.protocol !== 'hk.hkumyseat.tmflash:' || callback.hostname !== 'login') throw new Error('Invalid TMflash return address.');
      location.assign(callback.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the console.'); }
    finally { setBusy(false); }
  }
  return <main className="cx-adoption">
    <p className="cx-eyebrow">TMflash · Account verification</p><h1>Connect TMflash</h1>
    <section className="ad-panel">
      <h2>Sign in as {user}</h2>
      <p>Authorize the TMflash sign-in you just started on your Mac. It lasts 24 hours and lets the app queue new devices for adoption and check their approval status.</p>
      <p>Device approval requires your signed-in console account and the UID and request code from the physical board. You can revoke this Mac's access in Adoption.</p>
      {!valid && <p className="ad-error" role="alert">This sign-in request is invalid. Start again from TMflash.</p>}
      {error && <p className="ad-error" role="alert">{error}</p>}
      {!canCommission && <p role="status">Engineer or Admin access is required to authorize TMflash.</p>}
      <div className="ad-match"><button className="ad-primary" disabled={!canCommission || !valid || busy} onClick={() => void authorize()}>{busy ? 'Connecting…' : 'Authorize TMflash'}</button><button disabled={busy} onClick={cancel}>Cancel</button></div>
    </section>
  </main>;
}
