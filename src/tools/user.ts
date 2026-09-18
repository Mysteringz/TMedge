/**
 * Manage student accounts without the sign-up form:
 *   npm run user -- add <email> <name> <password>
 *   npm run user -- list
 * Uses the same allowed domains as the web tier (ALLOWED_EMAIL_DOMAINS).
 */
import { join } from 'node:path';
import { UserStore } from '../web/auth.js';

const store = new UserStore(
  process.env.USERS_FILE || join(process.env.DATA_DIR || 'data', 'users.json'),
  (process.env.ALLOWED_EMAIL_DOMAINS ?? 'hku.hk,connect.hku.hk').split(',').map((d) => d.trim()).filter(Boolean),
);
const [cmd, email, name, password] = process.argv.slice(2);
if (cmd === 'add' && email && name && password) {
  const u = await store.create(email, name, password);
  console.log(`added ${u.email}`);
} else if (cmd === 'list') {
  console.log(`${store.size} user(s)`);
} else {
  console.error('usage: npm run user -- add <email> <name> <password> | list');
  process.exit(1);
}
