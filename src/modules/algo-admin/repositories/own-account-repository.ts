import type { AccountSettings, EmailTopic, PendingCode, Subscriber } from '../domain/account-settings.js';
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

export interface AccountRef { name: string; createdAt: number }

export interface AccountSettingsRepository {
  read(account: AccountRef): AccountSettings;
  /**
   * Saves one account's address and choices, and drops those of accounts that
   * no longer exist. A different address is an unconfirmed one, with no code
   * waiting; the same address keeps its confirmation.
   */
  save(account: AccountRef, settings: { email: string | null; notify: EmailTopic[] }, current: AccountRef[], now: number): AccountSettings;
  /** Keeps the code about to be sent to `email`. False if that is no longer the account's unconfirmed address. */
  expectCode(account: AccountRef, email: string, code: PendingCode): boolean;
  /** Tries a code against the one waiting. A wrong try is counted; `none` means there is nothing left to try against. */
  tryCode(account: AccountRef, matches: (hash: string, email: string) => boolean, now: number): 'confirmed' | 'wrong' | 'none';
  /** Everyone to be written to, among the accounts that exist now. The only way more than one address is ever read. */
  subscribers(current: AccountRef[]): Subscriber[];
}
