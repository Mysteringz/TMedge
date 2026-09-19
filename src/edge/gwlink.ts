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
 * Transports, on the same port: raw TCP, or a WebSocket at path /tmgw
 * carrying the same frames as binary messages (one or more frames per
 * message). The WebSocket form is what Cloudflare Tunnel carries
 * (wss://gw.<domain>/tmgw), so a gateway needs nothing but outbound HTTPS.
 * The two cannot be confused: an HTTP request starts "GET ", which as a frame
 * length is 542 MB, far beyond MAX_FRAME.
 *
 * Nodes heard through a gateway get the address "gw:<gatewayId>|<ip>:<port>",
 * which is how the edge routes their commands back. The port is the node's
 * source port and informational only: gateways deliver commands to the node's
 * fixed command port (TMnode TM_DOWNLINK_PORT, 5201), and only to a node they
 * have heard from at that address -- a gateway is not an open relay.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

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
  transport: 'tcp' | 'websocket';
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

/** One gateway session, whatever carries it. */
interface Link {
  transport: 'tcp' | 'websocket';
  remote: string;
  write(b: Buffer): void;
  end(b: Buffer): void;
  destroy(): void;
  onData(cb: (b: Buffer) => void): void;
  onClose(cb: () => void): void;
}

interface Conn {
  link: Link;
  info: GatewayInfo;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function tcpLink(socket: Socket): Link {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
  socket.on('error', () => undefined);
  return {
    transport: 'tcp',
    remote: socket.remoteAddress ?? '?',
    write: (b) => void socket.write(b),
    end: (b) => void socket.end(b),
    destroy: () => socket.destroy(),
    onData: (cb) => void socket.on('data', cb),
    onClose: (cb) => void socket.on('close', cb),
  };
}

function wsLink(ws: WebSocket, req: IncomingMessage): Link {
  // Through Cloudflare Tunnel the socket is cloudflared on loopback; the
  // gateway's own address arrives in CF-Connecting-IP, trusted only then.
  const peer = req.socket.remoteAddress ?? '?';
  const cf = req.headers['cf-connecting-ip'];
  const remote = LOOPBACK.test(peer) && typeof cf === 'string' ? `${cf} via Cloudflare` : peer;
  ws.on('error', () => undefined);
  return {
    transport: 'websocket',
    remote,
    write: (b) => ws.send(b, { binary: true }),
    end: (b) => ws.send(b, { binary: true }, () => ws.close(1008)),
    destroy: () => ws.terminate(),
    onData: (cb) => void ws.on('message', (d: Buffer | ArrayBuffer | Buffer[]) => cb(Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d))),
    onClose: (cb) => void ws.on('close', cb),
  };
}

export class GatewayServer {
  private readonly server: Server;
  private readonly http = createHttpServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('TMGW: connect with a WebSocket to /tmgw\n');
  });
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly conns = new Map<string, Conn>();
  private readonly now: () => number;

  constructor(private readonly opts: GatewayServerOptions) {
    this.now = opts.now ?? Date.now;
    this.server = createServer((s) => this.accept(s));
    this.http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/tmgw') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.session(wsLink(ws, req)));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(this.opts.port, this.opts.host, () => {
      const a = this.server.address();
      resolve(typeof a === 'object' && a ? a.port : this.opts.port);
    }));
  }

  close(): Promise<void> {
    for (const c of this.conns.values()) c.link.destroy();
    this.wss.close();
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
    c.link.write(frame(T_DOWNLINK, addressed(addr, Number(port), datagram)));
    c.info.downlink += 1;
    return true;
  }

  /** Sniff the first bytes: an HTTP request goes to the WebSocket server, anything else is raw TMGW. */
  private accept(socket: Socket): void {
    const remote = socket.remoteAddress ?? '?';
    if (this.opts.allowRemote && !this.opts.allowRemote(remote)) {
      socket.destroy();
      return;
    }
    socket.on('error', () => undefined);
    const sniff = setTimeout(() => socket.destroy(), 5000);
    socket.once('data', (first: Buffer) => {
      clearTimeout(sniff);
      socket.pause();
      socket.unshift(first);
      if (first.length >= 4 && first.subarray(0, 4).toString('latin1') === 'GET ') {
        this.http.emit('connection', socket);
      } else {
        this.session(tcpLink(socket));
      }
      socket.resume();
    });
  }

  private session(link: Link): void {
    const reader = new FrameReader();
    let conn: Conn | null = null;
    // An unauthenticated session gets a few seconds to say HELLO.
    const helloTimer = setTimeout(() => link.destroy(), 5000);
    const deny = (reason: string) => {
      this.opts.log?.(`gateway from ${link.remote} refused: ${reason}`);
      link.end(frame(T_DENY, Buffer.from(JSON.stringify({ reason }))));
    };

    link.onData((chunk) => {
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
            // A gateway that reconnects (or fails over to its other route) replaces its old session.
            this.conns.get(id)?.link.destroy();
            conn = { link, info: { id, remote: link.remote, transport: link.transport, connectedAt: this.now(), lastSeen: this.now(), uplink: 0, downlink: 0, rttMs: null, stats: null } };
            this.conns.set(id, conn);
            link.write(frame(T_WELCOME, Buffer.from(JSON.stringify({ v: TMGW_VERSION, edgeId: this.opts.edgeId }))));
            this.opts.log?.(`gateway ${id} connected over ${link.transport} from ${link.remote}`);
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
              link.write(frame(T_PONG, payload));
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
        this.opts.log?.(`gateway ${conn?.info.id ?? link.remote}: ${(err as Error).message}; closing`);
        link.destroy();
      }
    });
    const ping = setInterval(() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(this.now()));
      if (conn) link.write(frame(T_PING, b));
    }, 10_000);
    link.onClose(() => {
      clearTimeout(helloTimer);
      clearInterval(ping);
      if (conn && this.conns.get(conn.info.id) === conn) {
        this.conns.delete(conn.info.id);
        this.opts.log?.(`gateway ${conn.info.id} disconnected`);
      }
    });
  }
}
