/**
 * Messages between the people who hold accounts.
 *
 * A message belongs to its sender and the people it was sent to, and to
 * nobody else: there is no role that reads other people's mail, and no
 * listing that is not filtered by who is asking.
 */
import { randomBytes } from 'node:crypto';
import {
  fields, LIMITS, oneLine, paragraphs, WorkspaceError,
  type Actor, type MailboxView, type MailDocument, type Member, type MessageHeader, type MessageView, type StoredMessage,
} from '../domain/workspace.js';
import type { DocumentStore } from '../repositories/document-store.js';

const ID = /^[A-Za-z0-9_-]{12}$/;
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const isNames = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((name) => typeof name === 'string' && NAME.test(name));

/** Refuses anything that is not a mailbox this code wrote. */
export function parseMail(value: unknown): MailDocument {
  const document = value as Partial<MailDocument> | null;
  if (!document || document.version !== 1 || !Array.isArray(document.messages) || document.messages.length > LIMITS.messages) throw new Error('not a mailbox');
  for (const m of document.messages as Partial<StoredMessage>[]) {
    if (!m || typeof m.id !== 'string' || !ID.test(m.id) || typeof m.from !== 'string' || !NAME.test(m.from)
      || !isNames(m.to, LIMITS.recipients) || m.to.length === 0 || typeof m.subject !== 'string' || m.subject.length > LIMITS.subject
      || typeof m.body !== 'string' || m.body.length > LIMITS.body || typeof m.sentAt !== 'number' || !Number.isFinite(m.sentAt) || m.sentAt < 0
      || !(m.replyTo === null || (typeof m.replyTo === 'string' && ID.test(m.replyTo)))
      || !isNames(m.readBy, LIMITS.recipients) || !isNames(m.hiddenFor, LIMITS.recipients + 1)) throw new Error('not a mailbox');
  }
  if (new Set(document.messages.map((m) => m.id)).size !== document.messages.length) throw new Error('not a mailbox');
  return document as MailDocument;
}

export const emptyMail = (): MailDocument => ({ version: 1, messages: [] });

export class Mailbox {
  constructor(
    private readonly store: DocumentStore<MailDocument>,
    private readonly members: () => Member[],
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomBytes(9).toString('base64url'),
  ) {}

  /**
   * Which box, if any, a message is in for this person.
   *
   * Mail older than the account is never theirs. Usernames can be reused
   * after an account is deleted, and whoever is given the name next must not
   * open it to find the last person's correspondence.
   */
  private boxOf(message: StoredMessage, actor: Actor): 'inbox' | 'sent' | null {
    if (message.sentAt < actor.since || message.hiddenFor.includes(actor.name)) return null;
    if (message.from === actor.name) return 'sent';
    return message.to.includes(actor.name) ? 'inbox' : null;
  }

  private header(message: StoredMessage, box: 'inbox' | 'sent', actor: Actor): MessageHeader {
    const flat = message.body.replace(/\s+/g, ' ');
    return {
      id: message.id, box, from: message.from, to: message.to, subject: message.subject,
      preview: flat.length > LIMITS.preview ? `${flat.slice(0, LIMITS.preview - 1)}…` : flat,
      sentAt: message.sentAt, replyTo: message.replyTo,
      // What you sent is not something you have yet to read.
      read: box === 'sent' || message.readBy.includes(actor.name),
    };
  }

  private find(document: MailDocument, actor: Actor, id: string): { message: StoredMessage; box: 'inbox' | 'sent' } {
    const message = ID.test(id) ? document.messages.find((m) => m.id === id) : undefined;
    const box = message ? this.boxOf(message, actor) : null;
    // The same answer whether it does not exist or is somebody else's: an id is not a way to ask.
    if (!message || !box) throw new WorkspaceError('NOT_FOUND', 404, 'That message is not in your mailbox.');
    return { message, box };
  }

