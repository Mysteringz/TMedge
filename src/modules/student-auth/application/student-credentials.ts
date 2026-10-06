import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { User } from '../domain/user.js';
import { AuthError } from './student-session-service.js';

/** Retains the email normalization used by existing signed sessions. */
export function normalizeStudentEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Applies the existing signup rules and messages before hashing. */
export function validateStudentSignup(email: string, password: string, allowedDomains: readonly string[]): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  const domain = email.split('@')[1] ?? '';
  if (allowedDomains.length && !allowedDomains.includes(domain)) {
    throw new AuthError(`Use your university email (${allowedDomains.map((value) => '@' + value).join(' or ')}).`);
  }
  if (password.length < 10) throw new AuthError('Use at least 10 characters for your password.');
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
