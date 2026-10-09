import { AccountError, type AccountMutation } from '../domain/accounts.js';
import { isAdminRole, type AdminPrincipal } from '../domain/permissions.js';
import type { AdminAccountRepository } from '../repositories/admin-account-repository.js';

export class ManageAccounts {
  constructor(private readonly repository: AdminAccountRepository) {}
  authority(getPrincipal: () => AdminPrincipal | null): () => void {
    return () => {
      const actor = getPrincipal();
      if (!actor) throw new AccountError('UNAUTHENTICATED', 401, 'Sign in again.');
      if (!actor.namedAccount) throw new AccountError('LOCAL_MODE', 403, 'Account management is unavailable in local mode. Use the account CLI.');
      if (!actor.capabilities.includes('accounts.manage')) throw new AccountError('FORBIDDEN', 403, 'Admin access required.');
    };
  }
  list(offset: number, limit: number, authorize: () => void) {
    authorize();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AccountError('VALIDATION', 400, 'Invalid pagination.');
    const accounts = this.repository.list();
    return { accounts: accounts.slice(offset, offset + limit), offset, limit, total: accounts.length };
  }
  async mutate(kind: AccountMutation['kind'], name: string, input: unknown, authorize: () => void) {
    authorize();
    const invalid = (message: string): never => { throw new AccountError('VALIDATION', 400, message); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A JSON object is required.');
    const body = input as Record<string, unknown>;
    const allowed = kind === 'create' ? ['name', 'role', 'password'] : kind === 'update' ? ['revision', 'role', 'disabled'] : kind === 'password' ? ['revision', 'password'] : ['revision'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return invalid('Unknown account fields.');
    if (kind === 'create') name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(name)) return invalid('Username must be 2–32 letters, digits, dots, underscores or hyphens.');
    if (kind !== 'create' && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) return invalid('A current account revision is required.');
    if ((kind === 'create' || body.role !== undefined) && !isAdminRole(body.role)) return invalid('Select a valid role.');
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') return invalid('Enabled status must be a boolean.');
    if (kind === 'update' && body.role === undefined && body.disabled === undefined) return invalid('Select a role or enabled status change.');
    if ((kind === 'create' || kind === 'password') && (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024)) return invalid('Password must be 12–1024 characters.');
    return this.repository.mutate({ ...body, kind, name } as AccountMutation, authorize);
  }
}
