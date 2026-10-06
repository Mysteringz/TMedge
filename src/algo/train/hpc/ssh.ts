/**
 * The SSH half of Plan A (HANDOVER.md §6.5), on the system's OpenSSH rather
 * than a library: one ControlMaster connection per person through their own
 * tunnel, which later commands reuse without a password -- the session cache.
 *
 * The password reaches ssh only through SSH_ASKPASS: ssh runs askpass.js,
 * which asks this process over a Unix socket that exists for this one login,
 * in a directory only this service can enter. So the PIN is never in argv,
 * never in an environment variable and never a string here, and it is
 * offered once: a second prompt (a wrong password) gets an empty answer and
 * the login fails rather than retrying. Host keys are pinned
 * (StrictHostKeyChecking=yes against a file captured with a person present,
 * `npm run hpc-hostkeys`), the handover's RejectPolicy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { childEnv } from './openconnect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOCKS_HELPER = join(HERE, 'socks-connect.js');
export const ASKPASS_HELPER = join(HERE, 'askpass.js');

export type SshFailure = 'bad_password' | 'host_key' | 'unreachable' | 'timeout' | 'unsupported';
export class SshFailed extends Error {
  constructor(readonly code: SshFailure, message: string) { super(message); }
}

export const SSH_MESSAGES: Record<SshFailure, string> = {
  bad_password: 'The cluster did not accept the SSH password. Nothing was retried. If the password was changed there, an admin updates its fingerprint (npm run hpc-password).',
  host_key: "The cluster's SSH host key is not the pinned one, or none is pinned yet (npm run hpc-hostkeys). Refused, as it should be.",
  unreachable: 'The VPN is up but the cluster did not answer on SSH.',
  timeout: 'The cluster did not finish the SSH login in time.',
  unsupported: 'The cluster asked for something other than a password (see docs/hpc/m0-checklist.md).',
};

/** Paths that go into a ProxyCommand line or a script: nothing a shell would reinterpret. */
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export interface SshOptions {
  bin: string;
  host: string;
  user: string;
  socksPort: number;
  knownHosts: string;
  /** Private (0700) directory for the control socket and the askpass rendezvous. */
  runDir: string;
  nodeBin?: string;
}

export interface RunResult { code: number; stdout: Buffer; stderr: string }
export interface RunOptions { stdin?: Readable; timeoutMs?: number; maxBytes?: number }

/** What the gateway and slurm.ts need from an SSH connection (fakes in tests). */
export interface SshLike {
  open(password: Buffer, timeoutMs?: number): Promise<void>;
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
  readonly alive: boolean;
}

export class SshLink implements SshLike {
  private master: ChildProcess | null = null;
  private readonly ctl: string;
  private readonly common: string[];

  constructor(private readonly o: SshOptions) {
    const node = o.nodeBin ?? process.execPath;
    for (const p of [node, SOCKS_HELPER, o.knownHosts, o.runDir]) {
      if (!SAFE_PATH.test(p)) throw new Error(`unsafe path for ssh: ${p}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(o.user) || !/^[A-Za-z0-9.-]+$/.test(o.host)) throw new Error('bad ssh user or host');
    mkdirSync(o.runDir, { recursive: true, mode: 0o700 });
    chmodSync(o.runDir, 0o700);
    // Short: a Unix socket path must fit in 108 bytes.
    this.ctl = join(o.runDir, `c-${randomBytes(6).toString('hex')}`);
    this.common = [
      '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${o.knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'UpdateHostKeys=no', '-o', 'CheckHostIP=no',
      '-o', `ProxyCommand=${node} ${SOCKS_HELPER} 127.0.0.1 ${o.socksPort} %h %p`,
      '-o', `ControlPath=${this.ctl}`,
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=20',
      '-o', 'LogLevel=ERROR', '-l', o.user,
    ];
  }

  get alive(): boolean {
    return !!this.master && this.master.exitCode === null && this.master.signalCode === null;
  }

  /** One login. Resolves when the master connection is up; `password` is the caller's to wipe. */
  async open(password: Buffer, timeoutMs = 45_000): Promise<void> {
    if (this.master) throw new Error('already open');
    const sock = join(this.o.runDir, `a-${randomBytes(6).toString('hex')}`);
    const wrapper = join(this.o.runDir, 'askpass.sh');
    const node = this.o.nodeBin ?? process.execPath;
    if (!existsSync(wrapper)) {
      // SSH_ASKPASS must be a program; this one only knows where to ask.
      writeFileSync(wrapper, `#!/bin/sh\nexec ${node} ${ASKPASS_HELPER} "$@"\n`, { mode: 0o700 });
    }
    const prompts: string[] = [];
    let answered = 0;
    const server: Server = createServer((c) => {
      let prompt = '';
      c.setTimeout(5000, () => c.destroy());
      c.on('data', (b: Buffer) => {
        prompt += b.toString('utf8');
        if (!prompt.includes('\n')) return;
        prompts.push(prompt.trim().slice(0, 200));
        // Exactly one answer, and only to something that asks for a password.
        if (answered === 0 && /password|passcode|\bpin\b/i.test(prompt)) {
          answered++;
          c.end(password);
        } else {
          c.end();
        }
      });
      c.on('error', () => undefined);
    });
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(sock, ok); });
    chmodSync(sock, 0o600);

