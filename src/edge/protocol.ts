/**
 * TMnode wire protocol v1 -- mirror of TMnode/include/tm_protocol.h, which is
 * the source of truth. Change both together and run `npm run crosscheck`,
 * which parses bytes produced by the firmware's own serializer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAGIC = Buffer.from('TM', 'latin1');
export const VERSION = 1;
export const HEADER_SIZE = 22;
export const TAG_SIZE = 8;
export const GRID_SIZE = 768;
export const MAX_DETECTIONS = 24;

export const TYPE_REPORT = 0x01;
export const TYPE_RAW = 0x02;
export const TYPE_STATUS = 0x03;
export const TYPE_COMMAND = 0x10;

export const REPORT_BACKGROUND_READY = 0x01;
export const REPORT_GLOBAL_SHIFT = 0x02;
export const REPORT_TRUNCATED = 0x04;

export const STATUS_SENSOR_OK = 0x01;
export const STATUS_BACKGROUND_READY = 0x02;
export const STATUS_SIGNED = 0x04;

export const CMD_SET_PARAM = 1;
export const CMD_RESET_BACKGROUND = 2;
export const CMD_IDENTIFY = 3;
export const CMD_REBOOT = 4;
export const CMD_SAVE_PARAMS = 5;

/** TM_PARAM_* order. Append only. */
export const PARAM_NAMES = [
  'min_contrast', 'min_peak', 'noise_k', 'min_area', 'max_area',
  'bg_tau', 'bg_frames', 'raw_every', 'refresh', 'split_sep',
] as const;
export type ParamName = (typeof PARAM_NAMES)[number];

export class ProtocolError extends Error {}

export interface Header {
  type: number;
  uid: string;
  boot: number;
  seq: number;
  uptimeMs: number;
  signed: boolean;
}

export interface Detection {
  x: number;
  y: number;
  area: number;
  contrast: number;
  peak: number;
  heat: number;
}

export interface Report extends Header {
  kind: 'report';
  frame: number;
  ta: number;
  sceneMin: number;
  sceneMax: number;
  bgMean: number;
  flags: number;
  detections: Detection[];
}

export interface Raw extends Header {
  kind: 'raw';
  frame: number;
  tMin: number;
  step: number;
  pixels: Uint8Array;
}

export interface Status extends Header {
  kind: 'status';
  fw: string;
  ip: string;
  rssi: number;
  channel: number;
  freeHeap: number;
  minHeap: number;
  stackFree: number;
  wifiDrops: number;
  sensorErrors: number;
  frames: number;
  fps: number;
  vdd: number;
  ta: number;
  lastCmd: number;
  flags: number;
  params: Partial<Record<ParamName, number>>;
}

export type Packet = Report | Raw | Status;

export function uidToString(b: Buffer): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
}

