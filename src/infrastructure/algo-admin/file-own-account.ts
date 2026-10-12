import type { AlgoUsers } from '../../algo/auth.js';
import { AuthBusyError } from '../../web/auth.js';
import { AccountError } from '../../modules/algo-admin/domain/accounts.js';
import { NO_SETTINGS, type AccountSettings, type SettingsDocument } from '../../modules/algo-admin/domain/account-settings.js';
import type { AccountProfile, AccountSettingsRepository, OwnAccountRepository } from '../../modules/algo-admin/repositories/own-account-repository.js';
import type { DocumentStore } from '../../modules/workspace/repositories/document-store.js';

const unavailable = (): never => { throw new AccountError('STORAGE_UNAVAILABLE', 503, 'Account storage is unavailable.'); };

/** A person's own account, in the same file of accounts the sign-in reads. */
export class FileOwnAccount implements OwnAccountRepository {
  constructor(private readonly users: AlgoUsers) {}

  profile(name: string): AccountProfile | null {
    const user = this.users.get(name);
    return user && !user.disabled ? { name: user.name, role: user.role ?? 'engineer', teamRoles: user.teamRoles ?? [], createdAt: user.createdAt } : null;
  }

  current(): { name: string; createdAt: number }[] {
    try { return this.users.records().map((user) => ({ name: user.name, createdAt: user.createdAt })); } catch { return unavailable(); }
  }

  async changePassword(name: string, current: string, next: string): Promise<void> {
    let verified: Awaited<ReturnType<AlgoUsers['verifyRecord']>>;
    try { verified = await this.users.verifyRecord(name, current); }
    catch (error) { if (error instanceof AuthBusyError) throw error; return unavailable(); }
    // The session proves who is at the keyboard now; the password proves it
    // is still the person the account belongs to.
    if (!verified) throw new AccountError('WRONG_PASSWORD', 403, 'The current password is not right.');
    try { await this.users.resetPassword(name, next, verified); }
    catch (error) {
      if (error instanceof AuthBusyError) throw error;
      if (error instanceof Error && error.message === 'account changed; retry the operation') throw new AccountError('STALE_REVISION', 409, 'This account changed. Try again.');
      return unavailable();
    }
  }

  endSessions(name: string): void {
    try { this.users.update(name, { revoke: true }); } catch { unavailable(); }
  }
}

/**
 * Addresses and notification choices, in a private file of their own beside
 * the accounts. Not in the account file: that one is the sign-in's, is
 * rewritten by the account CLI, and has no business carrying an inbox.
 */
export class FileAccountSettings implements AccountSettingsRepository {
  constructor(private readonly store: DocumentStore<SettingsDocument>) {}

  read(account: { name: string; createdAt: number }): AccountSettings {
    let document: SettingsDocument;
    try { document = this.store.read(); } catch { return unavailable(); }
    const kept = document.accounts.find((entry) => entry.name === account.name);
    // Entered by an earlier account of the same name: not this person's.
    if (!kept || kept.accountCreatedAt !== account.createdAt) return { ...NO_SETTINGS };
    return { email: kept.email, notify: [...kept.notify] };
  }

  save(account: { name: string; createdAt: number }, settings: AccountSettings, current: { name: string; createdAt: number }[], now: number): AccountSettings {
    try {
      this.store.update((draft) => {
        // Somebody who has left does not leave an address behind: every save
        // keeps only what belongs to an account that exists now.
        draft.accounts = draft.accounts.filter((entry) => entry.name !== account.name && current.some((live) => live.name === entry.name && live.createdAt === entry.accountCreatedAt));
        if (settings.email !== null) draft.accounts.push({ name: account.name, accountCreatedAt: account.createdAt, updatedAt: now, email: settings.email, notify: [...settings.notify] });
      });
    } catch { return unavailable(); }
    return { email: settings.email, notify: [...settings.notify] };
  }
}
