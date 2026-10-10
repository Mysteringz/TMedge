import type { User } from '../domain/user.js';

/** Account operations; the PostgreSQL adapter performs asynchronous reads. */
export interface IStudentAccountRepository {
  readonly size?: number;
  count(): number | Promise<number>;
  get(email: string): User | undefined | Promise<User | undefined>;
  create(email: string, name: string, password: string): Promise<User>;
  verify(email: string, password: string): Promise<User | null>;
  google?(identity: { sub: string; email: string; name: string }, signupOpen: boolean): Promise<User> | User;
  /** When each account was created, for sign-up history. Times only: no identity leaves the store. */
  createdTimes?(): number[] | Promise<number[]>;
}
