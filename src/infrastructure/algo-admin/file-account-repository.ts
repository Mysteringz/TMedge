import { createHmac } from 'node:crypto';
import { AlgoUsers, type AlgoUser } from '../../algo/auth.js';
import { AuthBusyError } from '../../web/auth.js';
import { AccountError, type AdminAccount, type AccountMutation, type AccountDeletion } from '../../modules/algo-admin/domain/accounts.js';
import type { AdminAccountRepository } from '../../modules/algo-admin/repositories/admin-account-repository.js';

export class FileAccountRepository implements AdminAccountRepository {
  constructor(private readonly users: AlgoUsers, private readonly secret: Buffer) {}
  private dto(user: AlgoUser): AdminAccount {
    return { name: user.name, role: user.role ?? 'engineer', disabled: user.disabled ?? false, createdAt: user.createdAt,
      revision: createHmac('sha256', this.secret).update('account-edit-v1').update(JSON.stringify([user.name, user.role, user.disabled, user.createdAt, user.sessionVersion, user.salt, user.hash])).digest('hex') };
  }
  private translate(error: unknown): never {
    if (error instanceof AccountError || error instanceof AuthBusyError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message === 'account already exists') throw new AccountError('DUPLICATE', 409, 'That username already exists.');
    if (message === 'no such account') throw new AccountError('NOT_FOUND', 404, 'Account not found.');
    if (message === 'account changed; retry the operation') throw new AccountError('STALE_REVISION', 409, 'This account changed. Refresh before saving.');
    if (message === 'cannot remove, disable or demote the final enabled admin') throw new AccountError('LAST_ADMIN', 409, 'Keep at least one enabled admin.');
    throw new AccountError('STORAGE_UNAVAILABLE', 503, 'Account storage is unavailable.');
  }
  list(): AdminAccount[] { try { return this.users.records().sort((a, b) => a.name.localeCompare(b.name)).map((user) => this.dto(user)); } catch (error) { return this.translate(error); } }
  async delete(name: string, revision: string, authorize: () => void): Promise<AccountDeletion> {
    try {
      authorize();
      const snapshot = this.users.records().find((user) => user.name === name);
      if (!snapshot) throw new AccountError('NOT_FOUND', 404, 'This account no longer exists.');
      if (this.dto(snapshot).revision !== revision) throw new AccountError('STALE_REVISION', 409, 'This account changed. Refresh accounts before deleting it.');
      this.users.remove(name, snapshot, authorize);
      return { name, deleted: true };
    } catch (error) { return this.translate(error); }
  }
  async mutate(change: AccountMutation, authorize: () => void): Promise<AdminAccount> {
    try {
      authorize();
      if (change.kind === 'create') return this.dto(await this.users.add(change.name, change.password, change.role, authorize));
      const snapshot = this.users.records().find((user) => user.name === change.name);
      if (!snapshot) throw new AccountError('NOT_FOUND', 404, 'Account not found.');
      if (this.dto(snapshot).revision !== change.revision) throw new AccountError('STALE_REVISION', 409, 'This account changed. Refresh before saving.');
      const updated = change.kind === 'password' ? await this.users.resetPassword(change.name, change.password, snapshot, authorize)
        : this.users.update(change.name, change.kind === 'revoke' ? { revoke: true } : { ...(change.role === undefined ? {} : { role: change.role }), ...(change.disabled === undefined ? {} : { disabled: change.disabled }) }, snapshot, authorize);
      return this.dto(updated);
    } catch (error) { return this.translate(error); }
  }
}
