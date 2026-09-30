import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { AuthError } from '../../modules/student-auth/application/student-session-service.js';
import type { IStudentAccountRepository } from '../../modules/student-auth/repositories/student-account-repository.js';
import type { User } from '../../modules/student-auth/domain/user.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Stores student accounts in the existing atomic users.json format. */
export class JsonStudentAccountRepository implements IStudentAccountRepository {
  private readonly users = new Map<string, User>();

  constructor(private readonly path: string, private readonly allowedDomains: readonly string[]) {
    try {
      const list = JSON.parse(readFileSync(path, 'utf8')) as User[];
      for (const user of list) this.users.set(user.email, user);
    } catch {
      // A missing file means this is a new installation.
    }
  }

  get size(): number {
    return this.users.size;
  }

  get(email: string): User | undefined {
    return this.users.get(email);
  }

  normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  private domainAllowed(email: string): boolean {
    const domain = email.split('@')[1] ?? '';
    return this.allowedDomains.length === 0 || this.allowedDomains.includes(domain);
  }

  async create(emailRaw: string, name: string, password: string): Promise<User> {
    const email = this.normalise(emailRaw);
    this.validateAccount(email, password);
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    const user: User = {
      email,
      name: name.trim().slice(0, 60) || email.split('@')[0] || email,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: Date.now(),
    };
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
    const salt = user ? Buffer.from(user.salt, 'hex') : randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    if (!user) return null;
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex')) ? user : null;
  }

  private validateAccount(email: string, password: string): void {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
    if (!this.domainAllowed(email)) throw new AuthError(`Use your university email (${this.allowedDomains.map((d) => '@' + d).join(' or ')}).`);
    if (password.length < 10) throw new AuthError('Use at least 10 characters for your password.');
    if (this.users.has(email)) throw new AuthError('An account with that email already exists. Sign in instead.');
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.users.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
