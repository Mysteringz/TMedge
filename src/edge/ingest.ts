/**
 * UDP ingest: authenticate each datagram, reject replays, keep per-node
 * delivery statistics, and send signed commands back.
 *
 * Replay rule: (boot, seq) must strictly increase per node. The node keeps its
 * boot counter in flash, so a reboot raises `boot` and restarts `seq` -- a
 * legitimate reboot is always "newer", and there is no exception to get wrong.
 * (The old gateway's reboot exception lived in two places and locked out every
 * power-cycled node when one of them was missed.)
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import {
  buildCommand,
  buildOta,
  parsePacket,
  ProtocolError,
  type Command,
  type Raw,
  type Report,
  type OtaStatus,
  type Packet,
  type Status,
  type VerifyOptions,
} from './protocol.js';

export const DOWNLINK_PORT = 5201;
const WINDOW_MS = 60_000;
const MAX_NODES = 5000;
const MAX_UNKNOWN_SOURCES = 200;

/**
 * How a node's downlink gets back to it. Chosen from the transport its last
 * *accepted* packet arrived on -- never from the shape of an address string,
 * so a diagnostic address like "ws:<uid>:<session>" cannot fall through to
 * UDP and DNS.
 */
export type Route =
  | { kind: 'udp'; address: string }
  | { kind: 'gateway'; address: string }
  | { kind: 'direct'; address: string; session: DirectSession };

export type Transport = Route['kind'];

/** A node's own authenticated WebSocket session (nodelink.ts). */
export interface DirectSession {
  uid: string;
  sessionId: string;
  /** The key this session authenticated with: its packets verify, and its downlinks are signed, with this one. */
  key: Buffer;
  /** Queue one downlink datagram on the socket; false if the session cannot take it. */
  send(datagram: Buffer): boolean;
  /** Issue the HTTPS download grant that must precede a signed OTA request. */
  grantOta(seq: number, buildId: string): boolean;
  /**
   * Last admission check, after the signature and replay checks and before
   * any state changes: a delayed backlog is refused here. Returns a reason to
   * reject, or null.
   */
  admit(packet: Packet, at: number): string | null;
}

export type IngestResult =
  | { ok: true; packet: Packet; route: Route }
  | { ok: false; uid: string | null; reason: string };

export interface NodeLink {
  uid: string;
  /** Where it last spoke from, for people. Downlinks use `route`. */
  address: string;
  /** Null when the node's direct session has closed: nothing to send down. */
  route: Route | null;
  firstSeen: number;
  lastSeen: number;
  boot: number;
  seq: number;
  signed: boolean;
  reports: number;
  raws: number;
  statuses: number;
  rejected: number;
  /** Arrival times of every accepted packet in the stats window. */
  recvTimes: number[];
  reportTimes: number[];
  gapEvents: { t: number; n: number }[];
}

export interface RejectedSource {
  address: string;
  uid: string | null;
  count: number;
  lastSeen: number;
  reason: string;
}

export interface IngestOptions {
  port: number;
  host: string;
  verify: VerifyOptions;
  /** Key used to sign commands. Commands are refused if absent. */
  commandKey: Buffer | null;
  now?: () => number;
  /**
   * Delivers a command to a node heard through an access gateway (address
   * "gw:..."). Returns false if that gateway is not connected.
   */
  routeViaGateway?: (address: string, datagram: Buffer) => boolean;
}

export declare interface Ingest {
  on(event: 'report', l: (p: Report, address: string, at: number) => void): this;
  on(event: 'raw', l: (p: Raw, address: string, at: number) => void): this;
  on(event: 'status', l: (p: Status, address: string, at: number) => void): this;
  on(event: 'ota', l: (p: OtaStatus, address: string, at: number) => void): this;
  on(event: 'rejected', l: (address: string, reason: string) => void): this;
  on(event: 'listening', l: (addr: { address: string; port: number }) => void): this;
  on(event: 'error', l: (err: Error) => void): this;
}

