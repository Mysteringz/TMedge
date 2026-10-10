import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountRequest, AccountRequestError, type AdminAccount, type AccountDeletion } from '../../entities/admin-account/index.ts';
import { permissionChanged, useAdminSession } from '../../entities/admin-session/index.tsx';

type Action = 'update' | 'password' | 'revoke' | 'delete';
const ROLE_HELP = { viewer: 'View operational data and your own training history. Cannot change settings or run jobs.', operator: 'Change algorithm settings, use routine sensor controls and run your own training jobs. Cannot manage firmware, advanced sensor controls or accounts.', engineer: 'Use all operational controls, including firmware and provisioning, and your own training jobs. Cannot manage accounts.', admin: 'Use all operational controls and manage accounts. Training access remains limited to your own jobs.' };
export function ManageAdminAccount({ account, onSaved, onDeleted, onCancel }: { account: AdminAccount | null; onSaved(account: AdminAccount): void; onDeleted(name: string): void; onCancel(): void }) {
  const session = useAdminSession();
  const [name, setName] = useState(account?.name ?? '');
  const [role, setRole] = useState<AdminAccount['role']>(account?.role ?? 'operator');
  const [disabled, setDisabled] = useState(account?.disabled ?? false);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState<Action | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [deleteName, setDeleteName] = useState(''), [deleteBlocked, setDeleteBlocked] = useState(false);
  const deleteInput = useRef<HTMLInputElement>(null), deleteTrigger = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocus = useRef(false);
  const form = useRef<HTMLFormElement>(null), heading = useRef<HTMLHeadingElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { heading.current?.focus(); return () => controller.current?.abort(); }, []);
  useEffect(() => { if (pending === 'delete') deleteInput.current?.focus(); else if (pending) confirmButton.current?.focus(); else if (restoreDeleteFocus.current) { restoreDeleteFocus.current = false; deleteTrigger.current?.focus(); } }, [pending]);
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
    if (action === 'delete' && (!account || deleteName !== account.name || deleteBlocked)) return;
    setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const suffix = !account ? '' : `/${encodeURIComponent(account.name)}${action === 'password' ? '/password-resets' : action === 'revoke' ? '/session-revocations' : ''}`;
      const body = !account ? { name, role, password } : action === 'update' ? { revision: account.revision, role, disabled } : action === 'password' ? { revision: account.revision, password } : { revision: account.revision };
      if (action === 'delete' && account) {
        const result = await accountRequest<AccountDeletion>(suffix, 'DELETE', body, abort.signal);
        clearPasswords(); setDeleteName(''); setPending(null);
        if (account.name === session?.user) { permissionChanged(401); return; }
        onDeleted(result.name); return;
      }
      const result = await accountRequest<AdminAccount>(suffix, action === 'update' ? 'PATCH' : 'POST', body, abort.signal);
      clearPasswords(); setPending(null);
      if (account && account.name === session?.user && result.revision !== account.revision) { permissionChanged(401); return; }
      onSaved(result);
    } catch (failure) {
      if (!abort.signal.aborted) {
        clearPasswords();
        if (action !== 'delete') setPending(null);
        const code = failure instanceof AccountRequestError ? failure.code : '';
        if (action === 'delete' && ['STALE_REVISION', 'NOT_FOUND', 'STORAGE_UNAVAILABLE', 'UNAVAILABLE'].includes(code || 'UNAVAILABLE')) { setDeleteName(''); setDeleteBlocked(true); }
        setError(action === 'delete' ? code === 'LAST_ADMIN' ? 'Keep at least one enabled admin. This account cannot be deleted.' : code === 'STALE_REVISION' ? 'This account changed. Refresh accounts before deleting it.' : code === 'NOT_FOUND' ? 'This account no longer exists.' : ['STORAGE_UNAVAILABLE', 'UNAVAILABLE', ''].includes(code) ? 'Could not confirm deletion. Refresh accounts before trying again.' : failure instanceof Error ? failure.message : 'Could not confirm deletion.' : failure instanceof Error ? failure.message : 'Could not save account.');
        if (failure instanceof AccountRequestError && failure.code === 'VALIDATION') form.current?.querySelector<HTMLInputElement>('input')?.focus();
      }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (pending || busy) return; setError(''); if (!account) { if (passwordsValid()) void perform('create'); } else setPending('update'); };
  const cancelDeletion = () => { restoreDeleteFocus.current = true; setDeleteName(''); setError(''); setPending(null); };
  const cancel = () => { clearPasswords(); setPending(null); onCancel(); };
  const passwordFields = <>
    <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required={!account} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint account-error" /></label>
    <label>Confirm password<input name="confirmation" type="password" autoComplete="new-password" maxLength={1024} required={!account} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="account-error" /></label>
    <p className="accounts-hint" id="account-password-hint">Use 12–1024 characters. Passwords are never displayed in the account list.</p>
  </>;
  return <section className="accounts-editor" aria-labelledby="account-editor-heading">
    <h2 id="account-editor-heading" tabIndex={-1} ref={heading}>{account ? `Manage ${account.name}` : 'Create account'}</h2>
    <form ref={form} onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy || !!pending}>
        <label>Username<input name="username" autoComplete="off" value={name} readOnly={!!account} required minLength={2} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{1,31}" onChange={(event) => setName(event.target.value)} aria-describedby="account-error" /></label>
        <label htmlFor="account-role">Role</label><select id="account-role" aria-describedby="account-role-help" value={role} onChange={(event) => setRole(event.target.value as AdminAccount['role'])}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="engineer">Engineer</option><option value="admin">Admin</option></select><p className="accounts-hint" id="account-role-help">{ROLE_HELP[role]}</p>
        {account && <label className="accounts-check"><input type="checkbox" checked={!disabled} onChange={(event) => setDisabled(!event.target.checked)} /> Enabled</label>}
        {passwordFields}
        <div className="accounts-actions"><button className="btn btn-primary" type="submit">{account ? 'Review role / status change' : 'Create account'}</button>
          {account && <><button className="btn btn-secondary" type="button" onClick={() => { if (passwordsValid()) setPending('password'); }}>Reset password</button><button className="btn btn-secondary" type="button" onClick={() => { clearPasswords(); setPending('revoke'); }}>Revoke all sessions</button></>}
        </div>
      </fieldset>
      {account && pending !== 'delete' && <button ref={deleteTrigger} type="button" className="btn accounts-delete" disabled={busy || !!pending} onClick={() => { clearPasswords(); setError(''); setDeleteName(''); setPending('delete'); }}>Delete account</button>}
      {pending === 'delete' && account && <div className="accounts-confirm accounts-confirm-delete" role="group" aria-labelledby="account-delete-heading" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); cancelDeletion(); } }}><h3 id="account-delete-heading">Delete account {account.name}?</h3><p id="account-delete-consequences">This permanently removes the account and ends its sessions. Submitted jobs continue. Training jobs, profiles and other operational data are retained. Reusing this username can give the new account access to its retained history.{account.name === session?.user && ' You will be signed out.'}</p><label>Type {account.name} to confirm<input ref={deleteInput} value={deleteName} disabled={busy || deleteBlocked} onChange={(event) => setDeleteName(event.target.value)} aria-describedby="account-delete-consequences account-delete-hint account-error" /></label><p className="accounts-hint" id="account-delete-hint">Enter the username exactly as shown.</p><div className="accounts-actions"><button type="button" className="btn accounts-delete" disabled={busy || deleteBlocked || deleteName !== account.name} onClick={() => void perform('delete')}>{busy ? 'Deleting...' : 'Delete account'}</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={cancelDeletion}>Cancel deletion</button></div></div>}
      {pending && pending !== 'delete' && <div className="accounts-confirm" role="group" aria-label="Confirm account action"><p><strong>{pending === 'update' ? `Change ${account?.name} to ${role}, ${disabled ? 'disabled' : 'enabled'}` : pending === 'password' ? `Reset password for ${account?.name}` : `Revoke all sessions for ${account?.name}`}?</strong></p><p>This ends current sessions. Submitted training jobs continue.</p><div className="accounts-actions"><button className="btn btn-primary" ref={confirmButton} type="button" disabled={busy} onClick={() => void perform(pending)}>{busy ? 'Saving…' : 'Confirm action'}</button><button className="btn btn-ghost" type="button" disabled={busy} onClick={() => { clearPasswords(); setPending(null); }}>Cancel action</button></div></div>}
      <p className="accounts-feedback accounts-error" id="account-error" role="alert">{error}</p>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={cancel}>Cancel editor</button>
    </form>
  </section>;
}
