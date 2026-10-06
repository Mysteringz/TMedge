/**
 * VPN Session Manager (HANDOVER.md §6.4): per person, a tunnel and an SSH
 * connection that live for VPN_IDLE_TTL after last use, so refreshing a
 * job's state, reading its log or cancelling it needs no new code.
 *
 * Its promises:
 * - one login attempt per call, never a retry (rule 4);
 * - three failed logins in 15 minutes stop further attempts for 15 minutes,
 *   per dashboard account and per HKU UID, before anything reaches HKU --
 *   this protects the person's HKU account from lockout;
 * - one session per person, at most maxSessions in all (HTTP 429 beyond);
 * - credentials are the caller's, and the caller wipes them; nothing here
 *   keeps a reference after open() returns.
 *
 * In process, with a single worker (rule 5): credentials must not cross a
 * process boundary to reach it.
 */
import { createServer } from 'node:net';
import { AUTH_MESSAGES, AuthFailed, authenticate, connectTunnel, type AuthOptions, type AuthResult, type ConnectOptions, type Tunnel } from './openconnect.js';
import type { Credentials } from './sealed.js';
import { SshFailed, SshLink, type SshLike, type SshOptions } from './ssh.js';

export type Step = 'vpn_auth' | 'vpn_connect' | 'vpn_up' | 'ssh_auth' | 'ssh_up';

