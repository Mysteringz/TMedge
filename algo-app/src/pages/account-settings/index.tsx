/**
 * A person's own account: who they are here, the address they can be reached
 * at, their password and their sessions. Every role has this page, and it
 * only ever shows the account of whoever is signed in.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { permissionChanged } from '../../entities/admin-session/index.tsx';
import { EMAIL_TOPICS, ownAccount, type OwnAccount } from '../../entities/own-account/index.ts';
import { teamRoleText } from '../../entities/workspace/model/types.ts';
import './account-settings.css';

const failure = (error: unknown): string => error instanceof Error ? error.message : 'Account settings are unavailable.';
const roleName = (role: string): string => role.charAt(0).toUpperCase() + role.slice(1);

export function AccountSettings() {
  const [account, setAccount] = useState<OwnAccount | null>(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void ownAccount<OwnAccount>('', 'GET', undefined, controller.signal).then((value) => { if (!controller.signal.aborted) setAccount(value); })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(failure(error)); });
    return () => controller.abort();
  }, []);

  return <main className="cx-train acct-page">
    <h1>Account settings</h1>
    <p className="acct-lead">Your own account. Nobody else sees this page, whatever their role.</p>
    {loadError && <p className="acct-feedback acct-error" role="alert">{loadError}</p>}
    {!account && !loadError && <p className="acct-feedback" role="status" aria-busy="true">Loading your account…</p>}
    {account && <>
      <Profile account={account} />
      {account.namedAccount
        ? <><EmailSettings account={account} onSaved={setAccount} /><Password /><Sessions /></>
        : <p className="acct-feedback" role="status">Sign-in is off on this server, so there is one local operator and no account to keep settings for.</p>}
    </>}
  </main>;
}

function Profile({ account }: { account: OwnAccount }) {
  return <section className="acct-card" aria-labelledby="acct-profile">
    <h2 id="acct-profile">Profile</h2>
    <dl className="acct-facts">
      <div><dt>Username</dt><dd>{account.name}</dd></div>
      <div><dt>Access</dt><dd>{account.namedAccount ? roleName(account.role) : 'Local operator'}</dd></div>
      {account.namedAccount && <div><dt>Works on</dt><dd>{teamRoleText(account.teamRoles) || 'Not set'}</dd></div>}
      {account.namedAccount && <div><dt>Account created</dt><dd>{new Date(account.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</dd></div>}
    </dl>
    {account.namedAccount && <p className="acct-hint">An admin sets your username, access and what you work on.</p>}
  </section>;
}

function EmailSettings({ account, onSaved }: { account: OwnAccount; onSaved(account: OwnAccount): void }) {
  const [email, setEmail] = useState(account.settings.email ?? '');
  const [notify, setNotify] = useState<string[]>(account.settings.notify);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const saved = account.settings.email;
  const typed = email.trim();
  const changed = typed !== (saved ?? '') || notify.length !== account.settings.notify.length || notify.some((topic) => !account.settings.notify.includes(topic));

  async function save(next: { email: string | null; notify: string[] }, done: string) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const value = await ownAccount<OwnAccount>('/settings', 'PUT', next);
      onSaved(value); setEmail(value.settings.email ?? ''); setNotify(value.settings.notify); setMessage(done);
    } catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void save({ email: typed || null, notify: typed ? notify : [] }, typed ? 'Email settings saved.' : 'Email address removed.'); };

  return <section className="acct-card" aria-labelledby="acct-email">
    <h2 id="acct-email">Email notifications</h2>
    <form onSubmit={submit}>
      <label className="acct-field">Email address
        <input type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} placeholder="name@example.com" value={email} disabled={busy}
          onChange={(event) => { setEmail(event.target.value); setMessage(''); setError(''); }} />
      </label>
      {account.emailDelivery
        ? <p className="acct-hint">The console emails this address about what you tick below. Only you can see it.</p>
        : <p className="acct-note" role="note">This server is not set up to send email yet. Your address and choices are saved, and nothing is sent until it is.</p>}
      <fieldset className="acct-topics" disabled={busy || !typed}>
        <legend>Email me when</legend>
        {EMAIL_TOPICS.map((topic) => <label key={topic.id} className="acct-check">
          <input type="checkbox" checked={notify.includes(topic.id)} onChange={(event) => { setNotify(event.target.checked ? [...notify, topic.id] : notify.filter((id) => id !== topic.id)); setMessage(''); }} />
          <span>{topic.label}<small>{topic.detail}</small></span>
        </label>)}
      </fieldset>
      {!typed && <p className="acct-hint">Enter an address to choose what it receives.</p>}
      <p className="acct-feedback acct-success" role="status">{message}</p>
      <p className="acct-feedback acct-error" role="alert">{error}</p>
      <div className="acct-actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save email settings'}</button>
        {saved && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void save({ email: null, notify: [] }, 'Email address removed.')}>Remove address</button>}
      </div>
    </form>
  </section>;
}

function Password() {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const problem = next && next.length < 12 ? 'Use at least 12 characters.' : again && again !== next ? 'The two new passwords do not match.' : next && next === current ? 'Choose a password different from the current one.' : '';
  const ready = !!current && next.length >= 12 && again === next && next !== current;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await ownAccount('/password', 'POST', { current, password: next });
      setCurrent(''); setNext(''); setAgain('');
      setMessage('Password changed. You are still signed in here; every other device has been signed out.');
    } catch (failed) { setError(failure(failed)); }
    finally { setBusy(false); }
  }

  return <section className="acct-card" aria-labelledby="acct-password">
    <h2 id="acct-password">Password</h2>
    <form onSubmit={(event) => void submit(event)}>
      <label className="acct-field">Current password
        <input type="password" autoComplete="current-password" maxLength={1024} value={current} disabled={busy} onChange={(event) => setCurrent(event.target.value)} /></label>
      <label className="acct-field">New password
        <input type="password" autoComplete="new-password" maxLength={1024} value={next} disabled={busy} onChange={(event) => setNext(event.target.value)} /></label>
      <label className="acct-field">New password again
        <input type="password" autoComplete="new-password" maxLength={1024} value={again} disabled={busy} onChange={(event) => setAgain(event.target.value)} /></label>
      <p className="acct-hint">At least 12 characters. Changing it signs you out everywhere else, and ends any TMflash app session on this account.</p>
      <p className="acct-feedback acct-error" role="alert">{error || problem}</p>
      <p className="acct-feedback acct-success" role="status">{message}</p>
      <div className="acct-actions"><button className="btn btn-primary" type="submit" disabled={busy || !ready}>{busy ? 'Changing…' : 'Change password'}</button></div>
    </form>
  </section>;
}

function Sessions() {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function endAll() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await ownAccount('/session-revocations', 'POST', {});
      // This session went with the rest: the shell takes it from here.
      permissionChanged(401);
    } catch (failed) { setError(failure(failed)); setBusy(false); }
  }
  return <section className="acct-card" aria-labelledby="acct-sessions">
    <h2 id="acct-sessions">Sessions</h2>
    <p>A sign-in lasts 12 hours. If you left one open somewhere, or lost a device, end them all.</p>
    <p className="acct-feedback acct-error" role="alert">{error}</p>
    {confirming
      ? <div className="acct-confirm" role="group" aria-label="Sign out everywhere">
        <p>This signs you out on every device, this one included, and ends any TMflash app session on this account. You will sign in again.</p>
        <div className="acct-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void endAll()}>{busy ? 'Signing out…' : 'Yes, sign out everywhere'}</button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>
      : <div className="acct-actions"><button className="btn btn-secondary" onClick={() => setConfirming(true)}>Sign out everywhere</button></div>}
  </section>;
}
