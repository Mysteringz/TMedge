/**
 * What is emailed to a person, and when.
 *
 * The console's notifications are a view: every time somebody looks, they
 * are worked out again from what is true now. Email cannot be that -- a
 * message, once sent, stays sent -- so this keeps, per account, what has
 * already been said, and decides what is worth saying next.
 *
 * The rules, all of them here:
 *   - Nothing that was already there when a person turned email on is news.
 *     Their first message is about the first thing to happen afterwards.
 *   - A condition that can clear by itself (a sensor offline, a parameter
 *     change waiting) is written about once it has lasted HOLD_MS. One that
 *     clears sooner is never mentioned; a sensor that drops for a minute is
 *     not worth an inbox.
 *   - The same condition on the same thing is not written about twice in
 *     REMEMBER_MS, however often it comes and goes.
 *   - One message carries everything that is ready, at most one message every
 *     MIN_GAP_MS and DAILY_LIMIT a day to one person.
 *   - A source that did not answer is unknown, not empty: what it last said
 *     is neither forgotten nor announced as over.
 */
import { createHash } from 'node:crypto';
import { EMAIL_TOPICS, type EmailTopic } from './account-settings.js';

export const TICK_MS = 60_000;
export const HOLD_MS = 10 * 60_000;
export const MIN_GAP_MS = 15 * 60_000;
export const DAILY_LIMIT = 12;
export const REMEMBER_MS = 24 * 60 * 60_000;
/** How many things one message lists; the rest are counted and left to the console. */
export const MAX_LISTED = 25;
const MAX_REMEMBERED = 1000;
/** How stale `lastPresentAt` may get before it is worth a write to the file. */
const TOUCH_MS = 60 * 60_000;

export interface NewsItem {
  /** The same for as long as it is the same piece of news. */
  key: string;
  topic: EmailTopic;
  /** What it is about, and what happened to it: "A2 north", "Offline report". */
  subject: string;
  event: string;
  detail?: string;
  at: number | null;
  /** A condition that can clear by itself, rather than something that happened. */
  ongoing: boolean;
  /** Where to look, as a path in the console. */
  path: string;
}
/** What is true for one person now. `answered` names the topics whose source could be asked. */
export interface News { items: NewsItem[]; answered: EmailTopic[] }

export interface Remembered {
  /** A hash of the news item's key: the file says that something was sent, not what. */
  key: string;
  topic: EmailTopic;
  /** Sent, or deliberately not sent. Either way, no longer news. */
  settled: boolean;
  since: number;
  lastPresentAt: number;
}
export interface DeliveryRecord { name: string; accountCreatedAt: number; items: Remembered[]; lastTriedAt: number; day: string; sentToday: number }
export interface DeliveryDocument { version: 1; accounts: DeliveryRecord[] }
export const emptyDelivery = (): DeliveryDocument => ({ version: 1, accounts: [] });

