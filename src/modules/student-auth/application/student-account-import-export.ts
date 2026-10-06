import type { User } from '../domain/user.js';
import { ApplicationError } from '../../shared/application/contracts.js';
import { normalizeStudentEmail } from './student-credentials.js';

export interface StudentAccountImportResult {
  total: number;
  inserted: number;
  unchanged: number;
  insertable: number;
  dryRun: boolean;
}

/** Transfer operations never expose credentials in their result diagnostics. */
export interface StudentAccountTransferRepository {
  importAccounts(users: readonly User[], options: { dryRun: boolean }): Promise<StudentAccountImportResult>;
  exportAccounts(): Promise<User[]>;
}

/** Validates the entire recovery format before handing it to a transactional adapter. */
export class StudentAccountImportExport {
  constructor(private readonly repository: StudentAccountTransferRepository) {}

  async import(value: unknown, options: { dryRun?: boolean } = {}): Promise<StudentAccountImportResult> {
    return this.repository.importAccounts(validateStudentAccountImport(value), { dryRun: options.dryRun !== false });
  }

  async export(): Promise<User[]> {
    return this.repository.exportAccounts();
  }
}

/** Accepts legacy records without IDs while rejecting ambiguous identities or damaged credentials. */
export function validateStudentAccountImport(value: unknown): User[] {
  if (!Array.isArray(value)) throw invalid('Expected a student account array.');
  const users = value.map((raw: unknown, index: number) => parseAccount(raw, index));
  const emails = new Set<string>();
  const ids = new Set<string>();
  for (const user of users) {
    if (emails.has(user.email)) throw invalid('Duplicate normalized email in student account import.');
    if (user.id && ids.has(user.id)) throw invalid('Duplicate account ID in student account import.');
    emails.add(user.email);
    if (user.id) ids.add(user.id);
  }
  return users;
}

function parseAccount(value: unknown, index: number): User {
  if (!value || typeof value !== 'object') throw invalid(`Invalid account at index ${index}.`);
  const raw = value as Record<string, unknown>; // Input is narrowed to an object before field validation.
  validateAccountFields(raw, index);
  const email = normalizeStudentEmail(String(raw.email));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid(`Invalid account email at index ${index}.`);
  return {
    ...(raw.id === undefined ? {} : { id: String(raw.id).toLowerCase() }), email, name: String(raw.name),
    salt: String(raw.salt).toLowerCase(), hash: String(raw.hash).toLowerCase(), createdAt: Number(raw.createdAt),
    ...(typeof raw.google === 'string' ? { google: raw.google } : {}),
  };
}

function validateAccountFields(raw: Record<string, unknown>, index: number): void {
  const stringsValid = typeof raw.email === 'string' && typeof raw.name === 'string' && raw.name.trim().length > 0
    && typeof raw.salt === 'string' && ( /^[a-f0-9]{32}$/i.test(raw.salt) || (raw.google && raw.salt === ''))
    && typeof raw.hash === 'string' && ( /^[a-f0-9]{64}$/i.test(raw.hash) || (raw.google && raw.hash === ''))
    && (raw.google === undefined || (typeof raw.google === 'string' && raw.google.length > 0 && raw.google.length <= 255));
  const timestampValid = typeof raw.createdAt === 'number' && Number.isSafeInteger(raw.createdAt)
    && raw.createdAt >= 0 && raw.createdAt <= 8_640_000_000_000_000;
  const idValid = raw.id === undefined || (typeof raw.id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw.id));
  if (!stringsValid || !timestampValid || !idValid) throw invalid(`Invalid account fields at index ${index}.`);
}

function invalid(message: string): ApplicationError {
  return new ApplicationError('validation', message);
}
