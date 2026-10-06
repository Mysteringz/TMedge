import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStudentUser, normalizeStudentEmail, validateStudentSignup, verifyStudentPassword } from '../../modules/student-auth/application/student-credentials.js';
import { validateStudentAccountImport } from '../../modules/student-auth/application/student-account-import-export.js';
import { ApplicationError } from '../../modules/shared/application/contracts.js';
import { AuthError } from '../../modules/student-auth/application/student-session-service.js';
import type { IStudentAccountRepository } from '../../modules/student-auth/repositories/student-account-repository.js';
import type { User } from '../../modules/student-auth/domain/user.js';
import { randomUUID } from 'node:crypto';

/** Stores student accounts in the existing atomic users.json format. */
export class JsonStudentAccountRepository implements IStudentAccountRepository {
  private readonly users = new Map<string, User>();

  constructor(private readonly path: string, private readonly allowedDomains: readonly string[]) {
    try {
      const list = validateStudentAccountImport(JSON.parse(readFileSync(path, 'utf8')));
      for (const user of list) this.users.set(user.email, user);
    } catch (error) {
      // Only a missing file is a new installation; damaged accounts must never be overwritten.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new ApplicationError('unavailable', 'Student account file is unreadable or invalid.');
      }
    }
  }

  get size(): number {
    return this.users.size;
  }

  count(): number {
    return this.users.size;
  }

  google(identity: { sub: string; email: string; name: string }, signupOpen: boolean): User {
    if (!identity.sub || identity.sub.length > 255) throw new AuthError('Invalid Google identity.');
    const bySubject = [...this.users.values()].find((user) => user.google === identity.sub);
    if (bySubject) return bySubject;
    const email = normalizeStudentEmail(identity.email);
    if (this.users.has(email)) throw new AuthError('That email already belongs to another account. Sign in with its existing method.');
    if (!signupOpen) throw new AuthError('Sign-up is closed.');
    const user: User = { id: randomUUID(), email, name: identity.name.trim() || email, salt: '', hash: '', createdAt: Date.now(), google: identity.sub };
    this.users.set(email, user);
    try { this.save(); } catch (error) { this.users.delete(email); throw error; }
    return user;
  }

  get(email: string): User | undefined {
    return this.users.get(this.normalise(email));
  }

  normalise(email: string): string {
    return normalizeStudentEmail(email);
  }

  async create(emailRaw: string, name: string, password: string): Promise<User> {
    const email = this.normalise(emailRaw);
    validateStudentSignup(email, password, this.allowedDomains);
    this.rejectDuplicate(email);
    const user = await createStudentUser(email, name, password);
    this.rejectDuplicate(email);
    this.users.set(email, user);
    try {
      this.save();
    } catch (error) {
      this.users.delete(email);
      throw error;
    }
    return user;
  }

  async verify(emailRaw: string, password: string): Promise<User | null> {
    const user = this.users.get(this.normalise(emailRaw));
    return await verifyStudentPassword(user, password) ? user ?? null : null;
  }

  private rejectDuplicate(email: string): void {
    if (this.users.has(email)) throw new AuthError('An account with that email already exists. Sign in instead.');
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.users.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
