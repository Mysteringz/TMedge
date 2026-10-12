import type { AlgoUsers } from '../../algo/auth.js';
import { AuthBusyError } from '../../web/auth.js';
import { AccountError } from '../../modules/algo-admin/domain/accounts.js';
import { NO_SETTINGS, type AccountSettings, type EmailTopic, type PendingCode, type SettingsDocument, type StoredSettings, type Subscriber } from '../../modules/algo-admin/domain/account-settings.js';
import type { AccountProfile, AccountRef, AccountSettingsRepository, OwnAccountRepository } from '../../modules/algo-admin/repositories/own-account-repository.js';
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

  /** The entry that is this account's -- not one left by an earlier account of the same name. */
  private own(document: SettingsDocument, account: AccountRef): StoredSettings | undefined {
    return document.accounts.find((entry) => entry.name === account.name && entry.accountCreatedAt === account.createdAt);
  }

  read(account: AccountRef): AccountSettings {
    let document: SettingsDocument;
    try { document = this.store.read(); } catch { return unavailable(); }
    const kept = this.own(document, account);
    return kept ? { email: kept.email, notify: [...kept.notify], confirmed: kept.confirmedAt !== null } : { ...NO_SETTINGS };
  }

  save(account: AccountRef, settings: { email: string | null; notify: EmailTopic[] }, current: AccountRef[], now: number): AccountSettings {
    let confirmedAt: number | null;
    try {
      confirmedAt = this.store.update((draft) => {
        const before = this.own(draft, account), kept = before && before.email === settings.email ? before : null;
        // Somebody who has left does not leave an address behind: every save
        // keeps only what belongs to an account that exists now.
        draft.accounts = draft.accounts.filter((entry) => entry.name !== account.name && current.some((live) => live.name === entry.name && live.createdAt === entry.accountCreatedAt));
        if (settings.email !== null) draft.accounts.push({
          name: account.name, accountCreatedAt: account.createdAt, updatedAt: now, email: settings.email, notify: [...settings.notify],
          // A code was sent to an address; it does not carry over to another one.
          confirmedAt: kept?.confirmedAt ?? null, code: kept?.code ?? null,
        });
        return kept?.confirmedAt ?? null;
      });
    } catch { return unavailable(); }
    return { email: settings.email, notify: [...settings.notify], confirmed: confirmedAt !== null };
  }

  expectCode(account: AccountRef, email: string, code: PendingCode): boolean {
    try {
      return this.store.update((draft) => {
        const entry = this.own(draft, account);
        if (!entry || entry.email !== email || entry.confirmedAt !== null) return false;
        entry.code = { ...code };
        return true;
      });
    } catch { return unavailable(); }
  }

  tryCode(account: AccountRef, matches: (hash: string, email: string) => boolean, now: number): 'confirmed' | 'wrong' | 'none' {
    try {
      // Read first: a try with nothing to try against changes nothing, and so writes nothing.
      const waiting = this.own(this.store.read(), account);
      if (!waiting?.code || waiting.email === null || waiting.confirmedAt !== null || waiting.code.expiresAt <= now || waiting.code.triesLeft <= 0) return 'none';
      return this.store.update((draft) => {
        const entry = this.own(draft, account);
        if (!entry?.code || entry.email === null) return 'none';
        if (matches(entry.code.hash, entry.email)) { entry.confirmedAt = now; entry.code = null; return 'confirmed'; }
        // Counted before the answer is given, so a guess always costs a try.
        entry.code.triesLeft -= 1;
        return 'wrong';
      });
    } catch { return unavailable(); }
  }

  subscribers(current: AccountRef[]): Subscriber[] {
    let document: SettingsDocument;
    try { document = this.store.read(); } catch { return unavailable(); }
    const found: Subscriber[] = [];
    for (const entry of document.accounts) {
      if (entry.email === null || entry.confirmedAt === null || entry.notify.length === 0) continue;
      if (!current.some((live) => live.name === entry.name && live.createdAt === entry.accountCreatedAt)) continue;
      found.push({ name: entry.name, createdAt: entry.accountCreatedAt, email: entry.email, notify: [...entry.notify] });
    }
    return found;
  }
}
