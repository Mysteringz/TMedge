/**
 * `npm run hpc-password` on the server, by an admin: sets (or changes) the
 * fingerprint of the shared cluster account's password -- module 02 in
 * "shared-password" mode (docs/hpc/plan-a-runbook.md).
 *
 * The password is typed twice, never shown, and only its scrypt fingerprint
 * is written, to DATA_DIR/algo/train/ssh-password.json (0600). Everyone then
 * types the password at each sign-in, and the console checks it against the
 * fingerprint before connecting anywhere. Nothing here touches the network.
 *
 *   cd /opt/tmedge && sudo -u tmedge /usr/local/bin/node --env-file=/opt/tmedge/.env dist/src/tools/hpcpassword.js
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHpcConfig } from '../algo/train/config.js';
import { loadFingerprint, makeFingerprint, saveFingerprint } from '../algo/train/hpc/fingerprint.js';
import { askSecret } from './hpctty.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  const cfg = loadHpcConfig(process.env.HPC_CONFIG || join(ROOT, 'config', 'hpc.json'));
  const a = cfg.planA;
  if (!a || a.sshAuth !== 'shared-password') throw new Error('config/hpc.json does not use a shared cluster password (planA.sshAuth "shared-password")');
  const file = join(process.env.DATA_DIR || join(ROOT, 'data'), 'algo', 'train', 'ssh-password.json');
  const before = loadFingerprint(file);
  console.log(`${before ? 'Change' : 'Set'} the password fingerprint for ${a.sshUser}@${a.submitHost}.`);
  console.log('Only a fingerprint is kept; people type the password itself at each sign-in.');
  const first = await askSecret(`Password for ${a.sshUser}@${a.submitHost} (not shown): `);
  const again = await askSecret('Again (not shown): ');
  try {
    if (first.length === 0) throw new Error('empty password; nothing changed');
    if (!first.equals(again)) throw new Error('the two did not match; nothing changed');
    saveFingerprint(file, await makeFingerprint(first));
  } finally {
    first.fill(0);
    again.fill(0);
  }
  console.log(`Saved ${file}. Module 02 checks every sign-in against it from now on.`);
}

main().then(() => process.exit(0), (err: Error) => {
  console.error(`hpc-password: ${err.message}`);
  process.exit(1);
});
