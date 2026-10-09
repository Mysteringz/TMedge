import type { AccountMutation, AdminAccount, AccountDeletion } from '../domain/accounts.js';

export interface AdminAccountRepository {
  list(): AdminAccount[];
  mutate(change: AccountMutation, authorize: () => void): Promise<AdminAccount>;
  delete(name: string, revision: string, authorize: () => void): Promise<AccountDeletion>;
}
