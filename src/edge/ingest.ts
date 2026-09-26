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
import {
  buildCommand,
  buildOta,
  parsePacket,
  ProtocolError,
  type Command,
  type Raw,
  type Report,
  type OtaStatus,
  type Status,
  type VerifyOptions,
} from './protocol.js';

export const DOWNLINK_PORT = 5201;
const WINDOW_MS = 60_000;
const MAX_NODES = 5000;
const MAX_UNKNOWN_SOURCES = 200;

export interface NodeLink {
  uid: string;
  address: string;
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

  /** Exposed for tests: process one datagram as if it had arrived. */
  handle(msg: Buffer, address: string): void {
    const now = this.now();
    this.packetTimes.push(now);
    this.bytesInWindow.push({ t: now, n: msg.length });

    let packet;
    try {
      packet = parsePacket(msg, this.opts.verify);
    } catch (err) {
      const uid = msg.length >= 10 && msg[0] === 0x54 && msg[1] === 0x4d
        ? [...msg.subarray(4, 10)].map((b) => b.toString(16).padStart(2, '0')).join(':')
        : null;
      this.reject(address, uid, err instanceof ProtocolError ? err.message : String(err));
      return;
    }

    let link = this.links.get(packet.uid);
    if (link) {
      if (packet.boot < link.boot || (packet.boot === link.boot && packet.seq <= link.seq)) {
        link.rejected += 1;
        this.reject(address, packet.uid, packet.boot < link.boot
          ? 'boot counter went backwards (replay, or node flash erased)'
          : 'replayed or duplicate sequence');
        return;
      }
      if (packet.boot === link.boot && packet.seq > link.seq + 1) {
        link.gapEvents.push({ t: now, n: packet.seq - link.seq - 1 });
      }
    } else {
      if (this.links.size >= MAX_NODES) {
        this.reject(address, packet.uid, 'node table full');
        return;
      }
      link = {
        uid: packet.uid,
        address,
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
    // Follow the node's address: DHCP may move it, and commands go to wherever it last spoke from.
    link.address = address;
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
    const link = this.links.get(uid);
    if (!link) return Promise.reject(new Error(`node ${uid} has not been heard from; no address to send to`));
    if (!this.opts.commandKey) return Promise.reject(new Error('no TM_KEY: commands cannot be signed'));
    // A node heard through a local proxy (e.g. a userspace Tailscale client)
    // appears to come from loopback: there is no route back to it, and
    // "sent" would be a lie.
    if (/^(127\.|::1$|::ffff:127\.)/.test(link.address)) {
      return Promise.reject(new Error(`node ${uid} is reached through a local proxy (${link.address}); it cannot receive commands`));
    }
    // Unix seconds, but strictly increasing even for two commands in the same
    // second: the node ignores anything not newer than the last one it applied.
    const seq = Math.max(Math.floor(this.now() / 1000), this.lastCommandSeq + 1);
    this.lastCommandSeq = seq;
    const cmd: Command = { seq, opcode, arg0, value };
    const buf = buildCommand(uid, cmd, this.opts.commandKey);
    if (link.address.startsWith('gw:')) {
      return this.opts.routeViaGateway?.(link.address, buf)
        ? Promise.resolve(seq)
        : Promise.reject(new Error(`gateway for ${uid} is not connected`));
    }
    return new Promise((resolve, reject) =>
      this.socket.send(buf, DOWNLINK_PORT, link.address, (err) => (err ? reject(err) : resolve(seq))),
    );
  }

  /**
   * Tell a node to fetch and flash an image. It travels the same signed,
   * replay-protected path as a command, and the node downloads from whatever
   * address the packet arrives from -- its own gateway.
   */
  sendOta(uid: string, image: { port: number; size: number; sha256: string; path: string }): Promise<void> {
    const link = this.links.get(uid);
    if (!link) return Promise.reject(new Error(`node ${uid} has not been heard from; no address to send to`));
    if (!this.opts.commandKey) return Promise.reject(new Error('no TM_KEY: an update cannot be signed'));
    if (/^(127\.|::1$|::ffff:127\.)/.test(link.address)) {
      return Promise.reject(new Error(`node ${uid} is reached through a local proxy (${link.address}); it cannot be updated`));
    }
    const seq = Math.max(Math.floor(this.now() / 1000), this.lastCommandSeq + 1);
    this.lastCommandSeq = seq;
    const buf = buildOta(uid, { seq, ...image }, this.opts.commandKey);
    if (link.address.startsWith('gw:')) {
      return this.opts.routeViaGateway?.(link.address, buf)
        ? Promise.resolve()
        : Promise.reject(new Error(`gateway for ${uid} is not connected`));
    }
    return new Promise((resolve, reject) =>
      this.socket.send(buf, DOWNLINK_PORT, link.address, (err) => (err ? reject(err) : resolve())),
    );
  }

  private reject(address: string, uid: string | null, reason: string): void {
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
