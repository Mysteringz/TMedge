import type { AdminRole, TeamRole } from './permissions.js';

export interface AdminAccount { name: string; role: AdminRole; teamRoles: TeamRole[]; disabled: boolean; createdAt: number; revision: string }
export interface AccountDeletion { name: string; deleted: true }
export class AccountError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export type AccountMutation = { kind: 'create'; name: string; role: AdminRole; password: string; teamRoles?: TeamRole[] }
  | { kind: 'update'; name: string; revision: string; role?: AdminRole; disabled?: boolean; teamRoles?: TeamRole[] }
  | { kind: 'password'; name: string; revision: string; password: string }
  | { kind: 'revoke'; name: string; revision: string };
