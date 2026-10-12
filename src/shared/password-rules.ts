/**
 * What a student's password has to be, in one place.
 *
 * The browser draws these as a live checklist and the server refuses anything
 * that does not pass all of them. Both read this list: a checklist that can
 * disagree with the rule that rejects you is worse than no checklist, because
 * it teaches the student not to believe the screen.
 */

export interface PasswordRequirement {
  /** Stable id, for a DOM key. */
  id: string;
  /** Shown in the checklist and, when unmet, named in the refusal. */
  label: string;
  test(password: string): boolean;
}

export const PASSWORD_MIN_LENGTH = 8;

/**
 * A ceiling, not a requirement: it never appears in the checklist, because a
 * student typing a reasonable password should never have to think about it.
 * It exists so the field cannot be used as a free way to make the server do
 * work -- scrypt hashes whatever it is given -- and so a password that is
 * accepted stays small enough to be pasted into a password manager.
 *
 * 64 is comfortably above any passphrase worth typing, and above the 20 this
 * was first considered at, which would have cut off ordinary long passwords.
 */
export const PASSWORD_MAX_LENGTH = 64;

/** A symbol is anything that is neither a letter nor a digit, in any script. */
const SYMBOL = /[^\p{L}\p{N}]/u;

export const PASSWORD_REQUIREMENTS: readonly PasswordRequirement[] = [
  { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters (max. ${PASSWORD_MAX_LENGTH})`, test: (p) => p.length >= PASSWORD_MIN_LENGTH && p.length <= PASSWORD_MAX_LENGTH },
  { id: 'lower', label: 'A lowercase letter', test: (p) => /\p{Ll}/u.test(p) },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /\p{Lu}/u.test(p) },
  { id: 'number', label: 'A number', test: (p) => /\p{N}/u.test(p) },
  { id: 'symbol', label: 'One or more symbols', test: (p) => SYMBOL.test(p) },
];

/** The requirements this password does not meet yet, in checklist order. */
export function unmetPasswordRequirements(password: unknown): PasswordRequirement[] {
  const value = typeof password === 'string' ? password : '';
  return PASSWORD_REQUIREMENTS.filter((requirement) => !requirement.test(value));
}

export function passwordMeetsRequirements(password: unknown): boolean {
  return unmetPasswordRequirements(password).length === 0;
}
