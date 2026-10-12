import { NOTIFICATION_KINDS } from './operation-notification.js';
import type { AdminRole, TeamRole } from './permissions.js';

/**
 * What a person keeps about their own account: an address to be reached at,
 * and what they want to hear about there.
 *
 * It is theirs alone. No role reads another person's address -- not an admin,
 * not the Accounts page, not the team list, not Ask AI -- and it is bound to
 * the account that entered it, not to the username: usernames are reused, and
 * a new "alex" must not inherit the last one's inbox.
 */
export const EMAIL_TOPICS = [...NOTIFICATION_KINDS, 'mail', 'task'] as const;
export type EmailTopic = typeof EMAIL_TOPICS[number];
export const MAX_EMAIL = 254;

export interface AccountSettings { email: string | null; notify: EmailTopic[] }
export const NO_SETTINGS: AccountSettings = { email: null, notify: [] };

export interface StoredSettings extends AccountSettings { name: string; accountCreatedAt: number; updatedAt: number }
export interface SettingsDocument { version: 1; accounts: StoredSettings[] }
export const emptySettings = (): SettingsDocument => ({ version: 1, accounts: [] });

export interface OwnAccount {
  name: string; role: AdminRole; teamRoles: TeamRole[]; createdAt: number;
  /** False with sign-in off: there is one person, "local", and nothing to keep about them. */
  namedAccount: boolean;
  settings: AccountSettings;
  /** Whether this server can send email at all. Until it can, an address is kept and nothing is sent to it. */
  emailDelivery: boolean;
}

const isTopic = (value: unknown): value is EmailTopic => EMAIL_TOPICS.some((topic) => topic === value);

/** A usable address, trimmed, with its domain lower-cased; null for anything else. */
export function emailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // One address, plainly: no display name, no list, nothing a mail header could be built out of.
  if (text.length > MAX_EMAIL || !/^[^\s@<>(),;:"\\\x00-\x1f\x7f]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(text)) return null;
  const at = text.lastIndexOf('@');
  return text.slice(0, at) + text.slice(at).toLowerCase();
}

/** The topics in canonical order, without repeats; null if any is not a topic. */
export function emailTopics(value: unknown): EmailTopic[] | null {
  if (!Array.isArray(value) || value.length > EMAIL_TOPICS.length || !value.every(isTopic)) return null;
  return EMAIL_TOPICS.filter((topic) => value.includes(topic));
}

/** Reads the stored document, refusing anything it does not fully understand. */
export function parseSettings(value: unknown): SettingsDocument {
  const bad = (): never => { throw new Error('invalid account settings file'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad();
  const { version, accounts } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(accounts) || accounts.length > 10_000) return bad();
  const seen = new Set<string>();
  return { version: 1, accounts: accounts.map((entry: unknown): StoredSettings => {
    if (typeof entry !== 'object' || entry === null) return bad();
    const { name, accountCreatedAt, updatedAt, email, notify } = entry as Record<string, unknown>;
    const topics = emailTopics(notify);
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(name) || seen.has(name)) return bad();
    if (typeof accountCreatedAt !== 'number' || !Number.isFinite(accountCreatedAt) || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return bad();
    if (topics === null || (email !== null && emailAddress(email) !== email)) return bad();
    seen.add(name);
    return { name, accountCreatedAt, updatedAt, email: email as string | null, notify: topics };
  }) };
}
