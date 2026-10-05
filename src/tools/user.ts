/**
 * Manage student accounts without the sign-up form:
 *   npm run user -- add <email> <name> <password>
 *   npm run user -- list
 * Uses the same allowed domains as the web tier (ALLOWED_EMAIL_DOMAINS).
 */
import { join } from 'node:path';
import { JsonStudentAccountRepository } from '../infrastructure/web/json-student-account-repository.js';
import { openStudentPostgresStorage } from '../infrastructure/web/student-postgres-storage.js';
import { loadPostgresConnectionConfig } from '../infrastructure/postgres/config.js';

const [cmd, email, name, password] = process.argv.slice(2);
const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
let storage: Awaited<ReturnType<typeof openStudentPostgresStorage>> | undefined;
try {
  const mode = process.env.STUDENT_PERSISTENCE_MODE ?? 'file';
  if (mode !== 'file' && mode !== 'postgres') throw new Error('STUDENT_PERSISTENCE_MODE must be file or postgres');
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
} catch {
  process.stderr.write('Student account command failed; check inputs and configured storage.\n');
  process.exitCode = 1;
} finally {
  if (storage) {
    await storage.activity.dispose();
    await storage.closePersistence();
  }
}
