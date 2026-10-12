import { afterSending, digestMail, plan, type DeliveryDocument, type DeliveryRecord, type News } from '../domain/email-delivery.js';
import { MailError, type Mailer } from '../repositories/mailer.js';
import type { AccountProfile, AccountSettingsRepository, OwnAccountRepository } from '../repositories/own-account-repository.js';
import type { DocumentStore } from '../../workspace/repositories/document-store.js';

/**
 * Sends each person the news they asked to be emailed about. Run on a timer;
 * what is news, and how often, is decided in domain/email-delivery.ts.
 *
 * It runs inside the edge, beside the sensor pipeline, so it never throws and
 * never waits on more than one message at a time. It reads every subscriber's
 * address because sending needs it, and does nothing else with one: no
 * address is logged, returned or put in an error.
 */
export class DeliverEmailNotifications {
  private running = false;
  private lastLogged = { text: '', at: 0 };

  constructor(
    private readonly accounts: Pick<OwnAccountRepository, 'profile' | 'current'>,
    private readonly settings: Pick<AccountSettingsRepository, 'subscribers'>,
    /** What is true for one person now, as that person may see it. */
    private readonly news: (account: AccountProfile) => Promise<News>,
    private readonly ledger: DocumentStore<DeliveryDocument>,
    private readonly mailer: Mailer,
    private readonly consoleUrl: string | null = null,
    private readonly now: () => number = Date.now,
    private readonly log: (text: string) => void = (text) => console.warn(text),
  ) {}

  /** The same failure is said once an hour, not once a minute. */
  private warn(text: string): void {
    const at = this.now();
    if (text === this.lastLogged.text && at - this.lastLogged.at < 3_600_000) return;
    this.lastLogged = { text, at };
    this.log(`[email] ${text}`);
  }

  async run(): Promise<void> {
    // A slow mail service must not stack passes on top of each other.
    if (this.running) return;
    this.running = true;
    try {
      const subscribers = this.settings.subscribers(this.accounts.current());
      const before = this.ledger.read().accounts, after: DeliveryRecord[] = [];
      for (const subscriber of subscribers) {
        // Disabled since the address was saved: not written to, and email starts over if they return.
        const profile = this.accounts.profile(subscriber.name);
        if (!profile || profile.createdAt !== subscriber.createdAt) continue;
        const previous = before.find((entry) => entry.name === profile.name && entry.accountCreatedAt === profile.createdAt) ?? null;
        let news: News;
        try { news = await this.news(profile); }
        catch { if (previous) after.push(previous); continue; }
        const now = this.now(), step = plan(previous, profile, news, subscriber.notify, now);
        let record = step.record;
        if (record && step.ready.length) {
          let delivered = true;
          try { await this.mailer.send({ to: subscriber.email, ...digestMail(profile.name, step.ready, this.consoleUrl) }); }
          catch (error) {
            delivered = false;
            this.warn(`a notification was not sent: ${error instanceof MailError ? `${error.reason}${error.detail ? ` (${error.detail})` : ''}` : 'unexpected error'}`);
          }
          record = afterSending(record, step.ready, delivered, now);
        }
        if (record) after.push(record);
      }
      // Whoever is no longer a subscriber is simply not in `after`: nothing is kept about them.
      if (JSON.stringify(before) !== JSON.stringify(after)) this.ledger.update((draft) => { draft.accounts = after; });
    } catch { this.warn('the notification pass could not run (account or delivery storage is unavailable)'); }
    finally { this.running = false; }
  }
}
