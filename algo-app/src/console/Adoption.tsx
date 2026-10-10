import { useCallback, useEffect, useRef, useState } from 'react';
import { useCapability } from '../entities/admin-session/index.tsx';
import './adoption.css';

interface JoinRequest { id: string; uid: string; label: string; firmware: string | null; from: string; at: number; expiresAt: number; pairingCode: string }
interface FlasherToken { id: string; label: string; by: string; expiresAt: number }
interface AdoptedNode { uid: string; label: string; placed: boolean; verified: boolean; online: boolean; reports: number; fps: number | null; lastSeen: number | null; firmware: string | null }
interface AdoptionView { ready: boolean; enabled: boolean; legacyToken: boolean; requests: JoinRequest[]; tokens: FlasherToken[]; nodes: AdoptedNode[] }
const dateOf = (at: number) => new Date(at).toLocaleString();
const errorOf = (error: unknown) => error instanceof Error ? error.message : 'Could not reach the adoption service.';

async function api<T>(path = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/adoption${path}`, body === undefined ? { signal } : {
    method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, body: JSON.stringify(body),
  });
  if (response.status === 401) {
    location.assign('/login?next=%2Fadoption');
    throw new Error('Sign in again to continue.');
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `The adoption service returned HTTP ${response.status}.`);
  }
  return await response.json() as T;
}

export function Adoption() {
  const canCommission = useCapability('nodes.admin');
  const [view, setView] = useState<AdoptionView | null>(null);
  const [statusError, setStatusError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api<AdoptionView>('', undefined, signal);
    if (!signal?.aborted && mounted.current) { setView(result); setStatusError(''); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setStatusError(errorOf(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setActionError(''); setNotice('');
    try { await work(); await refresh(); }
    catch (error) { if (mounted.current) setActionError(errorOf(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const actionable = canCommission && !!view && !statusError && !busy;
  return <main className="cx-adoption">
    <p className="cx-eyebrow">Module 06 · Device commissioning</p>
    <h1>Adoption</h1>
    {!canCommission && <p className="ad-hint" role="status">Read-only adoption access. Engineer or Admin access is required to commission devices and authorize TMflash.</p>}
    <p className="ad-lead">Bring a physical sensor online, verify its reports, then place it in the floor plan.</p>
    <ol className="ad-steps"><li>Sign in on TMflash</li><li>Flash the device</li><li>Match and approve</li><li>Verify reports</li></ol>
    {statusError && <p className="ad-error" role="alert">{statusError} Approval is unavailable until the connection recovers.</p>}
    {actionError && <p className="ad-error" role="alert">{actionError}</p>}
    {notice && <p className="ad-notice" role="status">{notice}</p>}
    {view && !view.ready && <p className="ad-error" role="alert">Persistent node storage is unavailable. Ask the server administrator to fix registration storage before flashing.</p>}
    <section className="ad-panel" aria-labelledby="flasher-heading">
      <h2 id="flasher-heading">TMflash sign-in</h2>
      <p>Set TMflash's console URL to <code>https://algo.hkumyseat.com</code> and click <b>Sign in with algo account</b>. Complete the browser sign-in; verification returns you to TMflash automatically.</p>
      <p className="ad-hint">The server verifies the account on every provisioning request. Access lasts 24 hours and is kept in the Mac's Keychain. Sign out in TMflash or revoke a session here to end access. Password changes and account removal also invalidate it.</p>
      {view?.legacyToken && <p className="ad-hint">The server also accepts its configured legacy token. Rotate that token through server configuration.</p>}
      <ul className="ad-token-list">{view?.tokens.map(token => <li key={token.id}>
        <span><b>{token.label}</b><small>Created by {token.by} · Expires {dateOf(token.expiresAt)}</small></span>
        <button disabled={!actionable} onClick={() => void act(async () => {
          await api(`/tokens/${encodeURIComponent(token.id)}/revoke`, {});
          setNotice('TMflash session revoked.');
        })}>Revoke</button>
      </li>)}</ul>
      {view && !view.tokens.length && <p className="ad-hint">No active TMflash sessions.</p>}
    </section>
    <section className="ad-panel" aria-labelledby="pending-heading">
      <h2 id="pending-heading">Pending devices <span className="ad-count">{view?.requests.length ?? '—'}</span></h2>
      <p>Compare the UID and request code with TMflash on the computer connected to the board. Approve only the device you recognise.</p>
      {!view ? <p>Loading adoption requests…</p> : !view.requests.length ? <p className="ad-hint">No requests waiting. Flash a new device with adoption enabled in TMflash.</p> : view.requests.map(request => <RequestCard key={request.id} request={request} disabled={!actionable || !view.ready}
        resolve={(verdict, uid, pairingCode) => void act(async () => {
          await api(`/requests/${encodeURIComponent(request.id)}/${verdict}`, { uid, pairingCode });
          setNotice(verdict === 'approve' ? `${request.uid} approved. Waiting for an authenticated report; the device is unplaced.` : `${request.uid} denied.`);
        })} />)}
    </section>
    <section className="ad-panel" aria-labelledby="verified-heading">
      <h2 id="verified-heading">Device verification</h2>
      <p>Verified means a fresh authenticated report reached TMedge. An approved device can affect seat counts only after it is placed.</p>
      <div className="ad-devices">{view?.nodes.map(node => <article className="ad-device" key={node.uid}>
        <div><h3>{node.label}</h3><code>{node.uid}</code></div>
        <span className={`ad-badge ${node.verified ? 'is-verified' : ''}`}>{node.verified ? 'Verified reports' : node.online ? 'Reports not verified' : 'Waiting for reports'}</span>
        <dl><div><dt>Installation</dt><dd>{node.placed ? 'Placed' : 'Unplaced'}</dd></div><div><dt>Accepted reports</dt><dd>{node.reports}</dd></div><div><dt>Rate</dt><dd>{node.fps == null ? '—' : `${node.fps.toFixed(1)} fps`}</dd></div><div><dt>Last seen</dt><dd>{node.lastSeen ? dateOf(node.lastSeen) : 'Never'}</dd></div></dl>
      </article>)}</div>
      {view && !view.nodes.length && <p className="ad-hint">No physical devices registered yet.</p>}
    </section>
  </main>;
}

function RequestCard({ request, disabled, resolve }: { request: JoinRequest; disabled: boolean; resolve(verdict: 'approve' | 'deny', uid: string, code: string): void }) {
  const [uid, setUID] = useState('');
  const [code, setCode] = useState('');
  return <article className="ad-request">
    <h3>{request.label}</h3><code className="ad-uid">{request.uid}</code>
    <dl><div><dt>Request code</dt><dd><code>{request.pairingCode}</code></dd></div><div><dt>Firmware</dt><dd>{request.firmware ?? 'Not reported'}</dd></div><div><dt>Requested</dt><dd>{dateOf(request.at)}</dd></div><div><dt>Expires</dt><dd>{dateOf(request.expiresAt)}</dd></div></dl>
    <div className="ad-match"><label>UID from TMflash<input aria-label={`UID from TMflash for ${request.uid}`} value={uid} onChange={e => setUID(e.target.value.toLowerCase())} placeholder="aa:bb:cc:dd:ee:ff" autoComplete="off" /></label>
      <label>Code from TMflash<input aria-label={`Code from TMflash for ${request.uid}`} value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={8} autoComplete="off" /></label>
      <button className="ad-primary" disabled={disabled || uid !== request.uid || code !== request.pairingCode} onClick={() => resolve('approve', uid, code)}>Approve device</button>
      <button disabled={disabled} onClick={() => resolve('deny', '', '')}>Deny</button></div>
  </article>;
}
