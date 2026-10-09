import { NOTIFICATION_WINDOW_MS, type NotificationCandidate, type NotificationSourceState, type NotificationSnapshot } from '../domain/operation-notification.js';
import type { AdminPrincipal } from '../domain/permissions.js';
import type { NotificationQueries } from '../repositories/notification-queries.js';

export class ReadNotifications {
  constructor(private readonly queries: NotificationQueries, private readonly now: () => number = Date.now) {}
  async execute(actor: AdminPrincipal): Promise<NotificationSnapshot> {
    const generatedAt = this.now();
    const read = async (allowed: boolean, query: () => ReturnType<NotificationQueries['firmware']>): Promise<{ state: NotificationSourceState; items: NotificationCandidate[] }> => {
      if (!allowed) return { state: 'forbidden', items: [] };
      try { const items = await query(); return { state: items === null ? 'unavailable' : 'available', items: items ?? [] }; }
      catch { return { state: 'unavailable', items: [] }; }
    };
    const [training, firmware] = await Promise.all([read(actor.capabilities.includes('training.read'), () => this.queries.training(actor.name)), read(actor.capabilities.includes('firmware.read'), () => this.queries.firmware())]);
    const unique = new Map<string, NotificationCandidate>();
    for (const item of [...training.items, ...firmware.items]) {
      if (!Number.isFinite(item.windowAt) || item.windowAt < generatedAt - NOTIFICATION_WINDOW_MS || item.windowAt > generatedAt || (item.occurredAt !== null && (!Number.isFinite(item.occurredAt) || item.occurredAt > generatedAt))) continue;
      unique.set(item.id, item);
    }
    const items = [...unique.values()].sort((a, b) => b.windowAt - a.windowAt || a.id.localeCompare(b.id)).slice(0, 100).map(({ windowAt: _window, ...item }) => item);
    return { generatedAt, items, sources: { training: training.state, firmware: firmware.state }, historyLimited: true };
  }
}