export class LockedOut extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Three HKU logins failed in the last 15 minutes. To protect your HKU account from being locked, the dashboard will not try again for ${Math.ceil(retryAfterMs / 60_000)} min.`);
  }
}
export class GatewayBusy extends Error {}

export interface GatewayDeps {
  authenticate(o: AuthOptions): Promise<AuthResult>;
  connectTunnel(o: ConnectOptions): Promise<Tunnel>;
  ssh(o: SshOptions): SshLike;
  portFree(port: number): Promise<boolean>;
  now(): number;
}

export interface GatewayConfig {
  vpnHost: string;
  vpnServerCert: string | null;
  vpnAuthGroup: string | null;
  submitHost: string;
  /** A shared SSH account, or null for each person's own UID. */
  sshUser: string | null;
  knownHosts: string;
  runDir: string;
  idleTtlMs: number;
  maxSessions: number;
  ports: [number, number];
  tools: { openconnect: string; ocproxy: string; ssh: string };
}

export interface Session {
  user: string;
  uid: string;
  port: number;
  state: 'opening' | 'up' | 'closing';
  openedAt: number;
  lastUsed: number;
  tunnel: Tunnel | null;
  ssh: SshLike | null;
  /** Operations using it right now; the reaper waits for them. */
  busy: number;
}

export const LOCKOUT_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_FAILURES = 3;

function portFree(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

export const REAL_DEPS: GatewayDeps = {
  authenticate, connectTunnel, ssh: (o) => new SshLink(o), portFree, now: Date.now,
};

export class Gateway {
  private sessions = new Map<string, Session>();
  private failures = new Map<string, number[]>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: GatewayConfig, private readonly deps: GatewayDeps = REAL_DEPS) {}

  start(): void {
    this.reaper ??= setInterval(() => void this.reap(), 30_000);
    this.reaper.unref();
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await Promise.all([...this.sessions.keys()].map((u) => this.close(u)));
  }

  /** A session ready to use, or null (none, still opening, or its tunnel or SSH died). */
  live(user: string): Session | null {
    const s = this.sessions.get(user);
    if (!s || s.state !== 'up') return null;
    if (!s.ssh?.alive) { void this.close(user); return null; }
    return s;
  }

  info(user: string): { state: 'none' | 'opening' | 'up'; uid: string | null; expiresInSeconds: number | null } {
    const s = this.sessions.get(user);
    if (!s) return { state: 'none', uid: null, expiresInSeconds: null };
    if (s.state === 'opening') return { state: 'opening', uid: s.uid, expiresInSeconds: null };
    if (!this.live(user)) return { state: 'none', uid: null, expiresInSeconds: null };
    return { state: 'up', uid: s.uid, expiresInSeconds: Math.max(0, Math.round((s.lastUsed + this.cfg.idleTtlMs - this.deps.now()) / 1000)) };
  }

  /** How long `user` (or this HKU UID) must wait before another login; 0 if not locked out. */
  lockedFor(user: string, uid: string): number {
    const now = this.deps.now();
    let wait = 0;
    for (const key of [`user:${user}`, `uid:${uid}`]) {
      const recent = (this.failures.get(key) ?? []).filter((t) => now - t < LOCKOUT_WINDOW_MS);
      this.failures.set(key, recent);
      if (recent.length >= LOCKOUT_FAILURES) wait = Math.max(wait, recent[recent.length - LOCKOUT_FAILURES]! + LOCKOUT_WINDOW_MS - now);
    }
    return wait;
  }

  private fail(user: string, uid: string): void {
    const now = this.deps.now();
    for (const key of [`user:${user}`, `uid:${uid}`]) this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }

  private async pickPort(): Promise<number> {
    const used = new Set([...this.sessions.values()].map((s) => s.port));
    for (let p = this.cfg.ports[0]; p <= this.cfg.ports[1]; p++) {
      if (!used.has(p) && (await this.deps.portFree(p))) return p;
    }
    throw new GatewayBusy('No free local port for another HKU session; try again shortly.');
  }

  /**
   * Logs `user` in to HKU as `uid`: VPN (PIN, then code), tunnel, SSH (PIN).
   * One attempt. Throws LockedOut, GatewayBusy, AuthFailed or SshFailed.
   */
  async open(user: string, uid: string, vpnUser: string, creds: Credentials, onStep: (s: Step) => void = () => undefined): Promise<Session> {
    const wait = this.lockedFor(user, uid);
    if (wait > 0) throw new LockedOut(wait);
    const existing = this.sessions.get(user);
    if (existing?.state === 'opening') throw new GatewayBusy('An HKU sign-in is already in progress for you.');
    if (existing) await this.close(user);
    if (this.sessions.size >= this.cfg.maxSessions) throw new GatewayBusy(`All ${this.cfg.maxSessions} HKU sessions on this server are in use; try again in a few minutes.`);
    const now = this.deps.now();
    const session: Session = { user, uid, port: 0, state: 'opening', openedAt: now, lastUsed: now, tunnel: null, ssh: null, busy: 0 };
    this.sessions.set(user, session);
    let auth: AuthResult | null = null;
    try {
      session.port = await this.pickPort();
      onStep('vpn_auth');
      try {
        auth = await this.deps.authenticate({
          bin: this.cfg.tools.openconnect, host: this.cfg.vpnHost, vpnUser, creds,
          serverCert: this.cfg.vpnServerCert, authGroup: this.cfg.vpnAuthGroup,
        });
      } catch (err) {
        if (err instanceof AuthFailed && (err.code === 'bad_credentials' || err.code === 'bad_otp')) this.fail(user, uid);
        throw err;
      }
      onStep('vpn_connect');
      session.tunnel = await this.deps.connectTunnel({ bin: this.cfg.tools.openconnect, ocproxy: this.cfg.tools.ocproxy, auth, port: session.port });
      auth.cookie.fill(0);
      auth = null;
      void session.tunnel.closed.then(() => { if (this.sessions.get(user) === session) void this.close(user); });
      onStep('vpn_up');
      onStep('ssh_auth');
      session.ssh = this.deps.ssh({
        bin: this.cfg.tools.ssh, host: this.cfg.submitHost, user: this.cfg.sshUser ?? uid, socksPort: session.port,
        knownHosts: this.cfg.knownHosts, runDir: this.cfg.runDir,
      });
      try {
        await session.ssh.open(creds.sshPassword());
      } catch (err) {
        if (err instanceof SshFailed && err.code === 'bad_password') this.fail(user, uid);
        throw err;
      }
      onStep('ssh_up');
      session.state = 'up';
      session.lastUsed = this.deps.now();
      this.failures.delete(`user:${user}`);
      this.failures.delete(`uid:${uid}`);
      return session;
    } catch (err) {
      auth?.cookie.fill(0);
      await this.close(user);
      throw err;
    }
  }

  /**
   * Runs `fn` with the live session, keeping it from being reaped meanwhile.
   * `touch: false` is for the background poller: watching a job is not using
   * the session, and must not keep it open forever.
   */
  async use<T>(user: string, fn: (s: Session) => Promise<T>, touch = true): Promise<T> {
    const s = this.live(user);
    if (!s) throw new GatewayBusy('No HKU session; sign in first.');
    s.busy++;
    if (touch) s.lastUsed = this.deps.now();
    try {
      return await fn(s);
    } finally {
      s.busy--;
      if (touch) s.lastUsed = this.deps.now();
    }
  }

  async close(user: string): Promise<void> {
    const s = this.sessions.get(user);
    if (!s || s.state === 'closing') return;
    s.state = 'closing';
    try {
      await s.ssh?.close();
      await s.tunnel?.close();
    } finally {
      if (this.sessions.get(user) === s) this.sessions.delete(user);
    }
  }

  /** Idle sessions go; so do sessions whose SSH connection has died. */
  async reap(): Promise<void> {
    const now = this.deps.now();
    for (const [user, s] of this.sessions) {
      if (s.state !== 'up' || s.busy > 0) continue;
      if (now - s.lastUsed > this.cfg.idleTtlMs || !s.ssh?.alive) await this.close(user);
    }
  }

  /** For the poller: who has a session right now. */
  users(): string[] {
    return [...this.sessions.values()].filter((s) => s.state === 'up').map((s) => s.user);
  }
}

export { AUTH_MESSAGES };