export function uidFromString(s: string): Buffer {
  const hex = s.replace(/[:-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new ProtocolError(`bad uid "${s}"`);
  return Buffer.from(hex, 'hex');
}

export function tag(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest().subarray(0, TAG_SIZE);
}

export interface VerifyOptions {
  /** Accepted keys: the current one first, then any still being rotated out. */
  keys: Buffer[];
  allowUnsigned: boolean;
}

/**
 * Parse and authenticate one datagram. Throws ProtocolError with a reason
 * short enough to count and display.
 */
export function parsePacket(buf: Buffer, verify: VerifyOptions): Packet {
  if (buf.length < HEADER_SIZE + TAG_SIZE) throw new ProtocolError('short datagram');
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) throw new ProtocolError('bad magic');
  if (buf[2] !== VERSION) throw new ProtocolError(`unsupported version ${buf[2]}`);
  const payloadLen = buf.readUInt16LE(20);
  if (buf.length !== HEADER_SIZE + payloadLen + TAG_SIZE) throw new ProtocolError('length mismatch');

  const signedPart = buf.subarray(0, HEADER_SIZE + payloadLen);
  const got = buf.subarray(HEADER_SIZE + payloadLen);
  const signed = got.some((b) => b !== 0);
  if (signed) {
    if (!verify.keys.some((k) => timingSafeEqual(tag(k, signedPart), got))) throw new ProtocolError('bad signature');
  } else if (!verify.allowUnsigned) {
    throw new ProtocolError('unsigned');
  }

  const header: Header = {
    type: buf[3] ?? 0,
    uid: uidToString(buf.subarray(4, 10)),
    boot: buf.readUInt16LE(10),
    seq: buf.readUInt32LE(12),
    uptimeMs: buf.readUInt32LE(16),
    signed,
  };
  const p = buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);

  switch (header.type) {
    case TYPE_REPORT: {
      if (p.length < 14) throw new ProtocolError('short report');
      const count = p[13] ?? 0;
      if (count > MAX_DETECTIONS || p.length !== 14 + 7 * count) throw new ProtocolError('report length');
      const detections: Detection[] = [];
      for (let i = 0; i < count; i++) {
        const o = 14 + 7 * i;
        detections.push({
          x: (p[o] ?? 0) / 8,
          y: (p[o + 1] ?? 0) / 8,
          area: p[o + 2] ?? 0,
          contrast: (p[o + 3] ?? 0) * 0.05,
          peak: (p[o + 4] ?? 0) * 0.25,
          heat: p.readUInt16LE(o + 5) / 10,
        });
      }
      return {
        ...header,
        kind: 'report',
        frame: p.readUInt32LE(0),
        ta: p.readInt16LE(4) / 100,
        sceneMin: p.readInt16LE(6) / 100,
        sceneMax: p.readInt16LE(8) / 100,
        bgMean: p.readInt16LE(10) / 100,
        flags: p[12] ?? 0,
        detections,
      };
    }
    case TYPE_RAW: {
      if (p.length !== 8 + GRID_SIZE) throw new ProtocolError('raw length');
      return {
        ...header,
        kind: 'raw',
        frame: p.readUInt32LE(0),
        tMin: p.readInt16LE(4) / 100,
        step: p.readUInt16LE(6) / 10000,
        pixels: new Uint8Array(p.subarray(8)),
      };
    }
    case TYPE_STATUS: {
      if (p.length < 48) throw new ProtocolError('short status');
      const count = p[47] ?? 0;
      if (p.length !== 48 + 4 * count) throw new ProtocolError('status length');
      const params: Partial<Record<ParamName, number>> = {};
      for (let i = 0; i < count && i < PARAM_NAMES.length; i++) {
        const name = PARAM_NAMES[i];
        if (name) params[name] = p.readInt32LE(48 + 4 * i);
      }
      return {
        ...header,
        kind: 'status',
        fw: p.subarray(0, 12).toString('latin1').replace(/\0+$/, ''),
        ip: [...p.subarray(12, 16)].join('.'),
        rssi: p.readInt8(16),
        channel: p[17] ?? 0,
        freeHeap: p.readUInt32LE(18),
        minHeap: p.readUInt32LE(22),
        stackFree: p.readUInt16LE(26),
        wifiDrops: p.readUInt16LE(28),
        sensorErrors: p.readUInt16LE(30),
        frames: p.readUInt32LE(32),
        fps: p.readUInt16LE(36) / 100,
        vdd: p.readUInt16LE(38) / 100,
        ta: p.readInt16LE(40) / 100,
        lastCmd: p.readUInt32LE(42),
        flags: p[46] ?? 0,
        params,
      };
    }
    default:
      throw new ProtocolError(`unexpected packet type ${header.type}`);
  }
}

export interface Command {
  seq: number;
  opcode: number;
  arg0: number;
  value: number;
}

export function buildCommand(uid: string, cmd: Command, key: Buffer): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + 10 + TAG_SIZE);
  MAGIC.copy(buf, 0);
  buf[2] = VERSION;
  buf[3] = TYPE_COMMAND;
  uidFromString(uid).copy(buf, 4);
  buf.writeUInt16LE(10, 20);
  buf.writeUInt32LE(cmd.seq >>> 0, 22);
  buf[26] = cmd.opcode;
  buf[27] = cmd.arg0;
  buf.writeInt32LE(cmd.value | 0, 28);
  tag(key, buf.subarray(0, HEADER_SIZE + 10)).copy(buf, HEADER_SIZE + 10);
  return buf;
}

// --- Builders for the simulator and tests (the node has its own in C) -------

function header(type: number, uid: string, boot: number, seq: number, uptimeMs: number, len: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + len + TAG_SIZE);
  MAGIC.copy(buf, 0);
  buf[2] = VERSION;
  buf[3] = type;
  uidFromString(uid).copy(buf, 4);
  buf.writeUInt16LE(boot, 10);
  buf.writeUInt32LE(seq >>> 0, 12);
  buf.writeUInt32LE(uptimeMs >>> 0, 16);
  buf.writeUInt16LE(len, 20);
  return buf;
}

