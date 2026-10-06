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
import { ReplayStore } from './replay.js';
import { encryptPacket, encryptPayload, deriveKey, TYPE_ACK } from './secure.js';
import { randomBytes } from 'node:crypto';
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
const MAX_DURABLE_PACKETS = 4096;
const MAX_DURABLE_BYTES = 4 * 1024 * 1024;
interface PreparedPacket { packet: Packet; route: Route; receivedAt: number }

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
  secureId?: number;
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
  /** A durable write can finish after this session closes. */
  isOpen?(): boolean;
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
  secureId?: number;
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
  /** Runtime uses a durable cursor journal; tests may keep state in memory. */
  cursorPath?: string;
  /** Test hook for a delayed/failed asynchronous journal fsync. */
  journalSync?: (fd: number) => Promise<void>;
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
  private bound = false;
  private closed = false;
  private stopPromise: Promise<void> | null = null;
  private readonly replay: ReplayStore | null;
  private readonly durableTails = new Map<string, Promise<void>>();
  private readonly pendingNewNodes = new Set<string>();
  private durablePackets = 0;
  private durableBytes = 0;
  private closing = false;

  constructor(private readonly opts: IngestOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.replay = opts.cursorPath ? new ReplayStore(opts.cursorPath, { sync: opts.journalSync }) : null;
    this.lastCommandSeq = this.replay?.commandSeq ?? 0;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => {
      void this.handleDurable(msg, rinfo.address).catch((error) => this.emit('error', error));
    });
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('listening', () => {
      this.bound = true;
      const a = this.socket.address();
      this.emit('listening', { address: a.address, port: a.port });
    });
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ingest listener is closed'));
    if (this.bound) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.off('listening', onListening);
        reject(error);
      };
      this.once('listening', onListening);
      this.once('error', onError);
      try {
        this.socket.bind(this.opts.port, this.opts.host);
      } catch (error) {
        this.off('listening', onListening);
        this.off('error', onError);
        reject(error);
      }
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.closing = true;
    this.stopPromise = (async () => {
      await new Promise<void>((resolve) => {
        try { this.socket.close(() => resolve()); } catch { resolve(); }
      });
      // Stop admitting new transport data, then finish the already queued writes.
      await Promise.allSettled([...this.durableTails.values()]);
    })();
    return this.stopPromise;
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
    const prepared = this.prepare(msg, source);
    if ('ok' in prepared) return prepared;
    const refused = this.admitPacket(prepared);
    if (refused) return refused;
    const { packet, route } = prepared;
    try {
      this.replay?.accept(packet.uid, { boot: packet.boot, seq: packet.seq });
      if (packet.kind === 'status' && packet.lastCmd > this.lastCommandSeq) {
        this.replay?.command(packet.lastCmd);
        this.lastCommandSeq = packet.lastCmd;
      }
    } catch { return this.reject(route.address, packet.uid, 'replay journal unavailable'); }
    return this.commitPacket(prepared);
  }

  /** Production admission: group fsync off the event loop, then route/emit/ACK. */
  handleDurable(msg: Buffer, source: string | Route): Promise<IngestResult> {
    if (!this.replay) return Promise.resolve(this.handle(msg, source));
    const prepared = this.prepare(msg, source);
    if ('ok' in prepared) return Promise.resolve(prepared);
    const { packet, route } = prepared;
    if (this.durablePackets >= MAX_DURABLE_PACKETS || this.durableBytes + msg.length > MAX_DURABLE_BYTES) {
      return Promise.resolve(this.reject(route.address, packet.uid, 'durable ingest queue full'));
    }
    this.durablePackets += 1;
    this.durableBytes += msg.length;
    // A later packet from this UID cannot check its replay cursor before its
    // predecessor commits. Different UIDs may share the same durable batch.
    const previous = this.durableTails.get(packet.uid) ?? Promise.resolve();
    const done = previous.then(async (): Promise<IngestResult> => {
      const refused = this.admitPacket(prepared);
      if (refused) return refused;
      if (!this.links.has(packet.uid) && !this.replay!.cursors.has(packet.uid)) this.pendingNewNodes.add(packet.uid);
      try {
        const commandSeq = packet.kind === 'status' ? packet.lastCmd : undefined;
        // Reserve observed command high water before a person can issue the
        // next command during this packet's asynchronous fsync.
        if (commandSeq !== undefined) this.lastCommandSeq = Math.max(this.lastCommandSeq, commandSeq);
        await this.replay!.acceptAsync(packet.uid, { boot: packet.boot, seq: packet.seq }, commandSeq);
      } catch { return this.reject(route.address, packet.uid, 'replay journal unavailable'); }
      finally { this.pendingNewNodes.delete(packet.uid); }
      return this.commitPacket(prepared);
    });
    const result = done.finally(() => {
      this.durablePackets -= 1;
      this.durableBytes -= msg.length;
      if (this.durableTails.get(packet.uid) === tail) this.durableTails.delete(packet.uid);
    });
    const tail = result.then(() => undefined, () => undefined);
    this.durableTails.set(packet.uid, tail);
    return result;
  }

  private prepare(msg: Buffer, source: string | Route): PreparedPacket | Extract<IngestResult, { ok: false }> {
    const route: Route = typeof source === 'string'
      ? (source.startsWith('gw:') ? { kind: 'gateway', address: source } : { kind: 'udp', address: source })
      : source;
    const address = route.address;
    const now = this.now();
    this.packetTimes.push(now);
    this.bytesInWindow.push({ t: now, n: msg.length });
    this.trim(now, undefined, false);
    // Bound diagnostic samples even if all traffic is unauthenticated.
    if (this.packetTimes.length > 10000) this.packetTimes.shift();
    if (this.bytesInWindow.length > 10000) this.bytesInWindow.shift();

    const uidOf = () => msg.length >= 10 && msg[0] === 0x54 && msg[1] === 0x4d
      ? [...msg.subarray(4, 10)].map((b) => b.toString(16).padStart(2, '0')).join(':')
      : null;
    let packet: Packet;
    try {
      // A direct session is bound to one key and one node: its packets must
      // verify with that key, whatever else the edge would accept, and
      // ALLOW_UNSIGNED never applies to it.
      packet = parsePacket(msg, route.kind === 'direct'
        ? { keys: [route.session.key], allowUnsigned: false, devices: this.opts.verify.devices }
        : this.opts.verify);
    } catch (err) {
      return this.reject(address, uidOf(), err instanceof ProtocolError ? err.message : String(err));
    }
    if (route.kind === 'direct' && packet.secureId !== route.session.secureId) return this.reject(address, packet.uid, 'key does not match the session');
    if (route.kind === 'direct' && packet.uid !== route.session.uid) {
      return this.reject(address, packet.uid, 'uid does not match the session');
    }

    if (this.closing) return this.reject(address, packet.uid, 'ingest is shutting down');
    return { packet, route, receivedAt: now };
  }

  private admitPacket({ packet, route, receivedAt: now }: PreparedPacket): Extract<IngestResult, { ok: false }> | null {
    const address = route.address;
    const link = this.links.get(packet.uid);
    const saved = this.replay?.cursors.get(packet.uid);
    // A durable packet can be refused at commit after its direct session
    // closes. Its cursor still protects replays through an older live route.
    const cursor = saved && (!link || saved.boot > link.boot || (saved.boot === link.boot && saved.seq > link.seq))
      ? saved : link;
    if (cursor) {
      if (packet.boot < cursor.boot || (packet.boot === cursor.boot && packet.seq <= cursor.seq)) {
        if (link) link.rejected += 1;
        return this.reject(address, packet.uid, packet.boot < cursor.boot
          ? 'boot counter went backwards (replay, or node flash erased)'
          : 'replayed or duplicate sequence');
      }
    } else if (this.links.size + this.pendingNewNodes.size >= MAX_NODES || (this.replay?.cursors.size ?? 0) + this.pendingNewNodes.size >= MAX_NODES) {
      return this.reject(address, packet.uid, 'node table full');
    }
    if (route.kind === 'direct') {
      const refused = route.session.admit(packet, now);
      if (refused) {
        if (link) link.rejected += 1;
        return this.reject(address, packet.uid, refused);
      }
    }
    return null;
  }

  private commitPacket({ packet, route, receivedAt: now }: PreparedPacket): IngestResult {
    const address = route.address;
    // A closed/replaced direct session earns no route, occupancy or ACK even
    // if the journal happened to finish writing its cursor in the meantime.
    if (route.kind === 'direct' && route.session.isOpen?.() === false) {
      return this.reject(address, packet.uid, 'session closed');
    }
    let link = this.links.get(packet.uid);
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
    link.secureId = packet.secureId;
    link.recvTimes.push(now);
    if (link.recvTimes.length > 10000) link.recvTimes.shift();

    switch (packet.kind) {
      case 'report':
        link.reports += 1;
        link.reportTimes.push(now);
        if (link.reportTimes.length > 10000) link.reportTimes.shift();
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
    if (packet.secureId && route.kind !== 'direct' && (packet.kind === 'report' || packet.kind === 'status')) {
      const device = this.opts.verify.devices?.find(packet.uid, packet.secureId);
      if (device) {
        const epoch = randomBytes(16);
        const ack = encryptPayload({ type: TYPE_ACK, uid: packet.uid, boot: packet.boot, seq: packet.seq, uptimeMs: 0, keyId: device.id },
          Buffer.from([packet.type]), deriveKey(device.master, packet.uid, device.id, 'ack', epoch), epoch);
        void this.deliver(packet.uid, route, ack).catch(() => undefined);
      }
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
    if (seq > 0xffffffff) throw new Error('command sequence exhausted');
    this.replay?.command(seq);
    this.lastCommandSeq = seq;
    return seq;
  }

  /** Forget a node's replay cursor: for a node whose flash was erased on purpose. */
  resetCursor(uid: string): boolean {
    if (this.durablePackets) throw new Error('durable packet writes are pending; retry cursor reset');
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(uid)) throw new Error('invalid node uid');
    const saved = this.replay?.reset(uid) ?? false;
    return this.links.delete(uid) || saved;
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
  async sendCommand(uid: string, opcode: number, arg0 = 0, value = 0): Promise<number> {
    const target = this.downlinkTarget(uid, 'receive commands');
    if (target instanceof Error) return Promise.reject(target);
    const seq = this.allocateCommandSeq();
    const cmd: Command = { seq, opcode, arg0, value };
    return this.deliver(uid, target.route, this.protectDownlink(uid, buildCommand(uid, cmd, target.key))).then(() => seq);
  }

  /**
   * Which route and key a downlink to `uid` uses, or why there is none. A
   * direct session signs with the key it authenticated with, so a node still
   * on TM_KEY_PREVIOUS during a rotation gets commands it can verify.
   */
  private protectDownlink(uid: string, legacy: Buffer): Buffer {
    const link = this.links.get(uid);
    if (!link?.secureId) return legacy;
    const device = this.opts.verify.devices?.find(uid, link.secureId);
    if (!device) throw new Error('device key expired or revoked; downlink refused');
    return encryptPacket(legacy, device);
  }

  private downlinkTarget(uid: string, what: string): { route: Route; key: Buffer } | Error {
    const link = this.links.get(uid);
    if (!link) return new Error(`node ${uid} has not been heard from; no address to send to`);
    const route = link.route;
    if (!route) return new Error(`node ${uid}'s direct session has closed; it cannot ${what} until it reconnects`);
    if (link.secureId && !this.opts.verify.devices?.find(uid, link.secureId)) return new Error('device key expired or revoked');
    if (route.kind === 'direct') return { route, key: route.session.key };
    if (link.secureId) return { route, key: Buffer.alloc(32) };
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
  async sendOta(uid: string, image: { port: number; size: number; sha256: string; path: string }): Promise<void> {
    const target = this.downlinkTarget(uid, 'be updated');
    if (target instanceof Error) return Promise.reject(target);
    const seq = this.allocateCommandSeq();
    const buf = this.protectDownlink(uid, buildOta(uid, { seq, ...image }, target.key));
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

  private reject(address: string, uid: string | null, reason: string): Extract<IngestResult, { ok: false }> {
    const now = this.now();
    this.rejectTimes.push(now);
    if (this.rejectTimes.length > 10000) this.rejectTimes.shift();
    const reasonKey = this.rejectReasons.has(reason) || this.rejectReasons.size < 128 ? reason : 'other';
    this.rejectReasons.set(reasonKey, (this.rejectReasons.get(reasonKey) ?? 0) + 1);
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
  private trim(now: number, only?: NodeLink, all = true): void {
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
    for (const link of only ? [only] : all ? this.links.values() : []) {
      dropOld(link.reportTimes);
      dropOld(link.recvTimes);
      while (link.gapEvents.length > 0 && (link.gapEvents[0]?.t ?? 0) < cut) link.gapEvents.shift();
    }
  }
}
