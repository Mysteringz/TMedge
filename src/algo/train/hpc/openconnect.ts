/**
 * The VPN half of Plan A (HANDOVER.md §6.4): openconnect against
 * vpn2fa.hku.hk in two steps, so a bad PIN or code is told apart from a
 * broken tunnel.
 *
 * 1. authenticate: the PIN and then the one-time code go in on stdin and a
 *    session cookie comes back on stdout.
 * 2. connect: the cookie goes in on stdin, and ocproxy turns the tunnel into
 *    a SOCKS5 port on loopback -- no root, no tun device, no route on the box.
 *
 * Two rules come from trying this against a real AnyConnect server:
 *
 * - **The code is sent only when it is asked for.** After a wrong PIN,
 *   openconnect shows the login form again and reads the next line of stdin
 *   as a second password -- which, fed up front, is the code. One typo would
 *   cost two failed logins on the person's HKU account and send their code as
 *   a password. So the PIN goes first, the code waits for openconnect's next
 *   prompt, and "Login failed" before that prompt ends the process. One
 *   attempt per click, never a retry (rule 4).
 * - **openconnect's stderr is never shown or logged.** It prints the
 *   server's Set-Cookie headers. It is read only to classify a failure, and
 *   every message that leaves this file is a fixed sentence.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect as tcpConnect } from 'node:net';
import type { Credentials } from './sealed.js';

export type AuthFailure = 'bad_credentials' | 'bad_otp' | 'server_error' | 'timeout' | 'unsupported';

export class AuthFailed extends Error {
  constructor(readonly code: AuthFailure, message: string) { super(message); }
}

export interface AuthResult {
  /** The VPN session cookie: a credential, so bytes that the caller wipes. */
  cookie: Buffer;
  connectUrl: string;
  fingerprint: string;
  resolve: string | null;
}

/** What a person is told; never anything openconnect printed. */
export const AUTH_MESSAGES: Record<AuthFailure, string> = {
  bad_credentials: 'HKU did not accept the UID or PIN. Nothing was retried.',
  bad_otp: 'HKU accepted the PIN but not the one-time code. Wait for a new code and try again.',
  server_error: 'Could not reach the HKU VPN, or it refused the connection.',
  timeout: 'The HKU VPN did not answer in time.',
  unsupported: 'The HKU VPN asked for something this dashboard cannot answer (see docs/hpc/m0-checklist.md).',
};

/** A clean environment: the edge's own secrets (TM_KEY, SESSION_SECRET...) stay with the edge. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', ...extra };
}

const FAILED = /login failed|authentication failed|access denied|invalid (?:username|password|credentials)|incorrect|requested basic authentication/i;
const UNREACHABLE = /failed to connect to host|failed to open https connection|could not resolve|name or service not known|connection refused|network is unreachable|no route to host|certificate (?:verify|validation)|server certificate/i;
/** Things a stdin login cannot do: Cisco host scan, SAML/browser sign-in, a group menu. */
const UNSUPPORTED = /\bcsd\b|hostscan|trojan|\bsaml\b|single sign-on|external browser|select (?:a )?group/i;

/**
 * Pulls COOKIE= and friends out of `openconnect --authenticate` stdout
 * without ever turning the cookie into a string. Values are shell-quoted
 * ('...' with ' written as '\'').
 */
