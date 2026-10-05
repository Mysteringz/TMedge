import type { User } from '../domain/user.js';

/** Account operations; the PostgreSQL adapter performs asynchronous reads. */
export interface IStudentAccountRepository {
  count(): number | Promise<number>;
  get(email: string): User | undefined | Promise<User | undefined>;
  create(email: string, name: string, password: string): Promise<User>;
  verify(email: string, password: string): Promise<User | null>;
}
