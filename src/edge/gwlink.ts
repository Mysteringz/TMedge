/**
 * Gateway link, protocol "TMGW" v1 -- SOURCE OF TRUTH (mirrored by
 * TMWAccess/src/gwlink.ts; change both together and run TMWAccess's
 * `npm run crosscheck`, which drives this server).
 *
 * An access gateway (TMWAccess on Wi-Fi today, TMLAccess on LoRa later) sits
 * on the nodes' local network and holds ONE outbound TCP connection to the
 * edge. Node datagrams travel up it byte for byte -- still carrying the
 * node's own HMAC, which the edge verifies as if the node had sent directly;
 * the gateway never holds the node key and cannot forge occupancy. Commands
 * for those nodes come back down the same connection, so the gateway's site
 * needs no inbound port and works behind NAT or through a SOCKS proxy.
 *
 * Framing: u32 LE length (of type + payload), u8 type, payload. Max 64 KiB.
 *
 *   0x01 HELLO     gw -> edge   JSON {v:1, gatewayId, ts, nonce, mac}
 *                               mac = hex HMAC-SHA256(TMGW_TOKEN, "tmgw1|<gatewayId>|<ts>|<nonce>")
 *   0x02 WELCOME   edge -> gw   JSON {v:1, edgeId}
 *   0x03 DENY      edge -> gw   JSON {reason}, then close
 *   0x10 UPLINK    gw -> edge   u8 addrLen, addr (ascii), u16 LE port, datagram
 *   0x20 DOWNLINK  edge -> gw   u8 addrLen, addr, u16 LE port, datagram (a TM COMMAND)
 *   0x30 PING / 0x31 PONG       u64 LE ms (either direction; the other echoes)
 *   0x40 STATS     gw -> edge   JSON, gateway-defined counters (shown in the console)
 *
 * Nodes heard through a gateway get the address "gw:<gatewayId>|<ip>:<port>",
 * which is how the edge routes their commands back. The port is the node's
 * source port and informational only: gateways deliver commands to the node's
 * fixed command port (TMnode TM_DOWNLINK_PORT, 5201), and only to a node they
 * have heard from at that address -- a gateway is not an open relay.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

export const TMGW_VERSION = 1;
export const T_HELLO = 0x01;
export const T_WELCOME = 0x02;
export const T_DENY = 0x03;
export const T_UPLINK = 0x10;
export const T_DOWNLINK = 0x20;
export const T_PING = 0x30;
export const T_PONG = 0x31;
export const T_STATS = 0x40;
export const MAX_FRAME = 64 * 1024;
const HELLO_WINDOW_MS = 60_000;

export function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

export function addressed(addr: string, port: number, datagram: Buffer): Buffer {
  const a = Buffer.from(addr, 'ascii');
  if (a.length > 255) throw new Error('address too long');
  const head = Buffer.alloc(1 + a.length + 2);
  head[0] = a.length;
  a.copy(head, 1);
  head.writeUInt16LE(port, 1 + a.length);
  return Buffer.concat([head, datagram]);
}

export function parseAddressed(p: Buffer): { addr: string; port: number; datagram: Buffer } | null {
  const n = p[0];
  if (n === undefined || p.length < 1 + n + 2) return null;
  return { addr: p.subarray(1, 1 + n).toString('ascii'), port: p.readUInt16LE(1 + n), datagram: p.subarray(3 + n) };
}

export function helloMac(token: Buffer, gatewayId: string, ts: number, nonce: string): string {
  return createHmac('sha256', token).update(`tmgw1|${gatewayId}|${ts}|${nonce}`).digest('hex');
}

/** Incremental frame reader for a TCP stream. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (type: number, payload: Buffer) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len < 1 || len > MAX_FRAME) throw new Error(`bad frame length ${len}`);
      if (this.buf.length < 4 + len) return;
      const type = this.buf[4] ?? 0;
      const payload = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      onFrame(type, payload);
    }
  }
}

export interface GatewayInfo {
  id: string;
  remote: string;
  connectedAt: number;
  lastSeen: number;
  uplink: number;
  downlink: number;
  rttMs: number | null;
  stats: Record<string, unknown> | null;
}

export interface GatewayServerOptions {
  port: number;
  host: string;
  token: Buffer;
  edgeId: string;
  allowRemote?: (address: string) => boolean;
  /** A node datagram arrived via a gateway; `source` is "gw:<id>|<ip>:<port>". */
  onUplink: (datagram: Buffer, source: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

interface Conn {
  socket: Socket;
  info: GatewayInfo;
}

export class GatewayServer {
  private readonly server: Server;
  private readonly conns = new Map<string, Conn>();
  private readonly now: () => number;

  constructor(private readonly opts: GatewayServerOptions) {
    this.now = opts.now ?? Date.now;
    this.server = createServer((s) => this.accept(s));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(this.opts.port, this.opts.host, () => {
      const a = this.server.address();
      resolve(typeof a === 'object' && a ? a.port : this.opts.port);
    }));
  }

  close(): Promise<void> {
    for (const c of this.conns.values()) c.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  gateways(): GatewayInfo[] {
    return [...this.conns.values()].map((c) => ({ ...c.info }));
  }

  /** Route a command to a node heard through a gateway. False if that gateway is not connected. */
  sendDownlink(source: string, datagram: Buffer): boolean {
    const m = /^gw:([^|]+)\|(.+):(\d+)$/.exec(source);
    if (!m) return false;
    const [, id, addr, port] = m;
    const c = this.conns.get(id ?? '');
    if (!c || !addr || !port) return false;
    c.socket.write(frame(T_DOWNLINK, addressed(addr, Number(port), datagram)));
    c.info.downlink += 1;
    return true;
  }

  private accept(socket: Socket): void {
    const remote = socket.remoteAddress ?? '?';
    if (this.opts.allowRemote && !this.opts.allowRemote(remote)) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    const reader = new FrameReader();
    let conn: Conn | null = null;
    // An unauthenticated connection gets a few seconds to say HELLO.
    const helloTimer = setTimeout(() => socket.destroy(), 5000);
    const deny = (reason: string) => {
      this.opts.log?.(`gateway from ${remote} refused: ${reason}`);
      socket.end(frame(T_DENY, Buffer.from(JSON.stringify({ reason }))));
    };

    socket.on('data', (chunk) => {
      try {
        reader.push(chunk, (type, payload) => {
          if (!conn) {
            if (type !== T_HELLO) return deny('HELLO expected');
            let h: { v?: number; gatewayId?: string; ts?: number; nonce?: string; mac?: string };
            try {
              h = JSON.parse(payload.toString('utf8')) as typeof h;
            } catch {
              return deny('bad HELLO');
            }
            const id = h.gatewayId ?? '';
            if (h.v !== TMGW_VERSION || !/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof h.ts !== 'number' || typeof h.nonce !== 'string') {
              return deny('bad HELLO');
            }
            if (Math.abs(this.now() - h.ts) > HELLO_WINDOW_MS) return deny('clock skew or replayed HELLO');
            const want = Buffer.from(helloMac(this.opts.token, id, h.ts, h.nonce));
            const got = Buffer.from(String(h.mac ?? ''));
            if (want.length !== got.length || !timingSafeEqual(want, got)) return deny('bad token');
            clearTimeout(helloTimer);
            // A gateway that reconnects replaces its old connection.
            this.conns.get(id)?.socket.destroy();
            conn = { socket, info: { id, remote, connectedAt: this.now(), lastSeen: this.now(), uplink: 0, downlink: 0, rttMs: null, stats: null } };
            this.conns.set(id, conn);
            socket.write(frame(T_WELCOME, Buffer.from(JSON.stringify({ v: TMGW_VERSION, edgeId: this.opts.edgeId }))));
            this.opts.log?.(`gateway ${id} connected from ${remote}`);
            return undefined;
          }
          conn.info.lastSeen = this.now();
          switch (type) {
            case T_UPLINK: {
              const u = parseAddressed(payload);
              if (!u) return undefined;
              conn.info.uplink += 1;
              this.opts.onUplink(Buffer.from(u.datagram), `gw:${conn.info.id}|${u.addr}:${u.port}`);
              return undefined;
            }
            case T_PING:
              socket.write(frame(T_PONG, payload));
              return undefined;
            case T_PONG:
              if (payload.length >= 8) conn.info.rttMs = this.now() - Number(payload.readBigUInt64LE(0));
              return undefined;
            case T_STATS:
              try {
                conn.info.stats = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
              } catch {
                /* ignore */
              }
              return undefined;
            default:
              return undefined;
          }
        });
      } catch (err) {
        this.opts.log?.(`gateway ${conn?.info.id ?? remote}: ${(err as Error).message}; closing`);
        socket.destroy();
      }
    });
    const ping = setInterval(() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(this.now()));
      if (conn) socket.write(frame(T_PING, b));
    }, 10_000);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(ping);
      if (conn && this.conns.get(conn.info.id) === conn) {
        this.conns.delete(conn.info.id);
        this.opts.log?.(`gateway ${conn.info.id} disconnected`);
      }
    });
  }
}
