import { AccountError } from '../domain/accounts.js';
import { emailAddress, emailTopics, NO_SETTINGS, type OwnAccount } from '../domain/account-settings.js';
import type { AdminPrincipal } from '../domain/permissions.js';
import type { AccountSettingsRepository, OwnAccountRepository } from '../repositories/own-account-repository.js';

const MIN_PASSWORD = 12, MAX_PASSWORD = 1024;

/**
 * What a signed-in person may do to their own account, whatever their role:
 * read it, keep an address and notification choices, change the password,
 * end the sessions. Nothing here takes a username from the request -- the
 * account acted on is always the one the session belongs to, so there is no
 * argument by which one person's call could reach another's.
 */
export class ManageOwnAccount {
  constructor(
    private readonly accounts: OwnAccountRepository,
    private readonly settings: AccountSettingsRepository,
    /** Whether this server can send email. Reported, so the page never implies mail that will not come. */
    private readonly emailDelivery: () => boolean = () => false,
    private readonly now: () => number = Date.now,
  ) {}

  read(actor: AdminPrincipal): OwnAccount {
    // Sign-in off: one person, with no account record to hang anything on.
    if (!actor.namedAccount) return { name: actor.name, role: actor.role, teamRoles: [], createdAt: 0, namedAccount: false, settings: NO_SETTINGS, emailDelivery: false };
    const profile = this.profileOf(actor);
    return { ...profile, namedAccount: true, settings: this.settings.read(profile), emailDelivery: this.emailDelivery() };
  }

  saveSettings(actor: AdminPrincipal, input: unknown): OwnAccount {
    const profile = this.profileOf(actor);
    const invalid = (message: string): never => { throw new AccountError('VALIDATION', 400, message); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A JSON object is required.');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== 'email' && key !== 'notify')) return invalid('Unknown settings fields.');
    const blank = body.email === null || (typeof body.email === 'string' && body.email.trim() === '');
    const email = blank ? null : emailAddress(body.email);
    if (!blank && email === null) return invalid('Enter one email address, such as name@example.com.');
    const notify = emailTopics(body.notify);
    if (notify === null) return invalid('Notification choices must come from the list.');
    // No address, nothing to send to: the choices are not kept as if they applied.
    const saved = this.settings.save(profile, { email, notify: email === null ? [] : notify }, this.accounts.current(), this.now());
    return { ...profile, namedAccount: true, settings: saved, emailDelivery: this.emailDelivery() };
  }

  /** `beforeChecking` runs once the request is well-formed and before the current password is tried: where guesses are counted. */
  async changePassword(actor: AdminPrincipal, input: unknown, beforeChecking: () => void = () => {}): Promise<void> {
    const profile = this.profileOf(actor);
    const invalid = (message: string): never => { throw new AccountError('VALIDATION', 400, message); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A JSON object is required.');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== 'current' && key !== 'password')) return invalid('Unknown password fields.');
    const { current, password } = body;
    if (typeof current !== 'string' || !current || current.length > MAX_PASSWORD) return invalid('Enter your current password.');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return invalid(`The new password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
    if (password === current) return invalid('Choose a password different from the current one.');
    beforeChecking();
    await this.accounts.changePassword(profile.name, current, password);
  }

  endSessions(actor: AdminPrincipal): void {
    this.accounts.endSessions(this.profileOf(actor).name);
  }

  private profileOf(actor: AdminPrincipal) {
    if (!actor.namedAccount) throw new AccountError('LOCAL_MODE', 403, 'Account settings are unavailable in local mode: there is no account to keep them for.');
    const profile = this.accounts.profile(actor.name);
    if (!profile) throw new AccountError('UNAUTHENTICATED', 401, 'Sign in again.');
    return profile;
  }
}
