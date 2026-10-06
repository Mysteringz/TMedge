/**
 * `npm run hpc-hostkeys` on the server, once, by an admin, with their own HKU
 * login: pins HPC2021's SSH host keys for module 02 (HANDOVER.md M0 S4).
 *
 * It opens the admin's own VPN tunnel (PIN, then the code from their phone,
 * typed here and never echoed), asks the login node for its host keys through
 * that tunnel, shows the fingerprints and pins them only on "yes". Compare
 * them with what HKU publishes, or with `ssh-keygen -lf` from a campus
 * machine, before saying yes. Nothing is retried; the session is closed
 * before the question is asked.
 *
 * Run it as the service account, so the file is the edge's:
 *   cd /opt/tmedge && sudo -u tmedge /usr/local/bin/node --env-file=/opt/tmedge/.env dist/src/tools/hpchostkeys.js
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHpcConfig } from '../algo/train/config.js';
import { authenticate, childEnv, connectTunnel, socksReady } from '../algo/train/hpc/openconnect.js';
import { Credentials } from '../algo/train/hpc/sealed.js';
import { SOCKS_HELPER } from '../algo/train/hpc/ssh.js';
import { HKU_UID } from '../algo/train/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A visible answer (UID, yes/no). stdin is never given an encoding: that
 * would make the secrets below arrive as strings too.
 */
function ask(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise((resolve) => {
    process.stdin.once('data', (d: Buffer) => { process.stdin.pause(); resolve(d.toString('utf8').trim()); });
    process.stdin.resume();
  });
}

/** Reads a secret from the terminal into bytes: no echo, never a string. */
function askSecret(q: string, max = 128): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new Error('run this in a terminal: secrets are typed, not piped');
  // Echo off before the prompt appears: anything typed the moment the prompt
  // shows must not be printed by the terminal.
  process.stdin.setRawMode(true);
  process.stdout.write(q);
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(max);
    let n = 0;
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk)) { done(); return reject(new Error('the terminal handed over text, not bytes; refusing to read a secret that way')); }
      for (const b of chunk) {
        if (b === 0x03) { buf.fill(0); done(); return reject(new Error('cancelled')); }
        if (b === 0x0d || b === 0x0a) { done(); const out = Buffer.from(buf.subarray(0, n)); buf.fill(0); return resolve(out); }
        if (b === 0x7f || b === 0x08) { if (n > 0) buf[--n] = 0; continue; }
        if (n < max) buf[n++] = b;
      }
      chunk.fill(0);
    };
    const done = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    process.stdin.on('data', onData);
  });
}

function run(bin: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((r) => {
    const c = spawn(bin, args, { stdio: 'ignore', env });
    c.on('close', (code) => r(code ?? -1));
    c.on('error', () => r(-1));
  });
}

