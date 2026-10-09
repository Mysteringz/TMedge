import { permissionChanged } from '../admin-session/index.tsx';

export interface AdminAccount { name: string; role: 'viewer' | 'engineer' | 'admin'; disabled: boolean; createdAt: number; revision: string }
export interface AccountList { accounts: AdminAccount[]; offset: number; limit: number; total: number }
export class AccountRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export async function accountRequest<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/admin/accounts${path}`, { method, signal, headers: { 'content-type': 'application/json', 'x-tm-algo': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as { data: T; error: { code: string; message: string } | null };
  if (!response.ok) { if (value.error?.code !== 'LOCAL_MODE') permissionChanged(response.status); throw new AccountRequestError(value.error?.code ?? 'UNAVAILABLE', value.error?.message ?? 'Could not reach account management.'); }
  return value.data;
}