    const child = spawn(this.o.bin, [...this.common,
      '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no',
      '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password',
      '-o', 'NumberOfPasswordPrompts=1', '-N', this.o.host,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: childEnv({ HOME: this.o.runDir, SSH_ASKPASS: wrapper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'none', TM_ASKPASS_SOCK: sock }),
    });
    this.master = child;
    let err = '';
    child.stderr!.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-8192); });
    const exited = new Promise<number>((r) => child.once('close', (code) => r(code ?? -1)));
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (!this.alive) {
          await exited;
          throw this.classify(err, prompts);
        }
        if (await this.check()) return;
        if (Date.now() > deadline) throw new SshFailed('timeout', SSH_MESSAGES.timeout);
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      server.close();
      rmSync(sock, { force: true });
    }
  }

  private classify(err: string, prompts: string[]): SshFailed {
    if (/host key verification failed|remote host identification has changed|no \S+ host key is known|host key for .* has changed/i.test(err)) {
      return new SshFailed('host_key', SSH_MESSAGES.host_key);
    }
    if (prompts.length > 0 && !prompts.some((p) => /password|passcode|\bpin\b/i.test(p))) return new SshFailed('unsupported', SSH_MESSAGES.unsupported);
    if (/permission denied|too many authentication failures/i.test(err)) return new SshFailed('bad_password', SSH_MESSAGES.bad_password);
    if (/connection (?:timed out|refused|closed)|could not resolve|kex_exchange|banner exchange|proxy/i.test(err)) return new SshFailed('unreachable', SSH_MESSAGES.unreachable);
    return new SshFailed('unreachable', SSH_MESSAGES.unreachable);
  }

  private check(): Promise<boolean> {
    return new Promise((r) => {
      const c = spawn(this.o.bin, [...this.common, '-o', 'BatchMode=yes', '-O', 'check', this.o.host], { stdio: 'ignore', env: childEnv({ HOME: this.o.runDir }) });
      c.on('close', (code) => r(code === 0));
      c.on('error', () => r(false));
    });
  }

  /**
   * A fixed command over the open connection. BatchMode: if the master has
   * gone, this fails instead of asking anyone for a password.
   */
  run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new SshFailed('unreachable', 'The HPC session has closed; sign in again.'));
      const child = spawn(this.o.bin, [...this.common, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', this.o.host, command], {
        stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: childEnv({ HOME: this.o.runDir }),
      });
      const max = opts.maxBytes ?? 1024 * 1024;
      const out: Buffer[] = [];
      let size = 0;
      let err = '';
      child.stdout!.on('data', (b: Buffer) => { if (size < max) { out.push(b); size += b.length; } });
      child.stderr!.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-16384); });
      if (opts.stdin) { opts.stdin.pipe(child.stdin!); child.stdin!.on('error', () => undefined); }
      const t = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 60_000);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).subarray(0, max), stderr: err });
      });
    });
  }

  async close(): Promise<void> {
    const m = this.master;
    this.master = null;
    if (!m || m.exitCode !== null || m.signalCode !== null) { rmSync(this.ctl, { force: true }); return; }
    const done = new Promise<void>((r) => m.once('close', () => r()));
    m.kill('SIGTERM');
    const t = setTimeout(() => m.kill('SIGKILL'), 5000);
    await done;
    clearTimeout(t);
    rmSync(this.ctl, { force: true });
  }
}