async function main(): Promise<void> {
  const cfg = loadHpcConfig(process.env.HPC_CONFIG || join(ROOT, 'config', 'hpc.json'));
  const a = cfg.planA;
  if (!a) throw new Error('config/hpc.json has no Plan A section (backend "vpn-ssh")');
  const dataDir = process.env.DATA_DIR || join(ROOT, 'data');
  const target = a.knownHosts ?? join(dataDir, 'algo', 'train', 'known_hosts');
  const oc = a.tools.openconnect ?? ['/usr/local/sbin/openconnect', '/usr/local/bin/openconnect', '/usr/sbin/openconnect', '/usr/bin/openconnect'].find(existsSync);
  const ocproxy = a.tools.ocproxy ?? ['/usr/local/bin/ocproxy', '/usr/bin/ocproxy'].find(existsSync);
  const ssh = a.tools.ssh ?? '/usr/bin/ssh';
  if (!oc || !ocproxy) throw new Error('openconnect and ocproxy must be installed first (docs/hpc/plan-a-runbook.md)');

  console.log(`Pin the SSH host keys of ${a.submitHost} through your own HKU VPN login (${a.vpnHost}).`);
  const uid = await ask('HKU UID (without @hku.hk): ');
  if (!HKU_UID.test(uid)) throw new Error('a UID is 2-32 lowercase letters and digits');
  const domain = a.vpnDomains.length === 1 ? a.vpnDomains[0]! : (await ask(`VPN domain [${a.vpnDomains.join('/')}] (${a.vpnDomains[0]}): `)) || a.vpnDomains[0]!;
  if (!a.vpnDomains.includes(domain)) throw new Error(`domain is one of ${a.vpnDomains.join(', ')}`);
  const pin = await askSecret('Portal PIN (not shown): ');
  const otp = await askSecret('One-time code from your phone (not shown): ', 8);
  const plain = Buffer.alloc(4 + pin.length + otp.length);
  plain[0] = 1; plain[1] = pin.length; pin.copy(plain, 2); plain[2 + pin.length] = otp.length; otp.copy(plain, 3 + pin.length); plain[3 + pin.length + otp.length] = 0;
  pin.fill(0); otp.fill(0);
  const creds = new Credentials(plain);

  const port = a.socksPorts[1];
  if (await socksReady(port, 300)) throw new Error(`port ${port} is busy; is the dashboard using it?`);
  console.log('[vpn]  logging in (one attempt)…');
  let auth;
  try {
    auth = await authenticate({ bin: oc, host: a.vpnHost, vpnUser: `${uid}@${domain}`, creds, serverCert: a.vpnServerCert, authGroup: a.vpnAuthGroup });
  } finally {
    creds.wipe();
  }
  console.log('[vpn]  accepted; bringing the tunnel up…');
  const tunnel = await connectTunnel({ bin: oc, ocproxy, auth, port });
  auth.cookie.fill(0);
  const scratch = mkdtempSync(join(tmpdir(), 'hpc-hostkeys-'));
  const found = join(scratch, 'known_hosts');
  try {
    console.log(`[ssh]  asking ${a.submitHost} for its host keys…`);
    for (const alg of ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512']) {
      // accept-new records the key; "none" auth then fails, as intended: no
      // login happens. One file per type: once a host is known by one type,
      // ssh will not add another to the same file.
      const each = `${found}.${alg}`;
      await run(ssh, ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${each}`,
        '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlgorithms=${alg}`, '-o', 'BatchMode=yes',
        '-o', 'PreferredAuthentications=none', '-o', 'ConnectTimeout=20',
        '-o', `ProxyCommand=${process.execPath} ${SOCKS_HELPER} 127.0.0.1 ${port} %h %p`, '-l', uid, a.submitHost, 'true'],
      childEnv({ HOME: scratch }));
      if (existsSync(each)) writeFileSync(found, readFileSync(each, 'utf8'), { flag: 'a' });
    }
  } finally {
    await tunnel.close();
    console.log('[vpn]  logged off.');
  }
  if (!existsSync(found) || readFileSync(found, 'utf8').trim() === '') throw new Error(`no host key came back from ${a.submitHost}`);
  const fingerprints = await new Promise<string>((r) => {
    const c = spawn('ssh-keygen', ['-lf', found], { env: childEnv() });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    c.on('close', () => r(out));
  });
  console.log(`\n${a.submitHost} presented:\n${fingerprints}`);
  const yes = await ask(`Pin these for module 02 in ${target}? Type "yes": `);
  if (yes !== 'yes') { rmSync(scratch, { recursive: true, force: true }); console.log('Not pinned.'); return; }
  const lines = readFileSync(found, 'utf8').split('\n').filter((l) => l.trim()).map((l) => l.replace(/^\S+/, a.submitHost));
  const kept = existsSync(target) ? readFileSync(target, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith(`${a.submitHost} `)) : [];
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${[...kept, ...lines].join('\n')}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Pinned ${lines.length} key(s). Module 02 can now log in to ${a.submitHost}.`);
}

main().then(() => process.exit(0), (err: Error) => {
  console.error(`hpc-hostkeys: ${err.message}`);
  process.exit(1);
});
