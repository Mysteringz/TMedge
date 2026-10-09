/**
 * A shell on the cluster in the browser (module 02's CONSOLE, "ssh" mode):
 * the person's own SSH session to the cluster -- through their own HKUVPN
 * tunnel, over the ControlMaster connection they already have -- on a real
 * pseudo-terminal, carried over a WebSocket encrypted end to end
 * (src/shared/hpcterm.ts).
 *
 * - A terminal needs a live sign-in; opening one starts no new login.
 * - Nothing typed or printed is logged, stored or turned into a string here:
 *   bytes go from the socket through AES-GCM to the terminal and back.
 *   The audit log records that a terminal was opened and closed, and how
 *   long, nothing more.
 * - It keeps the HKU session busy (so it is not reaped under a working
 *   person) and closes after 30 minutes with no keystroke, or when the
 *   session, the console sign-in or the page goes.
 * - The pseudo-terminal is a few lines of Python (python3 is on the box for
 *   the deploy tools): Node has no pty, and without one, window resizing
 *   and full-screen programs (top, vim, passwd prompts) would not work.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { counterOf, DIR_C2S, DIR_S2C, T_DATA, T_EXIT, T_RESIZE, TERM_INFO, termAad, termIv, type TermTicket } from '../../../shared/hpcterm.js';
import { unb64u } from '../../../shared/hpcseal.js';
import type { Gateway } from './gateway.js';
import { childEnv } from './openconnect.js';

const IDLE_MS = 30 * 60_000;
const TICKET_MS = 60_000;
const MAX_PER_USER = 2;
const MAX_ALL = 8;

/** Runs argv[3:] on a pty sized argv[1] x argv[2]; fd 3 takes "cols rows" lines. */
export const PTY_BRIDGE = `
import os, sys, pty, select, struct, fcntl, termios, signal
cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
def size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(1, min(r, 500)), max(1, min(c, 1000)), 0, 0))
def out(b):
    while b:
        b = b[os.write(1, b):]
size(cols, rows)
fds, ctl = [0, fd, 3], b''
try:
    while True:
        r = select.select(fds, [], [])[0]
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out(data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                break
            while data:
                data = data[os.write(fd, data):]
        if 3 in r:
            data = os.read(3, 4096)
            if not data:
                fds.remove(3)
            ctl += data
            while b'\\n' in ctl:
                line, ctl = ctl.split(b'\\n', 1)
                parts = line.split()
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    size(int(parts[0]), int(parts[1]))
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
`;

interface Ticket { user: string; binding: string; ecdh: ECDH; expires: number }

interface Live { user: string; binding: string; ws: WebSocket; bridge: ChildProcess; openedAt: number }

export class Terminals {
  private tickets = new Map<string, Ticket>();
  private live = new Set<Live>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  constructor(private readonly gateway: Gateway, private readonly audit: (user: string, action: string, result: string) => void,
    private readonly python = 'python3', private readonly authorized: (req: IncomingMessage) => boolean = () => true) {}

  /** A one-time key for one terminal, bound to this console sign-in. */
  issue(user: string, binding: string): TermTicket {
    const now = Date.now();
    for (const [tid, t] of this.tickets) if (t.expires <= now) this.tickets.delete(tid);
    if ([...this.live].filter((l) => l.user === user).length >= MAX_PER_USER) throw new Error(`at most ${MAX_PER_USER} terminals each; close one first`);
    if (this.live.size >= MAX_ALL || this.tickets.size >= 64) throw new Error('too many terminals open on this server; try again shortly');
    const ecdh = createECDH('prime256v1');
    const publicKey = ecdh.generateKeys().toString('base64url');
    const tid = randomBytes(16).toString('base64url');
    this.tickets.set(tid, { user, binding, ecdh, expires: now + TICKET_MS });
    return { tid, publicKey };
  }