export class Ingest extends EventEmitter {
  readonly links = new Map<string, NodeLink>();
  readonly rejectedSources = new Map<string, RejectedSource>();
  readonly rejectReasons = new Map<string, number>();
  private readonly socket: dgram.Socket;
  private readonly now: () => number;
  private packetTimes: number[] = [];
  private bytesInWindow: { t: number; n: number }[] = [];
  private rejectTimes: number[] = [];
  private lastCommandSeq = 0;

  constructor(private readonly opts: IngestOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this.handle(msg, rinfo.address));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('listening', () => {
      const a = this.socket.address();
      this.emit('listening', { address: a.address, port: a.port });
    });
  }

  start(): void {
    this.socket.bind(this.opts.port, this.opts.host);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }

  /**
   * Process one datagram, from any transport. Every transport comes through
   * here, so none of them can skip the signature, the replay rule or the
   * occupancy path; the result says whether it was accepted, which is the
   * only thing a transport may acknowledge.
   *
   * `source` is a plain address for UDP ("gw:..." for a gateway), or a Route.
   */
  handle(msg: Buffer, source: string | Route): IngestResult {
    const route: Route = typeof source === 'string'
      ? (source.startsWith('gw:') ? { kind: 'gateway', address: source } : { kind: 'udp', address: source })
      : source;
    const address = route.address;
    const now = this.now();
    this.packetTimes.push(now);
    this.bytesInWindow.push({ t: now, n: msg.length });

    const uidOf = () => msg.length >= 10 && msg[0] === 0x54 && msg[1] === 0x4d
      ? [...msg.subarray(4, 10)].map((b) => b.toString(16).padStart(2, '0')).join(':')
      : null;
    let packet: Packet;
    try {
      // A direct session is bound to one key and one node: its packets must
      // verify with that key, whatever else the edge would accept, and
      // ALLOW_UNSIGNED never applies to it.
      packet = parsePacket(msg, route.kind === 'direct'
        ? { keys: [route.session.key], allowUnsigned: false }
        : this.opts.verify);
    } catch (err) {
      return this.reject(address, uidOf(), err instanceof ProtocolError ? err.message : String(err));
    }
    if (route.kind === 'direct' && packet.uid !== route.session.uid) {
      return this.reject(address, packet.uid, 'uid does not match the session');
    }

    let link = this.links.get(packet.uid);
    if (link) {
      if (packet.boot < link.boot || (packet.boot === link.boot && packet.seq <= link.seq)) {
        link.rejected += 1;
        return this.reject(address, packet.uid, packet.boot < link.boot
          ? 'boot counter went backwards (replay, or node flash erased)'
          : 'replayed or duplicate sequence');
      }
    } else if (this.links.size >= MAX_NODES) {
      return this.reject(address, packet.uid, 'node table full');
    }
    if (route.kind === 'direct') {
      const refused = route.session.admit(packet, now);
      if (refused) {
        if (link) link.rejected += 1;
        return this.reject(address, packet.uid, refused);
      }
    }
    if (link) {
      if (packet.boot === link.boot && packet.seq > link.seq + 1) {
        link.gapEvents.push({ t: now, n: packet.seq - link.seq - 1 });
      }
    } else {
      link = {
        uid: packet.uid,
        address,
        route,
        firstSeen: now,
        lastSeen: now,
        boot: packet.boot,
        seq: packet.seq,
        signed: packet.signed,
        reports: 0,
        raws: 0,
        statuses: 0,
        rejected: 0,
        recvTimes: [],
        reportTimes: [],
        gapEvents: [],
      };
      this.links.set(packet.uid, link);
    }
    // Follow the node: DHCP may move it, it may switch transport, and a
    // reconnect replaces its session. Commands go wherever it last spoke from
    // -- and only an accepted packet gets to say where that is.
    link.address = address;
    link.route = route;
    link.lastSeen = now;
    link.boot = packet.boot;
    link.seq = packet.seq;
    link.signed = packet.signed;
    link.recvTimes.push(now);

    switch (packet.kind) {
      case 'report':
        link.reports += 1;
        link.reportTimes.push(now);
        this.emit('report', packet, address, now);
        break;
      case 'ota':
        this.emit('ota', packet, address, now);
        break;
      case 'raw':
        link.raws += 1;
        this.emit('raw', packet, address, now);
        break;
      case 'status':
        link.statuses += 1;
        this.emit('status', packet, address, now);
        break;
    }
    this.trim(now, link);
    return { ok: true, packet, route };
  }

  /**
   * A direct session closed. Forget it as the node's route -- but only if it
   * still is: a late close from a session that a reconnect has already
   * replaced must not remove the replacement.
   */
  dropDirectRoute(uid: string, sessionId: string): boolean {
    const link = this.links.get(uid);
    if (link?.route?.kind !== 'direct' || link.route.session.sessionId !== sessionId) return false;
    link.route = null;
    return true;
  }

  /** The replay counter shared by commands and OTA requests. */
  allocateCommandSeq(): number {
    // Unix seconds, but strictly increasing even for two commands in the same
    // second: the node ignores anything not newer than the last one it applied.
    const seq = Math.max(Math.floor(this.now() / 1000), this.lastCommandSeq + 1);
    this.lastCommandSeq = seq;
    return seq;
  }

  /** Forget a node's replay cursor: for a node whose flash was erased on purpose. */
  resetCursor(uid: string): boolean {
    return this.links.delete(uid);
  }

  /** Reports per second over the window. */
  frameRate(uid: string): number {
    const link = this.links.get(uid);
    if (link) this.trim(this.now(), link);
    if (!link || link.reportTimes.length < 2) return 0;
    const t = link.reportTimes;
    const span = (t[t.length - 1] ?? 0) - (t[0] ?? 0);
    return span > 0 ? (t.length - 1) / (span / 1000) : 0;
  }

  /** Fraction of packets lost in the window, from sequence gaps. */
  lossRate(uid: string): number {
    const link = this.links.get(uid);
    if (link) this.trim(this.now(), link);
    if (!link) return 0;
    const lost = link.gapEvents.reduce((a, g) => a + g.n, 0);
    const total = lost + link.recvTimes.length;
    return total > 0 ? lost / total : 0;
  }

  rates(): { packetsPerSec: number; bytesPerSec: number; rejectedPerMin: number } {
    this.trim(this.now());
    return {
      packetsPerSec: this.packetTimes.length / (WINDOW_MS / 1000),
      bytesPerSec: this.bytesInWindow.reduce((a, b) => a + b.n, 0) / (WINDOW_MS / 1000),
      rejectedPerMin: this.rejectTimes.length / (WINDOW_MS / 60_000),
    };
  }

  /**
   * Send a signed command and resolve with the sequence number it carried.
   * The caller needs that number to recognise the acknowledgement: a node
   * echoes the last command it applied in its STATUS, and "sent" and
   * "applied" are different claims.
   */
  sendCommand(uid: string, opcode: number, arg0 = 0, value = 0): Promise<number> {
    const target = this.downlinkTarget(uid, 'receive commands');
    if (target instanceof Error) return Promise.reject(target);
    const seq = this.allocateCommandSeq();
    const cmd: Command = { seq, opcode, arg0, value };
    return this.deliver(uid, target.route, buildCommand(uid, cmd, target.key)).then(() => seq);
  }

  /**
   * Which route and key a downlink to `uid` uses, or why there is none. A
   * direct session signs with the key it authenticated with, so a node still
   * on TM_KEY_PREVIOUS during a rotation gets commands it can verify.
   */
  private downlinkTarget(uid: string, what: string): { route: Route; key: Buffer } | Error {
    const link = this.links.get(uid);
    if (!link) return new Error(`node ${uid} has not been heard from; no address to send to`);
    const route = link.route;
    if (!route) return new Error(`node ${uid}'s direct session has closed; it cannot ${what} until it reconnects`);
    if (route.kind === 'direct') return { route, key: route.session.key };
    if (!this.opts.commandKey) return new Error(`no TM_KEY: nothing can be signed for ${uid}`);
    if (route.kind === 'udp') {
      // A node heard through a local proxy (e.g. a userspace Tailscale client)
      // appears to come from loopback: there is no route back to it, and
      // "sent" would be a lie.
      if (/^(127\.|::1$|::ffff:127\.)/.test(route.address)) {
        return new Error(`node ${uid} is reached through a local proxy (${route.address}); it cannot ${what}`);
      }
      if (isIP(route.address) === 0) return new Error(`node ${uid} has no IP address to send to (${route.address})`);
    }
    return { route, key: this.opts.commandKey };
  }

  private deliver(uid: string, route: Route, buf: Buffer): Promise<void> {
    switch (route.kind) {
      case 'direct':
        // "Written to the socket" means dispatched, never applied: the node's
        // next STATUS (last_cmd, params) is what proves a command took.
        return route.session.send(buf)
          ? Promise.resolve()
          : Promise.reject(new Error(`node ${uid}'s direct session could not take the packet`));
      case 'gateway':
        return this.opts.routeViaGateway?.(route.address, buf)
          ? Promise.resolve()
          : Promise.reject(new Error(`gateway for ${uid} is not connected`));
      case 'udp':
        return new Promise((resolve, reject) =>
          this.socket.send(buf, DOWNLINK_PORT, route.address, (err) => (err ? reject(err) : resolve())),
        );
    }
  }

  /**
   * Tell a node to fetch and flash an image. It travels the same signed,
   * replay-protected path as a command, and the node downloads from whatever
   * address the packet arrives from -- its own gateway.
   */
  sendOta(uid: string, image: { port: number; size: number; sha256: string; path: string }): Promise<void> {
    const target = this.downlinkTarget(uid, 'be updated');
    if (target instanceof Error) return Promise.reject(target);
    const seq = this.allocateCommandSeq();
    const buf = buildOta(uid, { seq, ...image }, target.key);
    if (target.route.kind === 'direct') {
      // A direct node downloads over HTTPS from its provisioned cloud host,
      // on 443 only, and only with a grant bound to this very sequence and
      // build. The grant goes first, on the same socket, so the node has it
      // when the signed request arrives.
      const build = /^\/fw\/([0-9a-f]{16})\.bin$/.exec(image.path)?.[1];
      if (image.port !== 443 || !build) {
        return Promise.reject(new Error(`a direct node downloads from /fw/<build>.bin on 443, not ${image.port}${image.path}`));
      }
      if (!target.route.session.grantOta(seq, build)) {
        return Promise.reject(new Error(`could not issue a download grant to ${uid}`));
      }
    }
    return this.deliver(uid, target.route, buf);
  }

  private reject(address: string, uid: string | null, reason: string): IngestResult {
    const now = this.now();
    this.rejectTimes.push(now);
    this.rejectReasons.set(reason, (this.rejectReasons.get(reason) ?? 0) + 1);
    const key = `${address}|${uid ?? '-'}`;
    const src = this.rejectedSources.get(key);
    if (src) {
      src.count += 1;
      src.lastSeen = now;
      src.reason = reason;
    } else if (this.rejectedSources.size < MAX_UNKNOWN_SOURCES) {
      this.rejectedSources.set(key, { address, uid, count: 1, lastSeen: now, reason });
    }
    this.emit('rejected', address, reason);
    return { ok: false, uid, reason };
  }

  /**
   * Drop samples older than the window. Only the sending node's lists are
   * trimmed per packet -- trimming every node on every packet is quadratic in
   * the fleet size -- and all of them when statistics are read.
   */
  private trim(now: number, only?: NodeLink): void {
    const cut = now - WINDOW_MS;
    const dropOld = (a: number[]) => {
      let i = 0;
      while (i < a.length && (a[i] ?? 0) < cut) i++;
      if (i > 0) a.splice(0, i);
    };
    dropOld(this.packetTimes);
    dropOld(this.rejectTimes);
    let i = 0;
    while (i < this.bytesInWindow.length && (this.bytesInWindow[i]?.t ?? 0) < cut) i++;
    if (i > 0) this.bytesInWindow.splice(0, i);
    for (const link of only ? [only] : this.links.values()) {
      dropOld(link.reportTimes);
      dropOld(link.recvTimes);
      while (link.gapEvents.length > 0 && (link.gapEvents[0]?.t ?? 0) < cut) link.gapEvents.shift();
    }
  }
}
