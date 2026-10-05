import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { ApplicationError } from '../../modules/shared/application/contracts.js';
import { AuthError } from '../../modules/student-auth/application/student-session-service.js';
import { createStudentUser, normalizeStudentEmail, validateStudentSignup, verifyStudentPassword } from '../../modules/student-auth/application/student-credentials.js';
import type { StudentAccountImportResult, StudentAccountTransferRepository } from '../../modules/student-auth/application/student-account-import-export.js';
import type { IStudentAccountRepository } from '../../modules/student-auth/repositories/student-account-repository.js';
import type { User } from '../../modules/student-auth/domain/user.js';

interface AccountRow {
  id: string; email: string; name: string; salt: string; hash: string; created_at: Date | string;
}

/** Always reads committed accounts from PostgreSQL; never caches credentials or falls back to JSON. */
export class PostgresStudentAccountRepository implements IStudentAccountRepository, StudentAccountTransferRepository {
  constructor(private readonly source: DataSource, private readonly allowedDomains: readonly string[] = []) {}

  async count(): Promise<number> {
    return this.available(async () => {
      const rows = await this.source.query('SELECT count(*)::integer AS count FROM public.student_users') as Array<{ count: number }>;
      return rows[0]?.count ?? 0;
    });
  }

  async get(email: string): Promise<User | undefined> {
    return this.available(async () => {
      const rows = await this.source.query('SELECT * FROM public.student_users WHERE email = $1', [normalizeStudentEmail(email)]) as AccountRow[];
      return rows[0] ? toUser(rows[0]) : undefined;
    });
  }

  async create(raw: string, name: string, password: string): Promise<User> {
    const email = normalizeStudentEmail(raw);
    validateStudentSignup(email, password, this.allowedDomains);
    const user = await createStudentUser(email, name, password);
    await this.available(() => insertAccount(this.source.manager, user));
    return user;
  }

  async verify(email: string, password: string): Promise<User | null> {
    const user = await this.get(email);
    return await verifyStudentPassword(user, password) ? user ?? null : null;
  }

  async exportAccounts(): Promise<User[]> {
    return this.available(async () => {
      const rows = await this.source.query('SELECT * FROM public.student_users ORDER BY email') as AccountRow[];
      return rows.map(toUser);
    });
  }

  async importAccounts(users: readonly User[], options: { dryRun: boolean }): Promise<StudentAccountImportResult> {
    return this.available(() => this.source.transaction(async (manager) => {
      // Exclude signup writers while checking every conflict; dry-run checks the same committed view.
      await manager.query('LOCK TABLE public.student_users IN SHARE ROW EXCLUSIVE MODE');
      const existing = (await manager.query('SELECT * FROM public.student_users') as AccountRow[]).map(toUser);
      const pending = collectInsertable(users, existing);
      if (!options.dryRun) for (const user of pending) await insertAccount(manager, user);
      return { total: users.length, inserted: options.dryRun ? 0 : pending.length,
        unchanged: users.length - pending.length, insertable: pending.length, dryRun: options.dryRun };
    }));
  }

  private async available<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof AuthError) throw error;
      if (postgresCode(error) === '23505') throw new AuthError('An account with that email already exists. Sign in instead.');
      throw new ApplicationError('unavailable', 'Student account storage is unavailable. Try again shortly.');
    }
  }
}

function toUser(row: AccountRow): User {
  return { id: row.id, email: row.email, name: row.name, salt: row.salt, hash: row.hash,
    createdAt: new Date(row.created_at).getTime() };
}

async function insertAccount(manager: EntityManager, user: User): Promise<void> {
  await manager.query(`INSERT INTO public.student_users (id, email, name, salt, hash, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $6)`,
  [user.id ?? randomUUID(), user.email, user.name, user.salt, user.hash, new Date(user.createdAt)]);
}

function collectInsertable(users: readonly User[], existing: readonly User[]): User[] {
  const byEmail = new Map(existing.map((user) => [user.email, user]));
  const byId = new Map(existing.filter((user) => user.id).map((user) => [user.id, user]));
  const pending: User[] = [];
  for (const user of users) {
    const current = byEmail.get(user.email);
    const idConflict = user.id && byId.has(user.id) && byId.get(user.id)?.email !== user.email;
    if (idConflict || (current && !sameAccount(current, user))) {
      throw new ApplicationError('conflict', 'Student account import conflicts with existing data; no records were changed.');
    }
    if (!current) pending.push(user);
  }
  return pending;
}

function sameAccount(current: User, imported: User): boolean {
  return (!imported.id || current.id === imported.id) && current.name === imported.name && current.salt === imported.salt
    && current.hash === imported.hash && current.createdAt === imported.createdAt;
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const raw = error as { code?: string; driverError?: { code?: string } }; // PostgreSQL errors are external objects.
  return raw.driverError?.code ?? raw.code;
}