  /** Takes a WebSocket upgrade for /train-term. False if it is not ours to take or not valid. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, user: string, binding: string): boolean {
    const tid = url.searchParams.get('tid') ?? '';
    const t = this.tickets.get(tid);
    this.tickets.delete(tid);
    const session = this.gateway.live(user);
    let keys: { c2s: Buffer; s2c: Buffer } | null = null;
    try {
      if (!this.authorized(req) || !t || t.user !== user || t.binding !== binding || t.expires <= Date.now() || !session?.ssh) return false;
      const shared = t.ecdh.computeSecret(Buffer.from(unb64u(url.searchParams.get('epk') ?? '')));
      const okm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(unb64u(tid)), TERM_INFO, 64));
      shared.fill(0);
      keys = { c2s: Buffer.from(okm.subarray(0, 32)), s2c: Buffer.from(okm.subarray(32)) };
      okm.fill(0);
    } catch {
      return false;
    }
    const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('cols')) || 100));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 30));
    const k = keys;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req, tid, k, user, binding, cols, rows));
    return true;
  }

  private attach(ws: WebSocket, req: IncomingMessage, tid: string, keys: { c2s: Buffer; s2c: Buffer }, user: string, binding: string, cols: number, rows: number): void {
    const session = this.gateway.live(user);
    if (!this.authorized(req) || !session?.ssh) { ws.close(1011, 'no session'); return; }
    const shell = session.ssh.shellCommand();
    const bridge = spawn(this.python, ['-u', '-c', PTY_BRIDGE, String(cols), String(rows), shell.bin, ...shell.args], {
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      env: childEnv({ TERM: 'xterm-256color', HOME: shell.home, LANG: 'C.UTF-8' }),
    });
    const me: Live = { user, binding, ws, bridge, openedAt: Date.now() };
    this.live.add(me);
    this.audit(user, 'terminal_open', `${shell.target}`);
    const aad = Buffer.from(termAad(tid));
    let sent = 0;
    let expected = 0;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => close(4000, 'idle for 30 minutes'), IDLE_MS);
      session.lastUsed = Date.now();
    };

    const seal = (type: number, payload: Buffer) => {
      const plain = Buffer.alloc(1 + payload.length);
      plain[0] = type;
      payload.copy(plain, 1);
      const iv = Buffer.from(termIv(DIR_S2C, sent++));
      const c = createCipheriv('aes-256-gcm', keys.s2c, iv);
      c.setAAD(aad);
      const frame = Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
      plain.fill(0);
      return frame;
    };

    let closed = false;
    const close = (code: number, why: string) => {
      if (closed) return;
      closed = true;
      if (idle) clearTimeout(idle);
      this.live.delete(me);
      session.busy = Math.max(0, session.busy - 1);
      if (bridge.exitCode === null) bridge.kill('SIGTERM');
      if (ws.readyState === ws.OPEN) ws.close(code, why);
      keys.c2s.fill(0);
      keys.s2c.fill(0);
      this.audit(user, 'terminal_close', `${Math.round((Date.now() - me.openedAt) / 1000)}s ${why}`);
    };

    // Busy: the reaper leaves a session alone while someone works in it.
    session.busy++;
    bump();

    const authorityTimer = setInterval(() => { if (!this.authorized(req)) close(4001, 'session ended'); }, 5000);
    authorityTimer.unref();
    ws.on('close', () => clearInterval(authorityTimer));
    bridge.stdout!.on('data', (b: Buffer) => {
      if (!this.authorized(req)) { b.fill(0); close(4001, 'session ended'); return; }
      if (ws.readyState !== ws.OPEN) return;
      ws.send(seal(T_DATA, b));
      b.fill(0);
      // A browser that cannot keep up pauses the shell, rather than this process buffering without end.
      if (ws.bufferedAmount > 1024 * 1024) {
        bridge.stdout!.pause();
        const wait = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 256 * 1024) { clearInterval(wait); bridge.stdout!.resume(); }
        }, 50);
      }
    });
    bridge.on('close', (code) => {
      if (ws.readyState === ws.OPEN) ws.send(seal(T_EXIT, Buffer.from([Math.max(0, Math.min(255, code ?? 0))])));
      close(1000, `shell exited ${code ?? '?'}`);
    });
    bridge.on('error', () => close(1011, 'could not start the terminal'));
    bridge.stdin!.on('error', () => undefined);
    (bridge.stdio[3] as NodeJS.WritableStream).on('error', () => undefined);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!this.authorized(req)) { ws.terminate(); return; }
      if (!isBinary || data.length < 12 + 16 + 1) return close(1008, 'bad frame');
      const iv = data.subarray(0, 12);
      const { dir, counter } = counterOf(iv);
      if (dir !== DIR_C2S || counter !== expected) return close(1008, 'frame out of sequence');
      expected++;
      let plain: Buffer;
      try {
        const d = createDecipheriv('aes-256-gcm', keys.c2s, iv);
        d.setAAD(aad);
        d.setAuthTag(data.subarray(data.length - 16));
        plain = Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]);
      } catch {
        return close(1008, 'frame failed authentication');
      }
      data.fill(0);
      const type = plain[0];
      if (type === T_DATA) { bridge.stdin!.write(plain.subarray(1), () => plain.fill(0)); bump(); }
      else if (type === T_RESIZE && plain.length === 5) {
        (bridge.stdio[3] as NodeJS.WritableStream).write(`${plain.readUInt16BE(1)} ${plain.readUInt16BE(3)}\n`);
        plain.fill(0);
      } else plain.fill(0);
      return undefined;
    });
    ws.on('close', () => close(1000, 'page closed'));
    ws.on('error', () => close(1011, 'socket error'));
    // The SSH session ending (sign-out of HKU, reaper, tunnel loss) ends the mux client, and so this.
  }

  /** The console sign-in ended (logout, account removed): its terminals go with it. */
  closeFor(binding: string): void {
    for (const l of this.live) if (l.binding === binding) { l.ws.close(4001, 'signed out'); l.bridge.kill('SIGTERM'); }
  }

  closeAll(): void {
    for (const l of this.live) { l.ws.close(1001, 'server stopping'); l.bridge.kill('SIGTERM'); }
  }

  count(user: string): number {
    return [...this.live].filter((l) => l.user === user).length;
  }
}
