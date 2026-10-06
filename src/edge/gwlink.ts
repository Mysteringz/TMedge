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
import { HelloReplayStore } from './hello-replay.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer, isIP, type Server, type Socket } from 'node:net';
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
/** Firmware images on their way to a gateway, for an over-the-air update. */
export const T_IMAGE_META = 0x50;
export const T_IMAGE_CHUNK = 0x51;
export const T_IMAGE_READY = 0x52;
export const MAX_FRAME = 64 * 1024;
const HELLO_WINDOW_MS = 60_000;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export function frame(type: number, payload: Buffer): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 255 || payload.length + 1 > MAX_FRAME) throw new Error('bad frame');
  const head = Buffer.alloc(5);
  head.writeUInt32LE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

export function addressed(addr: string, port: number, datagram: Buffer): Buffer {
  if (!isIP(addr) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad node address');
  const a = Buffer.from(addr, 'ascii');
  const head = Buffer.alloc(1 + a.length + 2);
  head[0] = a.length;
  a.copy(head, 1);
  head.writeUInt16LE(port, 1 + a.length);
  return Buffer.concat([head, datagram]);
}

export function parseAddressed(p: Buffer): { addr: string; port: number; datagram: Buffer } | null {
  const n = p[0];
  if (n === undefined || p.length < 1 + n + 2) return null;
  const raw = p.subarray(1, 1 + n);
  // ASCII decoding masks high bits; reject them before checking the IP.
  if (raw.some((b) => b > 127)) return null;
  const addr = raw.toString('ascii');
  const port = p.readUInt16LE(1 + n);
  if (!isIP(addr) || port === 0) return null;
  return { addr, port, datagram: p.subarray(3 + n) };
}

export function helloMac(token: Buffer, gatewayId: string, ts: number, nonce: string): string {
  return createHmac('sha256', token).update(`tmgw1|${gatewayId}|${ts}|${nonce}`).digest('hex');
}

/** Incremental frame reader for a TCP stream. */
export class FrameReader {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;

  push(chunk: Buffer, onFrame: (type: number, payload: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const n = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + n);
        this.headerBytes += n;
        offset += n;
        if (this.headerBytes < 4) return;
        const len = this.header.readUInt32LE(0);
        if (len < 1 || len > MAX_FRAME) throw new Error(`bad frame length ${len}`);
        // Allocate once per frame: byte-at-a-time peers must not force
        // quadratic Buffer.concat work or retain an unbounded input chunk.
        this.body = Buffer.allocUnsafe(len);
        this.bodyBytes = 0;
      }
      const n = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + n);
      this.bodyBytes += n;
      offset += n;
      if (this.bodyBytes < this.body.length) return;
      const complete = this.body;
      this.body = null;
      this.headerBytes = 0;
      onFrame(complete[0] ?? 0, complete.subarray(1));
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
  tokens?: (id: string) => Buffer[];
  helloPath?: string;
  allowRawTcp?: boolean;
  edgeId: string;
  allowRemote?: (address: string) => boolean;
  /** A node datagram arrived via a gateway; `source` is "gw:<id>|<ip>:<port>". */
  onUplink: (datagram: Buffer, source: string) => unknown;
  /** A gateway has taken delivery of a firmware image (or refused it). */
  onImageReady?: (gatewayId: string, result: { id: string; ok: boolean; error?: string; port: number }) => void;
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
  token: Buffer;
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
    write: (b) => {
      if (socket.writableLength + b.length > MAX_BUFFERED_BYTES) { socket.destroy(); return; }
      socket.write(b);
    },
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
    write: (b) => {
      if (ws.bufferedAmount + b.length > MAX_BUFFERED_BYTES) { ws.terminate(); return; }
      ws.send(b, { binary: true });
    },
    end: (b) => ws.send(b, { binary: true }, () => ws.close(1008)),
    destroy: () => ws.terminate(),
    onData: (cb) => void ws.on('message', (d: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      if (!binary) { ws.terminate(); return; }
      cb(Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));
    }),
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
  private readonly sockets = new Set<Socket>();
  /** A timestamp alone does not prevent reuse during its acceptance window. */
  private readonly hellos = new Map<string, number>();
  private readonly helloStore: HelloReplayStore | null;
  private readonly now: () => number;
  private started = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly opts: GatewayServerOptions) {
    this.now = opts.now ?? Date.now;
    this.helloStore = opts.helloPath ? new HelloReplayStore(opts.helloPath) : null;
    this.server = createServer((s) => this.accept(s));
    this.http.on('upgrade', (req, socket, head) => {
      let path: string;
      try { path = new URL(req.url ?? '/', 'http://x').pathname; } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      if (path !== '/tmgw') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.session(wsLink(ws, req)));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.started = true;
        this.server.off('error', onError);
        const address = this.server.address();
        resolve(typeof address === 'object' && address ? address.port : this.opts.port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.opts.port, this.opts.host);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Include sniffing, HTTP and unauthenticated sockets, otherwise close()
    // can hang waiting for a peer that has never sent a HELLO.
    for (const socket of this.sockets) socket.destroy();
    for (const c of this.conns.values()) c.link.destroy();
    this.closePromise = new Promise((resolve) => {
      if (!this.started) return resolve();
      this.wss.close(() => this.server.close(() => resolve()));
    });
    return this.closePromise;
  }

  gateways(): GatewayInfo[] {
    return [...this.conns.values()].map((c) => ({ ...c.info }));
  }

  /** Route a command to a node heard through a gateway. False if that gateway is not connected. */
  /**
   * Push a firmware image to one gateway, which holds it and serves it to the
   * nodes on its own network. 32 kB a frame: big enough to move 700 kB in a
   * couple of dozen writes, small enough to stay under MAX_FRAME.
   */
  sendImage(gatewayId: string, meta: { id: string; size: number; sha256: string }, bytes: Buffer): boolean {
    const c = this.conns.get(gatewayId);
    if (!c || !this.credentialValid(c) || !/^[0-9a-f]{64}$/.test(meta.sha256) || meta.id !== meta.sha256.slice(0, 16)
      || !Number.isInteger(meta.size) || meta.size !== bytes.length || meta.size <= 0 || meta.size > 8 * 1024 * 1024) return false;
    c.link.write(frame(T_IMAGE_META, Buffer.from(JSON.stringify(meta))));
    const CHUNK = 32 * 1024;
    const idBytes = Buffer.from(meta.id, 'latin1');
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
      const head = Buffer.alloc(1 + idBytes.length + 4);
      head[0] = idBytes.length;
      idBytes.copy(head, 1);
      head.writeUInt32LE(off, 1 + idBytes.length);
      c.link.write(frame(T_IMAGE_CHUNK, Buffer.concat([head, part])));
    }
    return true;
  }

  /** Which gateway a node is heard through, from its `gw:<id>|addr:port` address. */
  static gatewayOf(source: string): string | null {
    return /^gw:([^|]+)\|/.exec(source)?.[1] ?? null;
  }

  sendDownlink(source: string, datagram: Buffer): boolean {
    const m = /^gw:([^|]+)\|(.+):(\d+)$/.exec(source);
    if (!m) return false;
    const [, id, addr, port] = m;
    const c = this.conns.get(id ?? '');
    if (!c || !this.credentialValid(c) || !addr || !port || !isIP(addr) || Number(port) < 1 || Number(port) > 65535) return false;
    c.link.write(frame(T_DOWNLINK, addressed(addr, Number(port), datagram)));
    c.info.downlink += 1;
    return true;
  }

  private credentialValid(c: Conn): boolean {
    if (!this.opts.tokens || this.opts.tokens(c.info.id).some(t => t.length === c.token.length && timingSafeEqual(t, c.token))) return true;
    c.link.destroy(); return false;
  }

  /** Sniff the first bytes: an HTTP request goes to the WebSocket server, anything else is raw TMGW. */
  private accept(socket: Socket): void {
    const remote = socket.remoteAddress ?? '?';
    if (this.opts.allowRemote && !this.opts.allowRemote(remote)) {
      socket.destroy();
      return;
    }
    if (this.sockets.size >= 512) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const sniff = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(sniff));
    let prefix: Buffer = Buffer.alloc(0);
    const onData = (part: Buffer) => {
      prefix = prefix.length ? Buffer.concat([prefix, part]) : part;
      // TCP may split even the four-byte HTTP method across reads.
      if (prefix.length < 4) return;
      clearTimeout(sniff);
      socket.removeListener('data', onData);
      socket.pause();
      socket.unshift(prefix);
      if (prefix.subarray(0, 4).toString('latin1') === 'GET ') {
        this.http.emit('connection', socket);
      } else {
        const remote = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
        const octets = remote.split('.').map(Number);
        const tailnet = octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
        if (this.opts.allowRawTcp === false || (this.opts.allowRawTcp === true && !LOOPBACK.test(remote) && !tailnet)) { socket.destroy(); return; }
        this.session(tcpLink(socket));
      }
      socket.resume();
    };
    socket.on('data', onData);
  }

  private session(link: Link): void {
    const reader = new FrameReader();
    let conn: Conn | null = null;
    let denied = false;
    // An unauthenticated session gets a few seconds to say HELLO.
    const helloTimer = setTimeout(() => link.destroy(), 5000);
    const deny = (reason: string) => {
      if (denied) return;
      denied = true;
      this.opts.log?.(`gateway from ${link.remote} refused: ${reason}`);
      link.end(frame(T_DENY, Buffer.from(JSON.stringify({ reason }))));
    };

    link.onData((chunk) => {
      try {
        reader.push(chunk, (type, payload) => {
          if (denied) return;
          if (!conn) {
            if (type !== T_HELLO) return deny('HELLO expected');
            if (payload.length > 4096) return deny('bad HELLO');
            let h: { v?: number; gatewayId?: string; ts?: number; nonce?: string; mac?: string };
            try {
              h = JSON.parse(payload.toString('utf8')) as typeof h;
              if (!h || typeof h !== 'object' || Array.isArray(h)) return deny('bad HELLO');
            } catch {
              return deny('bad HELLO');
            }
            const id = h.gatewayId ?? '';
            if (h.v !== TMGW_VERSION || typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)
              || typeof h.ts !== 'number' || !Number.isSafeInteger(h.ts) || typeof h.nonce !== 'string'
              || !/^[A-Za-z0-9._-]{1,128}$/.test(h.nonce) || typeof h.mac !== 'string' || !/^[0-9a-f]{64}$/.test(h.mac)) {
              return deny('bad HELLO');
            }
            if (Math.abs(this.now() - h.ts) > HELLO_WINDOW_MS) return deny('clock skew or replayed HELLO');
            const got = Buffer.from(String(h.mac ?? ''));
            const candidates = this.opts.tokens ? this.opts.tokens(id) : [this.opts.token];
            const authenticated = candidates.find(token => timingSafeEqual(Buffer.from(helloMac(token, id, h.ts!, h.nonce!)), got));
            if (!authenticated) return deny('bad token');
            const now = this.now();
            for (const [key, expires] of this.hellos) if (expires < now) this.hellos.delete(key);
            const key = `${id}|${h.nonce}`;
            if (this.hellos.has(key)) return deny('replayed HELLO');
            if (this.hellos.size >= 4096) return deny('HELLO capacity exceeded');
            try { if (this.helloStore && !this.helloStore.accept(id, h.nonce, h.ts + HELLO_WINDOW_MS, now)) return deny('replayed HELLO or clock rollback'); }
            catch { return deny('HELLO journal unavailable'); }
            this.hellos.set(key, h.ts + HELLO_WINDOW_MS);
            clearTimeout(helloTimer);
            // A gateway that reconnects (or fails over to its other route) replaces its old session.
            this.conns.get(id)?.link.destroy();
            conn = { token: authenticated, link, info: { id, remote: link.remote, transport: link.transport, connectedAt: this.now(), lastSeen: this.now(), uplink: 0, downlink: 0, rttMs: null, stats: null } };
            this.conns.set(id, conn);
            link.write(frame(T_WELCOME, Buffer.from(JSON.stringify({ v: TMGW_VERSION, edgeId: this.opts.edgeId }))));
            this.opts.log?.(`gateway ${id} connected over ${link.transport} from ${link.remote}`);
            return undefined;
          }
          if (this.opts.tokens && !this.opts.tokens(conn.info.id).some(t => t.length === conn!.token.length && timingSafeEqual(t, conn!.token))) return deny('gateway credential expired or revoked');
          conn.info.lastSeen = this.now();
          switch (type) {
            case T_UPLINK: {
              const u = parseAddressed(payload);
              if (!u) return undefined;
              conn.info.uplink += 1;
              Promise.resolve(this.opts.onUplink(Buffer.from(u.datagram), `gw:${conn.info.id}|${u.addr}:${u.port}`))
                .catch((error) => this.opts.log?.(`gateway ${conn?.info.id}: uplink admission failed: ${String(error)}`));
              return undefined;
            }
            case T_PING:
              link.write(frame(T_PONG, payload));
              return undefined;
            case T_PONG:
              if (payload.length === 8) {
                const rtt = this.now() - Number(payload.readBigUInt64LE(0));
                if (rtt >= 0 && rtt <= 60_000) conn.info.rttMs = rtt;
              }
              return undefined;
            case T_IMAGE_READY:
              try {
                const r = JSON.parse(payload.toString('utf8')) as { id: string; ok: boolean; error?: string; port: number };
                if (!r || typeof r !== 'object' || !/^[0-9a-f]{16}$/.test(r.id) || typeof r.ok !== 'boolean'
                  || !Number.isInteger(r.port) || r.port < 0 || r.port > 65535 || (r.ok && r.port === 0)
                  || (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 1024))) return undefined;
                this.opts.onImageReady?.(conn.info.id, r);
              } catch {
                /* a gateway that cannot answer properly is handled by the rollout's timeout */
              }
              return undefined;
            case T_STATS:
              try {
                const stats: unknown = JSON.parse(payload.toString('utf8'));
                if (stats && typeof stats === 'object' && !Array.isArray(stats)) conn.info.stats = stats as Record<string, unknown>;
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
      if (conn && this.opts.tokens && !this.opts.tokens(conn.info.id).some(t => t.length === conn!.token.length && timingSafeEqual(t, conn!.token))) { link.destroy(); return; }
      if (conn && this.now() - conn.info.lastSeen > 45_000) { link.destroy(); return; }
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
