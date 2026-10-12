import { NOTIFICATION_KINDS } from '../../modules/algo-admin/domain/operation-notification.js';
import type { EmailTopic } from '../../modules/algo-admin/domain/account-settings.js';
import type { News, NewsItem } from '../../modules/algo-admin/domain/email-delivery.js';
import { principal } from '../../modules/algo-admin/domain/permissions.js';
import type { AccountProfile } from '../../modules/algo-admin/repositories/own-account-repository.js';
import type { ReadNotifications } from '../../modules/algo-admin/use-cases/read-notifications.js';
import type { Board } from '../../modules/workspace/application/board.js';
import type { Mailbox } from '../../modules/workspace/application/mailbox.js';

// Work under way, not something that happened: the console shows it, and it is not worth an inbox.
const PROGRESS = new Set(['Building', 'Pilot rollout', 'Rollout in progress']);

/**
 * What one person could be emailed about, read the way the console reads it
 * for them: the notification centre under their own role, their own inbox,
 * the tasks given to them. Nothing here reaches past what that person sees
 * when signed in -- an email must never be a way around a permission.
 */
export class RuntimeAccountNews {
  constructor(
    private readonly operations: Pick<ReadNotifications, 'execute'>,
    private readonly mailbox: Pick<Mailbox, 'list'>,
    private readonly board: Pick<Board, 'view'>,
  ) {}

  async for(account: AccountProfile): Promise<News> {
    const items: NewsItem[] = [], answered: EmailTopic[] = [];
    const snapshot = await this.operations.execute(principal(account.name, account.role));
    for (const kind of NOTIFICATION_KINDS) if (snapshot.sources[kind] !== 'unavailable') answered.push(kind);
    for (const item of snapshot.items) {
      const ongoing = item.classification === 'active';
      if (ongoing && PROGRESS.has(item.outcome)) continue;
      items.push({
        // A condition is the same condition however long it has lasted; an outcome is its own event.
        key: ongoing ? JSON.stringify([item.kind, item.resourceId, item.outcome]) : item.id,
        topic: item.kind, subject: item.label, event: item.outcome, ...(item.detail ? { detail: item.detail } : {}), at: item.occurredAt, ongoing, path: item.href,
      });
    }
    const actor = { name: account.name, since: account.createdAt, teamRoles: account.teamRoles, canTriage: false, isAdmin: false };
    try {
      // Unread only: what somebody has already opened in the console is not news to them.
      for (const message of this.mailbox.list(actor).inbox) if (!message.read) items.push({ key: `mail:${message.id}`, topic: 'mail', subject: `From ${message.from}`, event: message.subject, at: message.sentAt, ongoing: false, path: '/' });
      answered.push('mail');
    } catch { /* storage unavailable: unknown, not empty */ }
    try {
      for (const task of this.board.view(actor).tasks) {
        // A task somebody made for themselves needs no telling.
        if (task.assignee !== account.name || task.status === 'done' || task.createdBy === account.name) continue;
        items.push({ key: `task:${task.id}`, topic: 'task', subject: `${task.id} ${task.title}`, event: task.due ? `Assigned to you, due ${task.due}` : 'Assigned to you', at: null, ongoing: false, path: '/' });
      }
      answered.push('task');
    } catch { /* storage unavailable: unknown, not empty */ }
    return { items, answered };
  }
}