  list(actor: Actor): MailboxView {
    const inbox: MessageHeader[] = [], sent: MessageHeader[] = [];
    let unread = 0;
    for (const message of this.store.read().messages) {
      const box = this.boxOf(message, actor);
      if (!box) continue;
      const header = this.header(message, box, actor);
      (box === 'inbox' ? inbox : sent).push(header);
      if (!header.read) unread++;
    }
    const newest = (rows: MessageHeader[]) => rows.sort((a, b) => b.sentAt - a.sentAt || a.id.localeCompare(b.id)).slice(0, LIMITS.listed);
    return { unread, inbox: newest(inbox), sent: newest(sent), omitted: { inbox: Math.max(0, inbox.length - LIMITS.listed), sent: Math.max(0, sent.length - LIMITS.listed) } };
  }

  open(actor: Actor, id: string): MessageView {
    const { message, box } = this.find(this.store.read(), actor, id);
    return { ...this.header(message, box, actor), body: message.body };
  }

  send(actor: Actor, input: unknown): MessageView {
    const body = fields(input, ['to', 'subject', 'body', 'replyTo']);
    if (!Array.isArray(body.to) || body.to.length === 0) throw new WorkspaceError('VALIDATION', 400, 'Choose at least one person to send this to.');
    if (body.to.length > LIMITS.recipients || body.to.some((name) => typeof name !== 'string')) throw new WorkspaceError('VALIDATION', 400, `A message can go to at most ${LIMITS.recipients} people.`);
    const to = [...new Set((body.to as string[]).map((name) => name.trim().toLowerCase()))].sort();
    if (to.includes(actor.name)) throw new WorkspaceError('VALIDATION', 400, 'You cannot send a message to yourself.');
    const known = new Set(this.members().map((member) => member.name));
    const missing = to.find((name) => !known.has(name));
    // Echoing the name back is safe only once it is known to be shaped like one.
    if (missing !== undefined) throw new WorkspaceError('VALIDATION', 400, NAME.test(missing) ? `${missing} is not a member of this console.` : 'A recipient is not a member of this console.');
    const subject = oneLine(body.subject, LIMITS.subject, 'A subject');
    const text = paragraphs(body.body, LIMITS.body, 'A message', true);
    const replyTo = body.replyTo === undefined || body.replyTo === null ? null : String(body.replyTo);

    return this.store.update((draft) => {
      // A reply must answer something the sender can actually see; otherwise
      // the field would be a way to probe for other people's message ids.
      if (replyTo !== null && !draft.messages.some((m) => m.id === replyTo && this.boxOf(m, actor))) {
        throw new WorkspaceError('VALIDATION', 400, 'The message being answered is not in your mailbox.');
      }
      const message: StoredMessage = { id: this.newId(), from: actor.name, to, subject, body: text, sentAt: this.now(), replyTo, readBy: [], hiddenFor: [] };
      draft.messages.push(message);
      // Bounded: the oldest mail makes room. The file is rewritten whole on
      // every change, and it is a mailbox, not an archive.
      if (draft.messages.length > LIMITS.messages) {
        draft.messages.sort((a, b) => a.sentAt - b.sentAt);
        draft.messages.splice(0, draft.messages.length - LIMITS.messages);
      }
      return { ...this.header(message, 'sent', actor), body: message.body };
    });
  }

  mark(actor: Actor, id: string, input: unknown): MessageView {
    const body = fields(input, ['read']);
    if (typeof body.read !== 'boolean') throw new WorkspaceError('VALIDATION', 400, 'Read must be true or false.');
    const read = body.read;
    return this.store.update((draft) => {
      const { message, box } = this.find(draft, actor, id);
      if (box === 'inbox') {
        const others = message.readBy.filter((name) => name !== actor.name);
        message.readBy = read ? [...others, actor.name] : others;
      }
      return { ...this.header(message, box, actor), body: message.body };
    });
  }

  /** Takes a message out of this person's mailbox only. It is erased once nobody keeps it. */
  remove(actor: Actor, id: string): { id: string; removed: true } {
    return this.store.update((draft) => {
      const { message } = this.find(draft, actor, id);
      message.hiddenFor = [...message.hiddenFor, actor.name];
      const kept = [message.from, ...message.to].some((name) => !message.hiddenFor.includes(name));
      if (!kept) draft.messages = draft.messages.filter((m) => m !== message);
      return { id, removed: true as const };
    });
  }
}
