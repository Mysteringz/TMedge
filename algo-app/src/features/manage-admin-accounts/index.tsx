import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountRequest, AccountRequestError, type AdminAccount } from '../../entities/admin-account/index.ts';
import { permissionChanged, useAdminSession } from '../../entities/admin-session/index.tsx';

type Action = 'update' | 'password' | 'revoke';
export function ManageAdminAccount({ account, onSaved, onCancel }: { account: AdminAccount | null; onSaved(account: AdminAccount): void; onCancel(): void }) {
  const session = useAdminSession();
  const [name, setName] = useState(account?.name ?? '');
  const [role, setRole] = useState<AdminAccount['role']>(account?.role ?? 'engineer');
  const [disabled, setDisabled] = useState(account?.disabled ?? false);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState<Action | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null), heading = useRef<HTMLHeadingElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { heading.current?.focus(); return () => controller.current?.abort(); }, []);
  useEffect(() => { if (pending) confirmButton.current?.focus(); }, [pending]);
  const clearPasswords = () => { setPassword(''); setConfirmation(''); };
  const passwordsValid = () => {
    if (password.length < 12 || password.length > 1024 || password !== confirmation) {
      setError(password !== confirmation ? 'Passwords must match.' : 'Password must be 12–1024 characters.');
      form.current?.querySelector<HTMLInputElement>('input[type=password]')?.focus(); return false;
    }
    return true;
  };
  const perform = async (action: Action | 'create') => {
    if (busy) return;
    setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const suffix = !account ? '' : `/${encodeURIComponent(account.name)}${action === 'password' ? '/password-resets' : action === 'revoke' ? '/session-revocations' : ''}`;
      const body = !account ? { name, role, password } : action === 'update' ? { revision: account.revision, role, disabled } : action === 'password' ? { revision: account.revision, password } : { revision: account.revision };
      const result = await accountRequest<AdminAccount>(suffix, action === 'update' ? 'PATCH' : 'POST', body, abort.signal);
      clearPasswords(); setPending(null);
      if (account && account.name === session?.user && result.revision !== account.revision) { permissionChanged(401); return; }
      onSaved(result);
    } catch (failure) {
      if (!abort.signal.aborted) {
        clearPasswords(); setPending(null);
        setError(failure instanceof Error ? failure.message : 'Could not save account.');
        if (failure instanceof AccountRequestError && failure.code === 'VALIDATION') form.current?.querySelector<HTMLInputElement>('input')?.focus();
      }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); setError(''); if (!account) { if (passwordsValid()) void perform('create'); } else setPending('update'); };
  const cancel = () => { clearPasswords(); setPending(null); onCancel(); };
  const passwordFields = <>
    <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required={!account} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint account-error" /></label>
    <label>Confirm password<input name="confirmation" type="password" autoComplete="new-password" maxLength={1024} required={!account} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="account-error" /></label>
    <p id="account-password-hint">Use 12–1024 characters. Passwords are never displayed in the account list.</p>
  </>;
  return <section className="accounts-editor" aria-labelledby="account-editor-heading">
    <h2 id="account-editor-heading" tabIndex={-1} ref={heading}>{account ? `Manage ${account.name}` : 'Create account'}</h2>
    <form ref={form} onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy || !!pending}>
        <label>Username<input name="username" autoComplete="off" value={name} readOnly={!!account} required minLength={2} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,31}" onChange={(event) => setName(event.target.value)} aria-describedby="account-error" /></label>
        <label htmlFor="account-role">Role</label><select id="account-role" value={role} onChange={(event) => setRole(event.target.value as AdminAccount['role'])}><option value="viewer">Viewer</option><option value="engineer">Engineer</option><option value="admin">Admin</option></select>
        {account && <label className="accounts-check"><input type="checkbox" checked={!disabled} onChange={(event) => setDisabled(!event.target.checked)} /> Enabled</label>}
        {passwordFields}
        <div className="accounts-actions"><button type="submit">{account ? 'Review role / status change' : 'Create account'}</button>
          {account && <><button type="button" onClick={() => { if (passwordsValid()) setPending('password'); }}>Reset password</button><button type="button" onClick={() => { clearPasswords(); setPending('revoke'); }}>Revoke all sessions</button></>}
        </div>
      </fieldset>
      {pending && <div className="accounts-confirm" role="group" aria-label="Confirm account action"><p><strong>{pending === 'update' ? `Change ${account?.name} to ${role}, ${disabled ? 'disabled' : 'enabled'}` : pending === 'password' ? `Reset password for ${account?.name}` : `Revoke all sessions for ${account?.name}`}?</strong></p><p>This ends current sessions. Submitted training jobs continue.</p><div className="accounts-actions"><button ref={confirmButton} type="button" disabled={busy} onClick={() => void perform(pending)}>{busy ? 'Saving…' : 'Confirm action'}</button><button type="button" disabled={busy} onClick={() => { clearPasswords(); setPending(null); }}>Cancel action</button></div></div>}
      <p id="account-error" role="alert">{error}</p>
      <button type="button" disabled={busy} onClick={cancel}>Cancel editor</button>
    </form>
  </section>;
}
