/**
 * Direct node listener, protocol "tmnode.v1" -- see docs/DIRECT_NODE_PROTOCOL.md,
 * which is the contract; TMsense/src/tm_cloud_session.cpp is the other end.
 *
 * A TMsense node with `transport wss` holds one outbound WebSocket to this
 * listener (through the Cloudflare Tunnel, so the node needs nothing but
 * outbound 443 and the edge opens no public port). It is NOT a gateway: it
 * speaks only for itself, authenticates with the site key it already signs
 * with, and carries its own packets byte for byte, one per binary message.
 *
 * Everything the node sends goes through Ingest.handle -- the same signature
 * check, replay rule and occupancy path as UDP and TMGW. This file adds only
 * what a long-lived internet session needs: challenge authentication, one
 * route per node that a late close cannot remove, acknowledgements of
 * *accepted* packets, refusal of delayed backlogs, bounded everything, and
 * the HTTPS download an OTA needs when there is no gateway to fetch from.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { NodeListenerLimits } from './config.js';
import type { DirectSession, IngestResult, Route } from './ingest.js';
import { HEADER_SIZE, TAG_SIZE, GRID_SIZE, type Packet } from './protocol.js';

export const SUBPROTOCOL = 'tmnode.v1';
export const DIRECT_VERSION = 1;
export const PATH = '/tmnode';
/** Largest control message either way. */
export const CONTROL_MAX = 512;
/** Largest packet: a RAW (TM_PACKET_MAX_SIZE in the firmware). */
export const BINARY_MAX = HEADER_SIZE + 8 + GRID_SIZE + TAG_SIZE;
export const HANDSHAKE_MS = 10_000;
export const HEARTBEAT_MS = 15_000;
export const DEAD_MS = 45_000;
/** A packet more than this far behind its boot's fastest delivery is a backlog, not an observation. */
export const LAG_BUDGET_MS = 2_000;
/** How fast a node's clock may drift against ours before its packets look delayed: 200 ppm. */
export const DRIFT_ALLOWANCE = 200e-6;
/** Downlink bytes that may wait on one socket before the session is failed. */
export const MAX_BUFFERED = 64 * 1024;
const MAX_DOWNLOADS = 4;

/** Close codes (4000-4999 are the application's). */
export const CLOSE = {
  badMessage: 4400,
  authFailed: 4401,
  handshakeTimeout: 4408,
  replaced: 4409,
  rateLimited: 4429,
  slowReader: 4508,
  dead: 4504,
  shutdown: 1001,
} as const;

/** HMAC-SHA256(key, "tmnode1|<uid>|<nonce>"), lowercase hex. The firmware computes the same in tm_cloud_auth_mac. */
export function authMac(key: Buffer, uid: string, nonce: string): string {
  return createHmac('sha256', key).update(`tmnode1|${uid}|${nonce}`, 'utf8').digest('hex');
}

const UID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export interface NodeServerOptions {
  host: string;
  port: number;
  limits: NodeListenerLimits;
  /** Accepted site keys, current first. */
  keys: Buffer[];
  isRegistered(uid: string): boolean;
  /** Ingest.handle: the one verification path. */
  ingest(datagram: Buffer, route: Route): IngestResult;
  /** Ingest.dropDirectRoute. */
  dropRoute(uid: string, sessionId: string): void;
  /** The approved image's bytes, by build id. */
  image(buildId: string): Buffer | null;
  /** Whether an active rollout still wants this node to fetch this build. */
  otaApproved(uid: string, buildId: string): boolean;
  /** Test only: terminate TLS here. Production is plain HTTP on loopback behind the tunnel. */
  tls?: { cert: Buffer; key: Buffer };
  /** Wall clock (for people) and a monotonic clock (for lag and timeouts). */
  now?: () => number;
  mono?: () => number;
  timings?: Partial<{ handshakeMs: number; heartbeatMs: number; deadMs: number }>;
  log?: (msg: string) => void;
}

