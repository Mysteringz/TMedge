import { useEffect, useRef, useState } from 'react';
import { accountRequest, type AccountList, type AdminAccount } from '../../entities/admin-account/index.ts';
import { useAdminSession } from '../../entities/admin-session/index.tsx';
import { ManageAdminAccount } from '../../features/manage-admin-accounts/index.tsx';
import './accounts.css';

export function Accounts() {
  const session = useAdminSession();
  const [list, setList] = useState<AccountList | null>(null), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [selection, setSelection] = useState<AdminAccount | null | undefined>(undefined);
  const createButton = useRef<HTMLButtonElement>(null), origin = useRef<HTMLButtonElement | null>(null);
  const allowed = !!session?.namedAccount && session.capabilities.includes('accounts.manage');
  useEffect(() => {
    if (!allowed) { setList(null); setSelection(undefined); return; }
    const controller = new AbortController(); setLoading(true); setError('');
    void accountRequest<AccountList>(`?offset=${offset}&limit=25`, 'GET', undefined, controller.signal).then((result) => { if (!controller.signal.aborted) setList(result); }).catch((failure) => { if (!controller.signal.aborted) { setList(null); setError(failure instanceof Error ? failure.message : 'Account list unavailable.'); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [allowed, offset, refresh]);
  const closeEditor = () => { setSelection(undefined); (origin.current ?? createButton.current)?.focus(); };
  if (!session?.namedAccount) return <main className="cx-train"><h1>Accounts</h1><p>Account management is unavailable in local mode. Use the account CLI.</p></main>;
  if (!allowed) return <main className="cx-train"><h1>Accounts</h1><p>Admin access required.</p><a href="/">Home</a></main>;
  return <main className="cx-train accounts-page"><h1>Accounts</h1><p>Manage named accounts and their access. Usernames stay fixed.</p>
    <p role="status">{message}</p><p role="alert">{error}</p>
    <div className="accounts-actions"><button ref={createButton} onClick={() => { origin.current = createButton.current; setSelection(null); }}>Create account</button><button onClick={() => { closeEditor(); setRefresh((value) => value + 1); }}>Refresh accounts</button></div>
    {selection !== undefined && <ManageAdminAccount key={selection?.name ?? 'create'} account={selection} onCancel={closeEditor} onSaved={(account) => { setMessage(`Account ${account.name} saved.`); closeEditor(); setRefresh((value) => value + 1); }} onDeleted={(name) => { setMessage(`Account ${name} deleted.`); setSelection(undefined); origin.current = null; createButton.current?.focus(); if (list?.accounts.length === 1 && offset > 0) setOffset(Math.max(0, offset - 25)); else setRefresh((value) => value + 1); }} />}
    {loading && <p role="status" aria-busy="true">Loading accounts…</p>}
    {!loading && list && (list.accounts.length ? <div className="accounts-table-wrap"><table><caption>Named accounts</caption><thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>{list.accounts.map((account) => <tr key={account.name}><th scope="row">{account.name}</th><td>{account.role}</td><td>{account.disabled ? 'Disabled' : 'Enabled'}</td><td>{new Date(account.createdAt).toLocaleDateString()}</td><td><button aria-label={`Manage ${account.name}`} onClick={(event) => { origin.current = event.currentTarget; setSelection(account); }}>Manage</button></td></tr>)}</tbody></table></div> : <p>No accounts on this page.</p>)}
    {list && <div className="accounts-actions"><button disabled={loading || offset === 0} onClick={() => { closeEditor(); setOffset(Math.max(0, offset - 25)); }}>Previous</button><span>{list.total ? `${offset + 1}–${Math.min(offset + 25, list.total)} of ${list.total}` : '0 accounts'}</span><button disabled={loading || offset + 25 >= list.total} onClick={() => { closeEditor(); setOffset(offset + 25); }}>Next</button></div>}
  </main>;
}