export function parseAuthOutput(out: Buffer): AuthResult | null {
  const fields = new Map<string, Buffer>();
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0x0a, start);
    if (end < 0) end = out.length;
    const line = out.subarray(start, end);
    start = end + 1;
    const eq = line.indexOf(0x3d);
    if (eq < 1 || line[eq + 1] !== 0x27 || line[line.length - 1] !== 0x27) continue;
    const name = line.subarray(0, eq).toString('latin1');
    if (!/^[A-Z_]+$/.test(name)) continue;
    // Unquote: drop the outer quotes and turn each '\'' back into '.
    const inner = line.subarray(eq + 2, line.length - 1);
    const value = Buffer.alloc(inner.length);
    let n = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === 0x27 && inner[i + 1] === 0x5c && inner[i + 2] === 0x27 && inner[i + 3] === 0x27) { value[n++] = 0x27; i += 3; }
      else value[n++] = inner[i]!;
    }
    fields.set(name, value.subarray(0, n));
  }
  const cookie = fields.get('COOKIE');
  const url = fields.get('CONNECT_URL')?.toString('latin1');
  const fingerprint = fields.get('FINGERPRINT')?.toString('latin1');
  const resolve = fields.get('RESOLVE')?.toString('latin1') ?? null;
  for (const [k, v] of fields) if (k !== 'COOKIE') v.fill(0);
  if (!cookie || cookie.length === 0 || !url || !fingerprint || !/^https:\/\/[^\s'"]+$/.test(url) || !/^[A-Za-z0-9:+/=-]+$/.test(fingerprint)) {
    cookie?.fill(0);
    return null;
  }
  return { cookie, connectUrl: url, fingerprint, resolve: resolve && /^[A-Za-z0-9.:-]+$/.test(resolve) ? resolve : null };
}

export interface AuthOptions {
  bin: string;
  host: string;
  vpnUser: string;
  creds: Credentials;
  serverCert: string | null;
  authGroup: string | null;
  timeoutMs?: number;
}

/**
 * One login attempt. Resolves with the cookie or rejects with AuthFailed;
 * never leaves a process behind, and never sends anything but the PIN once
 * and the code once.
 */
export function authenticate(o: AuthOptions): Promise<AuthResult> {
  return new Promise((resolve, reject) => {
    const args = ['--protocol=anyconnect', '--authenticate', `--user=${o.vpnUser}`, '--passwd-on-stdin'];
    if (o.serverCert) args.push(`--servercert=${o.serverCert}`);
    if (o.authGroup) args.push(`--authgroup=${o.authGroup}`);
    args.push(o.host);
    const child = spawn(o.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
    const outChunks: Buffer[] = [];
    let err = '';
    let otpSent = false;
    let failedBeforeOtp = false;
    let verdict: AuthFailed | null = null;
    let promptTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const stop = (why: AuthFailed) => {
      if (!verdict) verdict = why;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => stop(new AuthFailed('timeout', AUTH_MESSAGES.timeout)), o.timeoutMs ?? 45_000);

    /** Bytes go in, and the copy made for the pipe is zeroed once the pipe has it. */
    const send = (secret: Buffer, then?: () => void) => {
      const line = Buffer.alloc(secret.length + 1);
      secret.copy(line);
      line[secret.length] = 0x0a;
      child.stdin.write(line, () => { line.fill(0); then?.(); });
    };

    // A prompt is a line that ends in ":" and then nothing more arrives:
    // openconnect is waiting on stdin.
    const onPrompt = () => {
      const last = err.slice(err.lastIndexOf('\n') + 1);
      if (otpSent) return stop(new AuthFailed(FAILED.test(err) ? 'bad_otp' : 'unsupported', FAILED.test(err) ? AUTH_MESSAGES.bad_otp : AUTH_MESSAGES.unsupported));
      if (failedBeforeOtp) return stop(new AuthFailed('bad_credentials', AUTH_MESSAGES.bad_credentials));
      // A group menu or a username prompt is not the code: never answer it with the code.
      if (UNSUPPORTED.test(last) || /group|user ?name|\[/i.test(last)) return stop(new AuthFailed('unsupported', AUTH_MESSAGES.unsupported));
      otpSent = true;
      send(o.creds.otp(), () => child.stdin.end());
    };

    child.stdout.on('data', (b: Buffer) => outChunks.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8');
      if (err.length > 65536) err = err.slice(-32768);
      if (!otpSent && FAILED.test(err)) {
        // The form is coming back for another password: end it now.
        failedBeforeOtp = true;
        return stop(new AuthFailed('bad_credentials', AUTH_MESSAGES.bad_credentials));
      }
      if (promptTimer) clearTimeout(promptTimer);
      if (/:\s*$/.test(err) && !err.endsWith('\n')) promptTimer = setTimeout(onPrompt, 150);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => stop(new AuthFailed('unsupported', 'openconnect could not be started on this server')));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (promptTimer) clearTimeout(promptTimer);
      if (settled) return;
      settled = true;
      const out = Buffer.concat(outChunks);
      for (const c of outChunks) c.fill(0);
      const parsed = code === 0 && !verdict ? parseAuthOutput(out) : null;
      out.fill(0);
      if (parsed) return resolve(parsed);
      if (verdict) return reject(verdict);
      if (UNREACHABLE.test(err) && !otpSent) return reject(new AuthFailed('server_error', AUTH_MESSAGES.server_error));
      if (UNSUPPORTED.test(err)) return reject(new AuthFailed('unsupported', AUTH_MESSAGES.unsupported));
      if (otpSent && FAILED.test(err)) return reject(new AuthFailed('bad_otp', AUTH_MESSAGES.bad_otp));
      if (FAILED.test(err)) return reject(new AuthFailed('bad_credentials', AUTH_MESSAGES.bad_credentials));
      return reject(new AuthFailed('server_error', AUTH_MESSAGES.server_error));
    });

    // The PIN now: --passwd-on-stdin reads the first line before the first form.
    send(o.creds.pin());
  });
}

