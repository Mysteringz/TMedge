/** One plain-text message to one address. There is no HTML and no second recipient to get wrong. */
export interface OutgoingMail { to: string; subject: string; text: string }

/**
 * Why a message did not go. `refused`: the mail service will not send this
 * one, and asking again changes nothing (an address it will not write to, a
 * sender it does not know). `unavailable`: it could not be asked, or was
 * busy; the same message may go later.
 *
 * `detail` is a short machine word for the log. It never holds an address:
 * a person's address is theirs, and a log is read by other people.
 */
export class MailError extends Error {
  constructor(readonly reason: 'refused' | 'unavailable', readonly detail = '') { super(`mail ${reason}`); }
}

/** Sends email. Absent altogether on a server that is not set up to. */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}
