import type { User } from '../domain/user.js';

/** File-backed account operations used by the student authentication feature. */
export interface IStudentAccountRepository {
  readonly size: number;
  get(email: string): User | undefined;
  create(email: string, name: string, password: string): Promise<User>;
  verify(email: string, password: string): Promise<User | null>;
}
