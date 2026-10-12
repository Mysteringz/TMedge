import type { AccountSettings } from '../domain/account-settings.js';
import type { AdminRole, TeamRole } from '../domain/permissions.js';

/** One account as its owner sees it. `createdAt` tells one "alex" from the next. */
export interface AccountProfile { name: string; role: AdminRole; teamRoles: TeamRole[]; createdAt: number }

/** The parts of the account store a person may use on their own account. */
export interface OwnAccountRepository {
  profile(name: string): AccountProfile | null;
  /** Every account that exists now, to tell whose settings may be kept. */
  current(): { name: string; createdAt: number }[];
  /** Replaces the password if `current` is right. Every session of the account ends. */
  changePassword(name: string, current: string, next: string): Promise<void>;
  /** Ends every session of the account, this one included. */
  endSessions(name: string): void;
}

export interface AccountSettingsRepository {
  read(account: { name: string; createdAt: number }): AccountSettings;
  /** Saves one account's settings, and drops those of accounts that no longer exist. */
  save(account: { name: string; createdAt: number }, settings: AccountSettings, current: { name: string; createdAt: number }[], now: number): AccountSettings;
}
