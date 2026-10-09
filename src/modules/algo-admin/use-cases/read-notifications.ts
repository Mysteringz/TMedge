import { NOTIFICATION_KINDS, NOTIFICATION_WINDOW_MS, type NotificationCandidate, type NotificationRead, type NotificationSourceView, type NotificationSnapshot } from '../domain/operation-notification.js';
import type { AdminPrincipal } from '../domain/permissions.js';
import type { NotificationQueries } from '../repositories/notification-queries.js';

export class ReadNotifications {
  private readonly pending = new Set<string>();
  constructor(private readonly queries: NotificationQueries, private readonly now: () => number = Date.now) {}
  private async source(key: string, allowed: boolean, query: (() => Promise<NotificationRead> | NotificationRead) | undefined): Promise<NotificationSourceView> {
    if (!allowed) return { state: 'forbidden', items: [] };
    if (!query) return { state: 'disabled', items: [] };
    if (this.pending.has(key)) return { state: 'unavailable', items: [] };
    this.pending.add(key);
    const work = Promise.resolve().then(query).finally(() => this.pending.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]);
      return result === null ? { state: 'unavailable', items: [] } : Array.isArray(result) ? { state: 'available', items: result } : { ...result, state: result.state ?? 'available' };
    } catch { return { state: 'unavailable', items: [] }; }
    finally { clearTimeout(timer); }
  }
  async execute(actor: AdminPrincipal): Promise<NotificationSnapshot> {
    const generatedAt = this.now(), queries = this.queries;
    const [sensor, training, firmware, parameter] = await Promise.all([
      this.source('sensor', actor.capabilities.includes('algo.read'), queries.sensor ? () => queries.sensor!(generatedAt) : undefined),
      this.source(`training:${actor.name}`, actor.capabilities.includes('training.read'), () => queries.training(actor.name, generatedAt)),
      this.source('firmware', actor.capabilities.includes('firmware.read'), () => queries.firmware(generatedAt)),
      this.source('parameter', actor.capabilities.includes('algo.read'), queries.parameter ? () => queries.parameter!(generatedAt) : undefined),
    ]);
    const results = { sensor, training, firmware, parameter }, unique = new Map<string, NotificationCandidate>();
    for (const kind of NOTIFICATION_KINDS) for (const item of results[kind].items) {
      if (!Number.isFinite(item.windowAt) || item.windowAt > generatedAt || (item.classification !== 'active' && item.windowAt < generatedAt - NOTIFICATION_WINDOW_MS) || (item.occurredAt !== null && (!Number.isFinite(item.occurredAt) || item.occurredAt > generatedAt))) continue;
      unique.set(item.id, item);
    }
    const sorted = [...unique.values()].sort((a, b) => Number(b.classification === 'active') - Number(a.classification === 'active') || b.windowAt - a.windowAt || a.id.localeCompare(b.id));
    const items = sorted.slice(0, 100).map(({ windowAt: _window, ...item }) => item);
    const sources = Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, results[kind].state!])) as NotificationSnapshot['sources'];
    const summaries: NotificationSnapshot['summaries'] = {};
    for (const kind of NOTIFICATION_KINDS) if (results[kind].summary) summaries[kind] = results[kind].summary;
    return { generatedAt, items, sources, summaries, omittedCount: Math.max(0, sorted.length - 100), historyLimited: true };
  }
}