interface Session {
  ws: WebSocket;
  source: string;
  openedAt: number;
  nonce: string;
  state: 'challenged' | 'authenticated' | 'closed';
  uid: string | null;
  sessionId: string;
  keyIndex: number;
  /** Set on the first accepted packet: only then is this the node's route. */
  active: boolean;
  lastHeard: number;
  lastAcceptedAt: number | null;
  lastReportAt: number | null;
  accepted: number;
  acks: number;
  rejected: number;
  lastRejection: string | null;
  tokens: { msgs: number; bytes: number; at: number };
  drops: number[];
  timer: NodeJS.Timeout | null;
  route: DirectSession | null;
  closeReason: string | null;
}

interface Grant {
  uid: string;
  build: string;
  seq: number;
  expires: number;
}

/** Per boot of a node: what lets a delayed backlog be told from a fresh packet. */
interface Baseline {
  boot: number;
  wraps: number;
  lastUptime: number;
  /** Smallest (receive time - node uptime) seen, drift allowance applied. */
  offset: number;
  at: number;
}

export interface DirectNodeInfo {
  uid: string;
  sessionId: string;
  source: string;
  connectedAt: number;
  active: boolean;
  lastAcceptedAt: number | null;
  lastReportAt: number | null;
  acks: number;
  rejected: number;
  lastRejection: string | null;
  /** Which configured key it authenticated with: 0 = TM_KEY, 1 = TM_KEY_PREVIOUS. */
  keyIndex: number;
}

export interface DirectNodeHistory {
  connects: number;
  lastDisconnectAt: number | null;
  lastDisconnectReason: string | null;
}

export class NodeServer {
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly pending = new Set<Session>();
  private readonly authed = new Set<Session>();
  /** The session each node's downlinks go to: its newest one with an accepted packet. */
  private readonly active = new Map<string, Session>();
  private readonly grants = new Map<string, Grant>();   // by sha256(token)
  private readonly baselines = new Map<string, Baseline>();
  private readonly upgrades = new Map<string, number[]>();
  private readonly history = new Map<string, DirectNodeHistory>();
  readonly rejects = new Map<string, number>();
  private downloads = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly handshakeMs: number;
  private readonly heartbeatMs: number;
  private readonly deadMs: number;

  constructor(private readonly opts: NodeServerOptions) {
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (() => performance.now());
    this.handshakeMs = opts.timings?.handshakeMs ?? HANDSHAKE_MS;
    this.heartbeatMs = opts.timings?.heartbeatMs ?? HEARTBEAT_MS;
    this.deadMs = opts.timings?.deadMs ?? DEAD_MS;
    const handler = (req: IncomingMessage, res: ServerResponse) => this.http(req, res);
    this.server = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : createHttpServer(handler);
    // Compression off: packets are signed binary that does not compress, and
    // a decompressor is attack surface a sensor endpoint does not need.
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: BINARY_MAX,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('clientError', (_err, socket) => socket.destroy());
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => reject(err);
      this.server.once('error', fail);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.off('error', fail);
        this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
        this.heartbeat.unref();
        const a = this.server.address();
        resolve(typeof a === 'object' && a ? a.port : this.opts.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of [...this.pending, ...this.authed]) s.ws.close(CLOSE.shutdown, 'edge shutting down');
    this.wss.close();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  sessions(): DirectNodeInfo[] {
    return [...this.authed].filter((s) => s.uid).map((s) => ({
      uid: s.uid ?? '',
      sessionId: s.sessionId,
      source: s.source,
      connectedAt: s.openedAt,
      active: s.active,
      lastAcceptedAt: s.lastAcceptedAt,
      lastReportAt: s.lastReportAt,
      acks: s.acks,
      rejected: s.rejected,
      lastRejection: s.lastRejection,
      keyIndex: s.keyIndex,
    }));
  }

  /** The node's current direct session, and what happened to its earlier ones. */
  nodeInfo(uid: string): { session: DirectNodeInfo | null; history: DirectNodeHistory | null } {
    const s = this.active.get(uid);
    return {
      session: s ? this.sessions().find((x) => x.sessionId === s.sessionId) ?? null : null,
      history: this.history.get(uid) ?? null,
    };
  }

  stats(): { sessions: number; pending: number; grants: number; rejects: Record<string, number> } {
    return { sessions: this.authed.size, pending: this.pending.size, grants: this.grants.size, rejects: Object.fromEntries(this.rejects) };
  }

  // --- HTTP: health and firmware downloads ----------------------------------

  private http(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://node');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    const fw = /^\/fw\/([0-9a-f]{16})\.bin$/.exec(url.pathname);
    if (fw && !url.search) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      this.download(fw[1] ?? '', req, res);
      return;
    }
    // Nothing else lives here: no console, no RAW, no listing.
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  }