export interface Tunnel {
  pid: number;
  port: number;
  /** Resolves when openconnect has gone, for whatever reason. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/** True once something on the port speaks SOCKS5 (a no-auth greeting is answered). */
export function socksReady(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const s = tcpConnect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); done(false); }, timeoutMs);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.once('data', (b: Buffer) => { clearTimeout(t); s.destroy(); done(b[0] === 5 && b[1] === 0); });
    s.once('error', () => { clearTimeout(t); done(false); });
  });
}

export interface ConnectOptions {
  bin: string;
  ocproxy: string;
  auth: AuthResult;
  port: number;
  timeoutMs?: number;
}

/**
 * Brings the tunnel up from a cookie. The cookie is wiped as soon as the
 * pipe has it; the caller still owns `auth` and wipes it too.
 */
export function connectTunnel(o: ConnectOptions): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(o.ocproxy) || !Number.isInteger(o.port)) return reject(new Error('bad ocproxy path or port'));
    const args = ['--protocol=anyconnect', '--cookie-on-stdin', `--servercert=${o.auth.fingerprint}`];
    if (o.auth.resolve) args.push(`--resolve=${o.auth.resolve}`);
    // ocproxy binds 127.0.0.1 only (no -g), so the port is this box's alone.
    args.push('--script-tun', '--script', `${o.ocproxy} -D ${o.port} -k 30`, o.auth.connectUrl);
    const child: ChildProcess = spawn(o.bin, args, { stdio: ['pipe', 'ignore', 'pipe'], env: childEnv() });
    let err = '';
    child.stderr!.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-8192); });
    const closed = new Promise<void>((r) => child.once('close', () => r()));
    let up = false;
    const line = Buffer.alloc(o.auth.cookie.length + 1);
    o.auth.cookie.copy(line);
    line[line.length - 1] = 0x0a;
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(line, () => line.fill(0));

    const deadline = Date.now() + (o.timeoutMs ?? 30_000);
    const tunnel: Tunnel = {
      pid: child.pid ?? -1, port: o.port, closed,
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        // SIGTERM makes openconnect log off, which invalidates the cookie at HKU.
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed;
        clearTimeout(t);
      },
    };
    void closed.then(() => { if (!up) reject(new AuthFailed('server_error', 'The VPN accepted the login but the tunnel did not come up.')); });
    const poll = async () => {
      while (!up && child.exitCode === null && Date.now() < deadline) {
        if (await socksReady(o.port, 500)) { up = true; return resolve(tunnel); }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!up) { await tunnel.close(); reject(new AuthFailed('timeout', 'The VPN tunnel did not come up in time.')); }
    };
    void poll();
  });
}
