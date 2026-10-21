/**
 * Manage student accounts without the sign-up form:
 *   npm run user -- add <email> <name> <password>
 *   npm run user -- list
 * Uses the same allowed domains and password rules as the web tier
 * (ALLOWED_EMAIL_DOMAINS). Every refusal it can produce is something the
 * operator can act on, so each one is printed as it is.
 */
import { join } from 'node:path';
import { JsonStudentAccountRepository } from '../infrastructure/web/json-student-account-repository.js';
import { openStudentPostgresStorage } from '../infrastructure/web/student-postgres-storage.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';
import { AuthError } from '../modules/student-auth/application/student-session-service.js';
import { ApplicationError } from '../modules/shared/application/contracts.js';

const [cmd, email, name, password] = process.argv.slice(2);
const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const mode = process.env.STUDENT_PERSISTENCE_MODE ?? 'file';
if (mode !== 'file' && mode !== 'postgres') {
  process.stderr.write('STUDENT_PERSISTENCE_MODE must be file or postgres.\n');
  process.exit(2);   // nothing has been opened yet, so there is nothing to dispose
}

let storage: Awaited<ReturnType<typeof openStudentPostgresStorage>> | undefined;
try {
  if (mode === 'postgres') storage = await openStudentPostgresStorage(loadPostgresConnectionConfig('runtime'), domains);
  const store = storage?.accounts ?? new JsonStudentAccountRepository(process.env.USERS_FILE || join(process.env.DATA_DIR || 'data', 'users.json'), domains);
  if (cmd === 'add' && email && name && password) {
    const user = await store.create(email, name, password);
    process.stdout.write(`added ${user.email}\n`);
  } else if (cmd === 'list') {
    process.stdout.write(`${await store.count()} user(s)\n`);
  } else {
    process.stderr.write('usage: npm run user -- add <email> <name> <password> | list\n');
    process.exitCode = 2;
  }
} catch (error) {
  // AuthError and ApplicationError carry fixed, credential-free sentences --
  // the same ones the sign-up form shows ("already exists", "still needs an
  // uppercase letter", "file is unreadable or invalid"). Swallowing them is
  // how a duplicate account became "command failed"; anything else (a driver
  // error, say) could quote a host or a user, so it keeps the generic line.
  const message = error instanceof AuthError || error instanceof ApplicationError
    ? error.message
    : 'Student account command failed; check inputs and configured storage.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  if (storage) {
    await storage.activity.dispose();
    await storage.closePersistence();
  }
}
