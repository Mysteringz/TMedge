import type { AccountMutation, AdminAccount } from '../domain/accounts.js';

export interface AdminAccountRepository {
  list(): AdminAccount[];
  mutate(change: AccountMutation, authorize: () => void): Promise<AdminAccount>;
}
