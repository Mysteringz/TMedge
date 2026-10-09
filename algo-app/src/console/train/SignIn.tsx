/**
 * Signing in to HKU for one action (Plan A). The PIN and code are sealed here,
 * in the browser, to a key the console made for this one use
 * (src/shared/hpcseal.ts), and the fields are emptied before anything leaves
 * the page. The server opens the seal into bytes, uses them for one VPN and
 * SSH login, and wipes them; the session that results serves the next ten
 * minutes without asking again.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { packCredentials, sealCredentials, type Sealed } from '../../../../src/shared/hpcseal.js';
import { ArrowRight, XMark } from '../icons.tsx';
import { train, type HpcState, type SignInAction } from './api.ts';

export interface SignInProps {
  hpc: HpcState;
  action: SignInAction;
  jobId: string | null;
  jobName: string | null;
  onCancel(): void;
  /** Called with the sealed credentials and the (non-secret) rest. */
  onSealed(body: { sealed: Sealed; profile: { hkuUid: string; vpnDomain: string }; passwordChanged: boolean }): void;
}

const VERB: Record<SignInAction, string> = { submit: 'Sign in and send', refresh: 'Sign in and refresh', cancel: 'Sign in and cancel', connect: 'Sign in' };

export function SignIn({ hpc, action, jobId, jobName, onCancel, onSealed }: SignInProps) {
  const [uid, setUid] = useState(hpc.profile?.hkuUid ?? '');
  const [domain, setDomain] = useState(hpc.profile?.vpnDomain ?? hpc.domains[0] ?? 'hku.hk');
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [separate, setSeparate] = useState(false);
  const [hpcPw, setHpcPw] = useState('');
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // Once per opening. The parent re-renders every few seconds (session
  // polling) with a new onCancel; depending on it re-ran this and emptied the
  // PIN while someone was still reading the code off their phone.
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel.current(); };
    window.addEventListener('keydown', onKey);
    // Leaving, by any route, empties the fields.
    return () => { window.removeEventListener('keydown', onKey); setPin(''); setOtp(''); setHpcPw(''); };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[a-z0-9]{2,32}$/.test(uid)) return setError('your HKU UID: lowercase letters and digits, without @hku.hk');
    if (!pin) return setError('your Portal PIN');
    if (!/^\d{6,8}$/.test(otp)) return setError('the 6-digit code from Microsoft Authenticator or SMS');
    if (hpc.ssh?.auth === 'shared-password' && !hpcPw) return setError(`the password for ${hpc.ssh.user ?? ''}@${hpc.ssh.host}`);
    setBusy(true);
    setError('');
    try {
      const ticket = await train.ticket();
      const enc = new TextEncoder();
      const p = enc.encode(pin), o = enc.encode(otp), w = enc.encode(shared || separate ? hpcPw : '');
      setPin(''); setOtp(''); setHpcPw('');
      const plain = packCredentials(p, o, w);
      p.fill(0); o.fill(0); w.fill(0);
      onSealed({ sealed: await sealCredentials(ticket, action, jobId, plain), profile: { hkuUid: uid, vpnDomain: domain }, passwordChanged: shared && changed });
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };

  const locked = hpc.lockedForSeconds > 0;
  const shared = hpc.ssh?.auth === 'shared-password';
  const target = hpc.ssh ? `${hpc.ssh.user ?? (uid || 'you')}@${hpc.ssh.host}` : 'the cluster';
  return (
    <div className="cx-modal-back" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form className="card cx-modal" role="dialog" aria-modal="true" aria-labelledby="hku-title" onSubmit={submit} autoComplete="off">
        <div className="cx-card-head">
          <span id="hku-title" className="cx-kicker" style={{ margin: 0 }}>HKU sign-in</span>
          <button type="button" className="btn btn-ghost cx-icon" onClick={onCancel} aria-label="Close"><XMark /></button>
        </div>
        <p className="cx-modal-lede">
          {action === 'connect'
            ? <>Sign in to HKUVPN as yourself to open a shell on <b>{target}</b>.</>
            : <>Sign in to HKUVPN as yourself to {action === 'submit' ? 'send' : action} <b>{jobName}</b> on <b>{target}</b>.</>}
        </p>
        {(hpc.firstUse.hostKey || (shared && hpc.firstUse.password)) && (
          <p className="cx-hint cx-modal-first">
            First sign-in to this cluster:{hpc.firstUse.hostKey ? ' you will be shown its host key to confirm before anything logs in.' : ''}
            {shared && hpc.firstUse.password ? ` The cluster checks the ${hpc.ssh?.user ?? ''} password itself this once, and its fingerprint is kept for next time.` : ''}
          </p>
        )}
        <div className="cx-modal-uid">
          <div className="field">
            <label htmlFor="hku-uid">HKU UID</label>
            <input id="hku-uid" ref={hpc.profile ? undefined : first} className="input" value={uid} spellCheck={false} autoCapitalize="none"
              placeholder="e.g. tmchan" onChange={(e) => setUid(e.target.value.trim().toLowerCase())} />
          </div>
          <div className="field">
            <label>VPN login</label>
            <div className="seg">
              {hpc.domains.map((d) => (
                <label key={d} className="seg-opt"><input type="radio" name="hku-domain" checked={domain === d} onChange={() => setDomain(d)} />@{d}</label>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="hku-pin">Portal PIN</label>
          <input id="hku-pin" ref={hpc.profile ? first : undefined} className="input" type="password" value={pin} name="hku-pin"
            autoComplete="off" onChange={(e) => setPin(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="hku-otp">One-time code</label>
          <input id="hku-otp" className="input cx-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp}
            placeholder="from Microsoft Authenticator or SMS" onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
        </div>
        {shared ? (
          <>
            <div className="field">
              <label htmlFor="hku-hpcpw">Password for {target}</label>
              <input id="hku-hpcpw" className="input" type="password" value={hpcPw} autoComplete="off" onChange={(e) => setHpcPw(e.target.value)} />
            </div>
            {!hpc.firstUse.password && (
              <label className="cx-check" title="After a passwd on the cluster: it checks this password itself, once, and its fingerprint is replaced">
                <input type="checkbox" checked={changed} onChange={(e) => setChanged(e.target.checked)} /> The cluster password has changed
              </label>
            )}
          </>
        ) : (
          <>
            <label className="cx-check">
              <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} /> My cluster password is not my Portal PIN
            </label>
            {separate && (
              <div className="field">
                <label htmlFor="hku-hpcpw">Cluster password</label>
                <input id="hku-hpcpw" className="input" type="password" value={hpcPw} autoComplete="off" onChange={(e) => setHpcPw(e.target.value)} />
              </div>
            )}
          </>
        )}
        <p className="cx-hint cx-modal-note">
          Sealed in this browser for this one action. The console uses it once to open your own HKUVPN tunnel and the
          SSH login to {target}, then wipes it: never stored, never logged.{shared ? ' The cluster password is checked against a fingerprint first, so a typo is caught before anything connects.' : ''}{' '}
          One attempt only: a wrong PIN is not retried, and three failures pause sign-ins for 15 min to protect your HKU
          account. You stay signed in for {Math.round(hpc.idleTtlSeconds / 60)} min after last use.
        </p>
        {locked && <div className="cx-error">! sign-ins paused for {Math.ceil(hpc.lockedForSeconds / 60)} min after three failures</div>}
        {error && <div className="cx-error" role="alert">! {error}</div>}
        <div className="cx-modal-actions">
          <button type="button" className="btn btn-secondary cx-btn-px" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary cx-btn-px" disabled={busy || locked}>
            {busy ? 'Sealing…' : VERB[action]}<ArrowRight />
          </button>
        </div>
      </form>
    </div>
  );
}
