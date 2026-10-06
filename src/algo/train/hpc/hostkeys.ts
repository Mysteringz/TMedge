/**
 * The cluster's SSH host keys: pinned in a known_hosts file, and on the very
 * first connection fetched through the person's own tunnel and shown to
 * them to confirm -- what `ssh` itself asks the first time -- before
 * anything is pinned. Once a key is pinned, a different one is refused
 * (StrictHostKeyChecking=yes); confirming only ever happens when nothing is
 * pinned at all.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './openconnect.js';
import { SOCKS_HELPER } from './ssh.js';

export interface HostKey { type: string; key: string; fingerprint: string }

/** OpenSSH's SHA256 fingerprint: base64 of the SHA-256 of the key blob, unpadded. */
export function fingerprintOf(keyB64: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

function linesFor(file: string, host: string): string[][] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && !f[0]!.startsWith('#') && f[0]!.split(',').includes(host));
}

export function isPinned(file: string, host: string): boolean {
  return linesFor(file, host).length > 0;
}

/** Adds keys for `host`, keeping every other host's lines as they were. */
export function pin(file: string, host: string, keys: HostKey[]): void {
  const kept = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().split(/\s+/)[0]!.split(',').includes(host)) : [];
  writeFileSync(file, `${[...kept, ...keys.map((k) => `${host} ${k.type} ${k.key}`)].join('\n')}\n`, { mode: 0o600 });
}

export interface ScanOptions { ssh: string; host: string; user: string; socksPort: number; runDir: string; nodeBin?: string }

/**
 * Asks the host for each key type through the tunnel. No login happens:
 * "none" authentication fails once the key has been recorded.
 */
export async function scanHostKeys(o: ScanOptions): Promise<HostKey[]> {
  const node = o.nodeBin ?? process.execPath;
  const keys: HostKey[] = [];
  for (const alg of ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512']) {
    const file = join(o.runDir, `scan-${randomBytes(6).toString('hex')}`);
    await new Promise<void>((done) => {
      const c = spawn(o.ssh, ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${file}`,
        '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlgorithms=${alg}`, '-o', 'BatchMode=yes',
        '-o', 'PreferredAuthentications=none', '-o', 'ConnectTimeout=20',
        '-o', `ProxyCommand=${node} ${SOCKS_HELPER} 127.0.0.1 ${o.socksPort} %h %p`, '-l', o.user, o.host, 'true'],
      { stdio: 'ignore', env: childEnv({ HOME: o.runDir }) });
      c.on('close', () => done());
      c.on('error', () => done());
    });
    for (const f of linesFor(file, o.host)) {
      if (!keys.some((k) => k.key === f[2])) keys.push({ type: f[1]!, key: f[2]!, fingerprint: fingerprintOf(f[2]!) });
    }
    rmSync(file, { force: true });
  }
  return keys;
}

export const HOSTKEYS = { isPinned, pin, scan: scanHostKeys };
