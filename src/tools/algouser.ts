/**
 * Manage algo console accounts (algo.hkumyseat.com):
 *   npm run algo-user -- add <name>      prompts for the password
 *   npm run algo-user -- remove <name>
 *   npm run algo-user -- list
 * The password is read from the terminal without echo, or from stdin when
 * piped, never from the command line: argv lands in shell history and `ps`.
 * The edge picks up changes without a restart; a removed account is signed
 * out on its next request.
 */
import { isAdminRole } from '../modules/algo-admin/domain/permissions.js';
import { createInterface } from 'node:readline';
import { AlgoUsers, algoUsersPath, MIN_PASSWORD } from '../algo/auth.js';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Swallow the echo of what is typed; the prompt itself still prints.
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) { out.output.write(s); prompted = true; }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const users = new AlgoUsers(algoUsersPath(process.env));
const [cmd, name, selectedRole] = process.argv.slice(2);
try {
  if (cmd === 'add' && name) {
    const pw = await readPassword(`password for ${name} (${MIN_PASSWORD}+ chars): `);
    if (process.stdin.isTTY && (await readPassword('again: ')) !== pw) throw new Error('the passwords differ');
    const role = selectedRole ?? 'operator';
    if (!isAdminRole(role)) throw new Error('role must be viewer, operator, engineer or admin');
    const u = await users.add(name, pw, role);
    console.log(`added ${u.name} to ${users.path}`);
  } else if (cmd === 'reset-password' && name) {
    const pw = await readPassword(`new password for ${name}: `);
    if (process.stdin.isTTY && (await readPassword('again: ')) !== pw) throw new Error('the passwords differ');
    await users.resetPassword(name, pw);
    process.stdout.write(`password reset for ${name}\n`);
  } else if (cmd === 'role' && name && isAdminRole(selectedRole)) {
    const u = users.update(name, { role: selectedRole });
    process.stdout.write(`updated ${u.name}: ${u.role}\n`);
  } else if (cmd === 'remove' && name) {
    console.log(users.remove(name) ? `removed ${name}` : `no account called ${name}`);
  } else if (cmd === 'list') {
    const names = users.names();
    console.log(`${names.length} account(s) in ${users.path}${names.length ? `: ${names.join(', ')}` : ''}`);
  } else {
    console.error('usage: npm run algo-user -- add <name> [viewer|operator|engineer|admin] | reset-password <name> | role <name> <viewer|operator|engineer|admin> | remove <name> | list');
    process.exit(1);
  }
} catch (err) {
  console.error(`algo-user: ${(err as Error).message}`);
  process.exit(1);
}