function seal(buf: Buffer, key: Buffer | null): Buffer {
  const n = buf.length - TAG_SIZE;
  if (key) tag(key, buf.subarray(0, n)).copy(buf, n);
  return buf;
}

const clampU8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export interface Identity {
  uid: string;
  boot: number;
  seq: number;
  key: Buffer | null;
}

export function buildReport(id: Identity, uptimeMs: number, r: Omit<Report, keyof Header | 'kind'>): Buffer {
  const dets = r.detections.slice(0, MAX_DETECTIONS);
  const buf = header(TYPE_REPORT, id.uid, id.boot, id.seq++, uptimeMs, 14 + 7 * dets.length);
  const p = HEADER_SIZE;
  buf.writeUInt32LE(r.frame >>> 0, p);
  buf.writeInt16LE(Math.round(r.ta * 100), p + 4);
  buf.writeInt16LE(Math.round(r.sceneMin * 100), p + 6);
  buf.writeInt16LE(Math.round(r.sceneMax * 100), p + 8);
  buf.writeInt16LE(Math.round(r.bgMean * 100), p + 10);
  buf[p + 12] = r.flags | (r.detections.length > MAX_DETECTIONS ? REPORT_TRUNCATED : 0);
  buf[p + 13] = dets.length;
  dets.forEach((d, i) => {
    const o = p + 14 + 7 * i;
    buf[o] = clampU8(d.x * 8);
    buf[o + 1] = clampU8(d.y * 8);
    buf[o + 2] = clampU8(d.area);
    buf[o + 3] = clampU8(d.contrast / 0.05);
    buf[o + 4] = clampU8(d.peak / 0.25);
    buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(d.heat * 10))), o + 5);
  });
  return seal(buf, id.key);
}

export function buildRaw(id: Identity, uptimeMs: number, frame: number, temps: Float32Array | number[]): Buffer {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of temps) {
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const loC = Math.floor(lo * 100);
  const stepQ = Math.min(65535, Math.max(1, Math.ceil(((hi - loC / 100) / 255) * 10000)));
  const buf = header(TYPE_RAW, id.uid, id.boot, id.seq++, uptimeMs, 8 + GRID_SIZE);
  buf.writeUInt32LE(frame >>> 0, HEADER_SIZE);
  buf.writeInt16LE(loC, HEADER_SIZE + 4);
  buf.writeUInt16LE(stepQ, HEADER_SIZE + 6);
  for (let i = 0; i < GRID_SIZE; i++) buf[HEADER_SIZE + 8 + i] = clampU8(((temps[i] ?? lo) - loC / 100) / (stepQ / 10000));
  return seal(buf, id.key);
}

export function buildStatus(id: Identity, uptimeMs: number, s: Omit<Status, keyof Header | 'kind'>): Buffer {
  // Params are positional on the wire, so only a gap-free prefix can be sent.
  const names: ParamName[] = [];
  for (const n of PARAM_NAMES) {
    if (s.params[n] === undefined) break;
    names.push(n);
  }
  const buf = header(TYPE_STATUS, id.uid, id.boot, id.seq++, uptimeMs, 48 + 4 * names.length);
  const p = HEADER_SIZE;
  buf.write(s.fw.slice(0, 12), p, 'latin1');
  s.ip.split('.').forEach((o, i) => (buf[p + 12 + i] = Number(o) & 255));
  buf.writeInt8(s.rssi, p + 16);
  buf[p + 17] = s.channel;
  buf.writeUInt32LE(s.freeHeap, p + 18);
  buf.writeUInt32LE(s.minHeap, p + 22);
  buf.writeUInt16LE(s.stackFree, p + 26);
  buf.writeUInt16LE(s.wifiDrops, p + 28);
  buf.writeUInt16LE(s.sensorErrors, p + 30);
  buf.writeUInt32LE(s.frames >>> 0, p + 32);
  buf.writeUInt16LE(Math.round(s.fps * 100), p + 36);
  buf.writeUInt16LE(Math.round(s.vdd * 100), p + 38);
  buf.writeInt16LE(Math.round(s.ta * 100), p + 40);
  buf.writeUInt32LE(s.lastCmd >>> 0, p + 42);
  buf[p + 46] = s.flags;
  buf[p + 47] = names.length;
  names.forEach((n, i) => buf.writeInt32LE(s.params[n] ?? 0, p + 48 + 4 * i));
  return seal(buf, id.key);
}