  private download(build: string, req: IncomingMessage, res: ServerResponse): void {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
    const grant = m ? this.grants.get(tokenId(m[1] ?? '')) : undefined;
    if (!grant || grant.expires <= this.mono() || grant.build !== build) {
      this.count('download: no valid grant');
      res.writeHead(401).end();
      return;
    }
    if (!this.opts.otaApproved(grant.uid, build)) {
      this.count('download: rollout no longer wants it');
      res.writeHead(403).end();
      return;
    }
    const bytes = this.opts.image(build);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    if (this.downloads >= MAX_DOWNLOADS) {
      res.writeHead(503, { 'retry-after': '10' }).end();
      return;
    }
    this.downloads += 1;
    res.on('close', () => (this.downloads -= 1));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'no-store, private',
    });
    res.end(bytes);
    this.opts.log?.(`direct: ${grant.uid} downloading ${build} (${bytes.length} bytes)`);
  }

  // --- WebSocket ------------------------------------------------------------

  /** Through the tunnel the socket peer is cloudflared on loopback; the node's own address is CF-Connecting-IP, trusted only then. */
  private sourceOf(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? '?';
    const cf = req.headers['cf-connecting-ip'];
    return LOOPBACK.test(peer) && typeof cf === 'string' && cf.length < 64 ? cf : peer;
  }

  private refuse(socket: Duplex, status: string, reason: string): void {
    this.count(`upgrade: ${reason}`);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://node');
    if (url.pathname !== PATH || url.search) return this.refuse(socket, '404 Not Found', 'wrong path');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!offered.includes(SUBPROTOCOL)) return this.refuse(socket, '400 Bad Request', 'unsupported subprotocol');
    const source = this.sourceOf(req);
    const t = this.mono();
    const recent = (this.upgrades.get(source) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    this.upgrades.set(source, recent);
    if (this.upgrades.size > 10_000) this.upgrades.clear();
    const lim = this.opts.limits;
    if (recent.length > lim.upgradesPerMinute) return this.refuse(socket, '429 Too Many Requests', 'too many upgrades from one source');
    if (this.pending.size >= lim.maxPending) return this.refuse(socket, '503 Service Unavailable', 'too many handshakes');
    if ([...this.pending].filter((s) => s.source === source).length >= lim.maxPendingPerSource) {
      return this.refuse(socket, '429 Too Many Requests', 'too many handshakes from one source');
    }
    if (this.authed.size >= lim.maxSessions) return this.refuse(socket, '503 Service Unavailable', 'session table full');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.open(ws, source));
  }

  private open(ws: WebSocket, source: string): void {
    const t = this.mono();
    const s: Session = {
      ws, source, openedAt: this.now(), nonce: randomBytes(32).toString('hex'), state: 'challenged',
      uid: null, sessionId: randomBytes(12).toString('base64url'), keyIndex: -1, active: false,
      lastHeard: t, lastAcceptedAt: null, lastReportAt: null, accepted: 0, acks: 0, rejected: 0, lastRejection: null,
      tokens: { msgs: 0, bytes: 0, at: t }, drops: [], timer: null, route: null, closeReason: null,
    };
    s.tokens = { msgs: this.opts.limits.messagesPerSec * 2, bytes: this.opts.limits.bytesPerSec * 2, at: t };
    this.pending.add(s);
    ws.on('error', () => undefined);
    ws.on('pong', () => (s.lastHeard = this.mono()));
    ws.on('message', (data: RawData, isBinary: boolean) => this.message(s, toBuffer(data), isBinary));
    ws.on('close', (code: number) => this.closed(s, code));
    // Bounded: the nonce dies with this timer, and nothing but `auth` is heard until then.
    s.timer = setTimeout(() => this.fail(s, CLOSE.handshakeTimeout, 'handshake timeout'), this.handshakeMs);
    this.control(s, { type: 'challenge', v: DIRECT_VERSION, nonce: s.nonce });
  }

  private message(s: Session, data: Buffer, isBinary: boolean): void {
    if (s.state === 'closed') return;
    s.lastHeard = this.mono();
    if (s.state === 'challenged') {
      if (isBinary || data.length > CONTROL_MAX) return this.fail(s, CLOSE.badMessage, 'auth expected');
      return this.authenticate(s, data);
    }
    if (!isBinary) return this.fail(s, CLOSE.badMessage, 'unexpected control message');
    if (!this.withinRate(s, data.length)) return;
    this.packet(s, data);
  }

  private authenticate(s: Session, data: Buffer): void {
    let m: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      m = parsed as Record<string, unknown>;
    } catch {
      return this.fail(s, CLOSE.badMessage, 'auth is not JSON');
    }
    const { type, v, uid, nonce, mac } = m;
    if (type !== 'auth' || v !== DIRECT_VERSION || typeof uid !== 'string' || !UID_RE.test(uid) ||
      typeof nonce !== 'string' || !HEX64_RE.test(nonce) || typeof mac !== 'string' || !HEX64_RE.test(mac) ||
      Object.keys(m).length !== 5) {
      return this.fail(s, CLOSE.badMessage, 'malformed auth');
    }
    // One nonce, one answer: whatever happens next, this one is spent.
    const expected = s.nonce;
    s.nonce = '';
    const nonceOk = timingSafeEqual(Buffer.from(nonce), Buffer.from(expected));
    const got = Buffer.from(mac, 'hex');
    let keyIndex = -1;
    this.opts.keys.forEach((k, i) => {
      if (keyIndex < 0 && timingSafeEqual(got, Buffer.from(authMac(k, uid, expected), 'hex'))) keyIndex = i;
    });
    // One refusal for every reason: which part was wrong is no business of
    // someone probing the endpoint. The log says which, for the admin.
    const why = !nonceOk ? 'wrong nonce' : keyIndex < 0 ? 'bad mac' : !this.opts.isRegistered(uid) ? 'unregistered node' : null;
    if (why) {
      this.opts.log?.(`direct: auth refused from ${s.source} for ${uid}: ${why}`);
      return this.fail(s, CLOSE.authFailed, `auth: ${why}`, 'authentication failed');
    }
    const key = this.opts.keys[keyIndex];
    if (!key) return this.fail(s, CLOSE.authFailed, 'auth: no key');
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.uid = uid;
    s.keyIndex = keyIndex;
    s.state = 'authenticated';
    this.pending.delete(s);
    this.authed.add(s);
    s.route = this.routeFor(s, key);
    const h = this.history.get(uid) ?? { connects: 0, lastDisconnectAt: null, lastDisconnectReason: null };
    h.connects += 1;
    this.history.set(uid, h);
    this.control(s, { type: 'ready', v: DIRECT_VERSION, uid, session: s.sessionId, heartbeatMs: this.heartbeatMs });
    this.opts.log?.(`direct: ${uid} authenticated from ${s.source} (session ${s.sessionId}${keyIndex > 0 ? ', previous key' : ''})`);
  }

  private routeFor(s: Session, key: Buffer): DirectSession {
    const uid = s.uid ?? '';
    return {
      uid,
      sessionId: s.sessionId,
      key,
      send: (datagram) => this.downlink(s, datagram),
      grantOta: (seq, build) => this.grant(s, seq, build),
      admit: (packet) => this.admit(s, packet),
    };
  }

  private packet(s: Session, data: Buffer): void {
    const route = s.route;
    if (!route) return;
    const result = this.opts.ingest(data, { kind: 'direct', address: `ws:${route.uid}:${s.sessionId}`, session: route });
    if (!result.ok) {
      s.rejected += 1;
      s.lastRejection = result.reason;
      return;
    }
    s.accepted += 1;
    s.lastAcceptedAt = this.now();
    if (!s.active) this.activate(s);
    const p = result.packet;
    if (p.kind === 'report') s.lastReportAt = s.lastAcceptedAt;
    if (p.kind === 'report' || p.kind === 'status') {
      // After acceptance, never before: an ACK is the node's only evidence
      // that the edge took its report -- which is what OTA probation and the
      // node's stall detector rely on.
      if (this.control(s, { type: 'ack', v: DIRECT_VERSION, session: s.sessionId, boot: p.boot, seq: p.seq })) s.acks += 1;
    }
  }

  /** The first accepted packet makes this session the node's route; an older one is closed. */
  private activate(s: Session): void {
    const uid = s.uid ?? '';
    const old = this.active.get(uid);
    s.active = true;
    this.active.set(uid, s);
    if (old && old !== s) this.fail(old, CLOSE.replaced, 'replaced by a newer session');
  }

  /**
   * Refuse a packet that arrives much later than this boot's packets usually
   * do. Uptime is the node's clock since boot, not wall time, so this
   * measures delay *added* after the fastest delivery seen -- enough to stop
   * a stalled socket's backlog being taken as a current count.
   */
  private admit(s: Session, packet: Packet): string | null {
    if (s.state !== 'authenticated') return 'session closed';
    const t = this.mono();
    const b = this.baselines.get(packet.uid);
    if (!b || b.boot !== packet.boot) {
      this.baselines.set(packet.uid, { boot: packet.boot, wraps: 0, lastUptime: packet.uptimeMs, offset: t - packet.uptimeMs, at: t });
      return null;
    }
    // 32-bit ms uptime wraps after 49.7 days; a big step backwards is a wrap.
    let wraps = b.wraps;
    if (packet.uptimeMs < b.lastUptime && b.lastUptime - packet.uptimeMs > 0x80000000) wraps += 1;
    const up = wraps * 0x100000000 + packet.uptimeMs;
    const offset = t - up;
    const lag = offset - b.offset;
    if (lag > LAG_BUDGET_MS) return `delayed ${Math.round(lag)} ms beyond this boot's fastest delivery`;
    b.wraps = wraps;
    b.lastUptime = packet.uptimeMs;
    // Follow a faster path at once; follow a slow node clock only at the
    // drift allowance, so a backlog cannot drag the baseline along with it.
    b.offset = lag < 0 ? offset : b.offset + Math.min(lag, (t - b.at) * DRIFT_ALLOWANCE);
    b.at = t;
    return null;
  }

  private downlink(s: Session, datagram: Buffer): boolean {
    if (s.state !== 'authenticated' || s.ws.readyState !== s.ws.OPEN) return false;
    if (s.ws.bufferedAmount + datagram.length > MAX_BUFFERED) {
      this.fail(s, CLOSE.slowReader, 'slow reader');
      return false;
    }
    s.ws.send(datagram, { binary: true });
    return true;
  }

  private grant(s: Session, seq: number, build: string): boolean {
    const uid = s.uid;
    if (!uid || !this.opts.otaApproved(uid, build)) return false;
    for (const [id, g] of this.grants) if (g.uid === uid) this.grants.delete(id);
    const token = randomBytes(32).toString('hex');
    // Kept past a disconnect: the node may close this socket to have the heap
    // for the HTTPS download.
    this.grants.set(tokenId(token), { uid, build, seq, expires: this.mono() + this.opts.limits.grantMs });
    return this.control(s, { type: 'ota_grant', v: DIRECT_VERSION, seq, build, token, expiresInMs: this.opts.limits.grantMs });
  }

  /** Revoke a node's grant: its rollout step finished, failed or was cancelled. */
  revokeGrants(uid: string): void {
    for (const [id, g] of this.grants) if (g.uid === uid) this.grants.delete(id);
  }

  private control(s: Session, msg: Record<string, unknown>): boolean {
    const text = JSON.stringify(msg);
    if (text.length > CONTROL_MAX || s.ws.readyState !== s.ws.OPEN) return false;
    if (s.ws.bufferedAmount + text.length > MAX_BUFFERED) {
      this.fail(s, CLOSE.slowReader, 'slow reader');
      return false;
    }
    s.ws.send(text);
    return true;
  }

  /** Token buckets, two seconds deep. Over the limit, a message is dropped; a flood closes the session. */
  private withinRate(s: Session, bytes: number): boolean {
    const lim = this.opts.limits;
    const t = this.mono();
    const dt = Math.max(0, t - s.tokens.at) / 1000;
    s.tokens.msgs = Math.min(lim.messagesPerSec * 2, s.tokens.msgs + dt * lim.messagesPerSec);
    s.tokens.bytes = Math.min(lim.bytesPerSec * 2, s.tokens.bytes + dt * lim.bytesPerSec);
    s.tokens.at = t;
    if (s.tokens.msgs >= 1 && s.tokens.bytes >= bytes) {
      s.tokens.msgs -= 1;
      s.tokens.bytes -= bytes;
      return true;
    }
    s.rejected += 1;
    s.lastRejection = 'rate limited';
    this.count('rate limited');
    s.drops = s.drops.filter((x) => t - x < 10_000);
    s.drops.push(t);
    if (s.drops.length > 100) this.fail(s, CLOSE.rateLimited, 'sustained rate limit');
    return false;
  }

  private beat(): void {
    const t = this.mono();
    for (const [id, g] of this.grants) if (g.expires <= t) this.grants.delete(id);
    for (const s of this.authed) {
      if (t - s.lastHeard > this.deadMs) {
        this.fail(s, CLOSE.dead, 'no response');
        s.ws.terminate();
        continue;
      }
      if (s.ws.readyState === s.ws.OPEN) s.ws.ping();
    }
  }

  private fail(s: Session, code: number, reason: string, told = reason): void {
    this.count(reason);
    s.closeReason ??= reason;
    if (s.ws.readyState === s.ws.OPEN || s.ws.readyState === s.ws.CONNECTING) s.ws.close(code, told.slice(0, 120));
    this.closed(s, code);
  }

  private closed(s: Session, code: number): void {
    if (s.state === 'closed') return;
    s.state = 'closed';
    if (s.timer) clearTimeout(s.timer);
    this.pending.delete(s);
    this.authed.delete(s);
    const uid = s.uid;
    if (!uid) return;
    const h = this.history.get(uid);
    if (h) {
      h.lastDisconnectAt = this.now();
      h.lastDisconnectReason = s.closeReason ?? `node closed (${code})`;
    }
    // Only if it is still the node's session: a replacement must survive the
    // late close of the connection it replaced.
    if (this.active.get(uid) === s) {
      this.active.delete(uid);
      this.opts.dropRoute(uid, s.sessionId);
    }
  }

  private count(reason: string): void {
    this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1);
  }
}

function toBuffer(d: RawData): Buffer {
  return Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d);
}

/** Grants are stored by the token's hash, so a heap dump holds no usable token. */
function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
