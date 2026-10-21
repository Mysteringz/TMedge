import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { User } from '../domain/user.js';
import { AuthError } from './student-session-service.js';
import { STUDENT_EMAIL_DOMAIN, STUDENT_EMAIL_PATTERN, resolveStudentEmail } from '../../../shared/student-email.js';
import { PASSWORD_MAX_LENGTH, unmetPasswordRequirements } from '../../../shared/password-rules.js';

/** Retains the email normalization used by existing signed sessions. */
export function normalizeStudentEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * What every account must satisfy before a password is hashed, whoever makes
 * it: a name that is something, an address at a domain this site allows, and a
 * password that clears every requirement the sign-up form lists.
 *
 * The UID spelling (`u1234567`) is *not* here. It belongs to the public
 * sign-up form and is enforced where that form posts
 * (student-auth-router.ts), because this repository also holds Google
 * accounts, accounts an operator imported, and staff-made ones -- all of which
 * are addressed however their owner is addressed.
 */
export function validateStudentSignup(email: string, name: string, password: string, allowedDomains: readonly string[]): void {
  if (name.trim().length === 0) throw new AuthError('Enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  const domain = email.split('@')[1] ?? '';
  if (allowedDomains.length && !allowedDomains.includes(domain)) {
    throw new AuthError(`Use your university email (${allowedDomains.map((value) => '@' + value).join(' or ')}).`);
  }
  // Checked before the requirements and before any hashing: an oversized
  // password is a refusal, not something to spend scrypt on.
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(`Use at most ${PASSWORD_MAX_LENGTH} characters for your password.`);
  }
  // Named one by one: "use a stronger password" leaves the student guessing,
  // and the form has already shown them this same list.
  const unmet = unmetPasswordRequirements(password);
  if (unmet.length > 0) {
    throw new AuthError(`Your password still needs: ${unmet.map((requirement) => requirement.label.toLowerCase()).join(', ')}.`);
  }
}

/**
 * The address the public sign-up form is allowed to create: an HKU UID
 * (`u1234567`) at the domain the form prints beside the box.
 *
 * `raw` is whatever was posted -- a bare UID, or the address the form
 * assembled from one. Both end at the same string, and anything else is
 * refused here rather than being quietly accepted as some other account.
 */
export function studentSignupEmail(raw: string): string {
  const email = normalizeStudentEmail(resolveStudentEmail(raw));
  if (!STUDENT_EMAIL_PATTERN.test(email)) {
    throw new AuthError(`Use your HKU UID, which is "u" followed by 7 digits (@${STUDENT_EMAIL_DOMAIN}).`);
  }
  return email;
}

/** Creates a stable account identity without changing the existing scrypt format. */
export async function createStudentUser(email: string, name: string, password: string): Promise<User> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return {
    id: randomUUID(), email, name: name.trim().slice(0, 60) || email.split('@')[0] || email,
    salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: Date.now(),
  };
}

/** Unknown accounts also incur scrypt work; malformed legacy hashes never authenticate. */
export async function verifyStudentPassword(user: User | undefined, password: string): Promise<boolean> {
  const valid = user !== undefined && /^[a-f0-9]{32}$/i.test(user.salt) && /^[a-f0-9]{64}$/i.test(user.hash);
  const hash = await derivePassword(password, valid ? Buffer.from(user.salt, 'hex') : randomBytes(16));
  return valid && timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, (error, derived) => error ? reject(error) : resolve(derived));
  });
}
