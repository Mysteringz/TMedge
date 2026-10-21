/**
 * The account CLI must say why it refused.
 *
 * Every refusal it can produce -- a duplicate email, a password missing one of
 * the requirements the form lists, an empty name, an unreadable account file --
 * is something the operator can act on, and each carries its own sentence. A
 * blanket "command failed" is how a perfectly explainable duplicate account
 * became a mystery.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

/** The tool runs against its own account file, never the developer's. */
function run(args: string[], usersFile: string) {
  return spawnSync(process.execPath, ['dist/src/tools/user.js', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STUDENT_PERSISTENCE_MODE: 'file',
      ALLOWED_EMAIL_DOMAINS: 'connect.hku.hk',
      USERS_FILE: usersFile,
      DATA_DIR: dirname(usersFile),
    },
  });
}

test('the account tool says why it refused, not just that it did', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmuser-'));
  const users = join(dir, 'users.json');
  const email = 'u3000001@connect.hku.hk';
  try {
    const short = run(['add', email, 'Test Person', 'short'], users);
    assert.equal(short.status, 1);
    // The refusal names what is missing, one requirement per comma, rather
    // than repeating a rule the operator cannot see from here.
    assert.match(short.stderr, /still needs: .*at least 8 characters/);
    assert.match(short.stderr, /an uppercase letter/);
    assert.match(short.stderr, /one or more symbols/);

    const weak = run(['add', email, 'Test Person', 'alllowercase1!'], users);
    assert.equal(weak.status, 1);
    assert.match(weak.stderr, /still needs: an uppercase letter\./);

    const nameless = run(['add', email, '   ', 'A-Long-Enough-Password-1'], users);
    assert.equal(nameless.status, 1);
    assert.match(nameless.stderr, /Enter your name\./);

    const added = run(['add', email, 'Test Person', 'A-Long-Enough-Password-1'], users);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /added u3000001@connect\.hku\.hk/);

    const again = run(['add', email, 'Test Person', 'A-Long-Enough-Password-1'], users);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);

    const listed = run(['list'], users);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /1 user\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