const isTopic = (value: unknown): value is EmailTopic => EMAIL_TOPICS.some((topic) => topic === value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reads the stored record of what was sent, refusing anything it does not fully understand. */
export function parseDelivery(value: unknown): DeliveryDocument {
  const bad = (): never => { throw new Error('invalid email delivery file'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad();
  const { version, accounts } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(accounts) || accounts.length > 10_000) return bad();
  return { version: 1, accounts: accounts.map((entry: unknown): DeliveryRecord => {
    if (typeof entry !== 'object' || entry === null) return bad();
    const { name, accountCreatedAt, items, lastTriedAt, day, sentToday } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(name) || !isTime(accountCreatedAt) || !isTime(lastTriedAt)
      || typeof day !== 'string' || !/^(\d{4}-\d{2}-\d{2})?$/.test(day) || !isTime(sentToday) || !Array.isArray(items) || items.length > MAX_REMEMBERED) return bad();
    return { name, accountCreatedAt, lastTriedAt, day, sentToday, items: items.map((item: unknown): Remembered => {
      if (typeof item !== 'object' || item === null) return bad();
      const { key, topic, settled, since, lastPresentAt } = item as Record<string, unknown>;
      if (typeof key !== 'string' || !/^[0-9a-f]{24}$/.test(key) || !isTopic(topic) || typeof settled !== 'boolean' || !isTime(since) || !isTime(lastPresentAt)) return bad();
      return { key, topic, settled, since, lastPresentAt };
    }) };
  }) };
}

const hashed = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * One step for one person: what is remembered after looking at `news`, and
 * what, if anything, to send now. `previous` is null for somebody email has
 * not started for; the result's record is null if it still cannot start.
 */
export function plan(previous: DeliveryRecord | null, account: { name: string; createdAt: number }, news: News, notify: readonly EmailTopic[], now: number): { record: DeliveryRecord | null; ready: NewsItem[] } {
  const present = new Map(news.items.map((item) => [hashed(item.key), item]));
  const answered = new Set(news.answered), wanted = new Set(notify);
  if (!previous) {
    // Starting from half a picture would announce the other half as new the moment it came back.
    if (EMAIL_TOPICS.some((topic) => !answered.has(topic))) return { record: null, ready: [] };
    const items = [...present].map(([key, item]): Remembered => ({ key, topic: item.topic, settled: true, since: now, lastPresentAt: now }));
    return { record: { name: account.name, accountCreatedAt: account.createdAt, items: items.slice(0, MAX_REMEMBERED), lastTriedAt: 0, day: dayOf(now), sentToday: 0 }, ready: [] };
  }
  const items: Remembered[] = [];
  for (const kept of previous.items) {
    // Turned off, or unsendable for a day: it is not going to be sent, and must not be when the topic is ticked again.
    const settled = kept.settled || !wanted.has(kept.topic) || now - kept.since >= REMEMBER_MS;
    if (present.has(kept.key)) items.push({ ...kept, settled, lastPresentAt: now - kept.lastPresentAt >= TOUCH_MS ? now : kept.lastPresentAt });
    else if (!answered.has(kept.topic)) items.push({ ...kept, settled });
    // Sent, and gone: remembered a while longer, so its coming back is not news.
    else if (kept.settled && now - kept.lastPresentAt < REMEMBER_MS) items.push(kept);
    // Otherwise it cleared before it was worth a message, or is old enough to forget.
  }
  const known = new Set(items.map((item) => item.key));
  for (const [key, item] of present) if (!known.has(key)) items.push({ key, topic: item.topic, settled: !wanted.has(item.topic), since: now, lastPresentAt: now });
  // Bounded, oldest first to go. What is waiting to be sent is the newest by construction.
  if (items.length > MAX_REMEMBERED) items.sort((a, b) => a.lastPresentAt - b.lastPresentAt).splice(0, items.length - MAX_REMEMBERED);

  const today = dayOf(now), sentToday = previous.day === today ? previous.sentToday : 0;
  const record: DeliveryRecord = { name: account.name, accountCreatedAt: account.createdAt, items, lastTriedAt: previous.lastTriedAt, day: today, sentToday };
  const due = now - previous.lastTriedAt >= MIN_GAP_MS && sentToday < DAILY_LIMIT;
  const ready: NewsItem[] = [];
  if (due) for (const kept of items) {
    const item = present.get(kept.key);
    if (item && !kept.settled && (!item.ongoing || now - kept.since >= HOLD_MS)) ready.push(item);
  }
  return { record, ready };
}

/** The record after trying to send `tried`. Undelivered news stays news, and is tried again after the gap. */
export function afterSending(record: DeliveryRecord, tried: readonly NewsItem[], delivered: boolean, now: number): DeliveryRecord {
  const keys = new Set(tried.map((item) => hashed(item.key)));
  return {
    ...record, lastTriedAt: now, sentToday: record.sentToday + (delivered ? 1 : 0),
    items: delivered ? record.items.map((item) => keys.has(item.key) ? { ...item, settled: true } : item) : record.items,
  };
}

const HEADINGS: Record<EmailTopic, string> = { sensor: 'Sensors', training: 'Training jobs', firmware: 'Firmware', parameter: 'Live parameter changes', mail: 'Team mail', task: 'Tasks' };
// What reaches a mail header or a line of the body is one line of printable
// text, whatever a sensor label, a job name or a subject held.
const line = (value: string, max = 160): string => {
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const when = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export interface ComposedMail { subject: string; text: string }

/** Everything that is ready for one person, as one message. */
export function digestMail(name: string, ready: readonly NewsItem[], consoleUrl: string | null): ComposedMail {
  const listed = ready.slice(0, MAX_LISTED), first = listed[0];
  const subject = ready.length === 1 && first ? `[HKUMySeat] ${line(first.subject, 80)}: ${line(first.event, 80)}` : `[HKUMySeat] ${ready.length} new notifications`;
  const lines: string[] = [`Hello ${name},`, ''];
  for (const topic of EMAIL_TOPICS) {
    const group = listed.filter((item) => item.topic === topic);
    if (!group.length) continue;
    lines.push(HEADINGS[topic]);
    for (const item of group) {
      lines.push(`- ${line(item.subject)}: ${line(item.event)}${item.detail ? ` (${line(item.detail)})` : ''}${item.at === null ? '' : `, ${when(item.at)}`}`);
      if (consoleUrl) lines.push(`  ${consoleUrl}${item.path}`);
    }
    lines.push('');
  }
  if (ready.length > listed.length) lines.push(`And ${ready.length - listed.length} more, in the console.`, '');
  lines.push(
    `You are getting this because email notifications are on for the account "${name}".`,
    `To change what is sent, or to stop it, open Account settings in the console${consoleUrl ? `: ${consoleUrl}/account` : '.'}`,
  );
  return { subject, text: lines.join('\n') };
}

/** The one message an unconfirmed address is ever sent. */
export function confirmationMail(name: string, code: string, minutes: number): ComposedMail {
  return {
    subject: `[HKUMySeat] ${code} is your confirmation code`,
    text: [
      `Hello ${name},`, '',
      `Your confirmation code is ${code}`, '',
      'Type it into Account settings in the console to confirm that this address is yours.',
      `It works for ${minutes} minutes.`, '',
      'If you did not ask for this, ignore it: nothing more is sent to this address unless the code is entered.',
    ].join('\n'),
  };
}
