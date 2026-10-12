import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AccountError } from '../domain/accounts.js';
import { CODE_LIFETIME_MS, CODE_TRIES, emailAddress, emailTopics, NO_SETTINGS, type OwnAccount } from '../domain/account-settings.js';
import { confirmationMail } from '../domain/email-delivery.js';
import type { AdminPrincipal } from '../domain/permissions.js';
import { MailError, type Mailer } from '../repositories/mailer.js';
import type { AccountRef, AccountSettingsRepository, OwnAccountRepository } from '../repositories/own-account-repository.js';

const MIN_PASSWORD = 12, MAX_PASSWORD = 1024;

/**
 * What a signed-in person may do to their own account, whatever their role:
 * read it, keep an address and notification choices, confirm that address,
 * change the password, end the sessions. Nothing here takes a username from the request -- the
 * account acted on is always the one the session belongs to, so there is no
 * argument by which one person's call could reach another's.
 */
export class ManageOwnAccount {
  constructor(
    private readonly accounts: OwnAccountRepository,
    private readonly settings: AccountSettingsRepository,
    /** Null on a server that cannot send email. Reported, so the page never implies mail that will not come. */
    private readonly mailer: Mailer | null = null,
    private readonly now: () => number = Date.now,
    private readonly newCode: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
  ) {}

  private get emailDelivery(): boolean { return this.mailer !== null; }
  // Bound to the account and the address: a code is no use for another of either.
  private codeHash(account: AccountRef, email: string, code: string): string {
    return createHash('sha256').update(JSON.stringify([account.name, account.createdAt, email, code])).digest('hex');
  }

  read(actor: AdminPrincipal): OwnAccount {
    // Sign-in off: one person, with no account record to hang anything on.
    if (!actor.namedAccount) return { name: actor.name, role: actor.role, teamRoles: [], createdAt: 0, namedAccount: false, settings: NO_SETTINGS, emailDelivery: false };
    const profile = this.profileOf(actor);
    return { ...profile, namedAccount: true, settings: this.settings.read(profile), emailDelivery: this.emailDelivery };
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
    return { ...profile, namedAccount: true, settings: saved, emailDelivery: this.emailDelivery };
  }

  /**
   * Emails a code to the address on file, to be typed back. It is the only
   * thing an unconfirmed address is ever sent, and it doubles as the proof
   * that this server's email works at all.
   */
  async sendCode(actor: AdminPrincipal): Promise<{ sent: true; expiresAt: number }> {
    const profile = this.profileOf(actor);
    if (!this.mailer) throw new AccountError('EMAIL_OFF', 409, 'This server is not set up to send email.');
    const settings = this.settings.read(profile);
    if (settings.email === null) throw new AccountError('VALIDATION', 400, 'Save an email address first.');
    if (settings.confirmed) throw new AccountError('ALREADY_CONFIRMED', 409, 'This address is already confirmed.');
    const code = this.newCode(), expiresAt = this.now() + CODE_LIFETIME_MS;
    // Kept before it is sent: a code that arrived must be one that can be entered.
    if (!this.settings.expectCode(profile, settings.email, { hash: this.codeHash(profile, settings.email, code), expiresAt, triesLeft: CODE_TRIES })) {
      throw new AccountError('STALE_REVISION', 409, 'Your email settings changed. Try again.');
    }
    try { await this.mailer.send({ to: settings.email, ...confirmationMail(profile.name, code, CODE_LIFETIME_MS / 60_000) }); }
    catch (error) {
      if (error instanceof MailError && error.reason === 'refused') throw new AccountError('MAIL_REFUSED', 502, 'The mail service would not send to this address. Check it, or ask an admin whether the mail service is still restricted to approved addresses.');
      throw new AccountError('MAIL_UNAVAILABLE', 503, 'The mail service could not be reached. Try again in a few minutes.');
    }
    return { sent: true, expiresAt };
  }

  confirmEmail(actor: AdminPrincipal, input: unknown): OwnAccount {
    const profile = this.profileOf(actor);
    const invalid = (message: string): never => { throw new AccountError('VALIDATION', 400, message); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('A JSON object is required.');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== 'code')) return invalid('Unknown confirmation fields.');
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return invalid('The code is six digits.');
    const outcome = this.settings.tryCode(profile, (hash, email) => timingSafeEqual(Buffer.from(hash), Buffer.from(this.codeHash(profile, email, code))), this.now());
    if (outcome === 'none') throw new AccountError('NO_CODE', 409, 'There is no code to check: it expired, or was tried too many times. Send a new one.');
    if (outcome === 'wrong') throw new AccountError('WRONG_CODE', 400, 'That code is not right.');
    return { ...profile, namedAccount: true, settings: this.settings.read(profile), emailDelivery: this.emailDelivery };
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
