/** Encrypted wire v2. Mirrors TMsense/src/tm_secure.cpp; crosscheck is mandatory. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const SECURE_VERSION = 2;
export const SECURE_HEADER = 42;
export const SECURE_TAG = 16;
export const SECURE_MAX = SECURE_HEADER + 776 + SECURE_TAG;
export const TYPE_ACK = 0x12;
export const TYPE_CONTROL = 0x13;
const UID = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export class SecureError extends Error {}
export interface DeviceKey { id: number; master: Buffer; expiresAt?: number }
interface Device { current: DeviceKey; previous?: DeviceKey; revoked: boolean }
export interface SecureHeader { type: number; uid: string; boot: number; seq: number; uptimeMs: number; keyId: number; epoch: Buffer }
function uidBytes(uid: string): Buffer {
  if (!UID.test(uid)) throw new SecureError('invalid device identity');
  return Buffer.from(uid.replaceAll(':', ''), 'hex');
}
export function deriveKey(master: Buffer, uid: string, id: number, role: string, salt: Buffer = Buffer.alloc(32)): Buffer {
  if (master.length !== 32 || !Number.isInteger(id) || id < 1 || id > 65535) throw new SecureError('invalid device key');
  const tail = Buffer.alloc(8); uidBytes(uid).copy(tail); tail.writeUInt16LE(id, 6);
  return Buffer.from(hkdfSync('sha256', master, salt, Buffer.concat([Buffer.from(`tmsense2/${role}\0`), tail]), 32));
}
export function secureHeader(buf: Buffer): SecureHeader {
  if (buf.length < SECURE_HEADER + SECURE_TAG || buf.length > SECURE_MAX || buf[0] !== 84 || buf[1] !== 77 || buf[2] !== 2) throw new SecureError('invalid encrypted packet');
  if (buf.readUInt16LE(22) + SECURE_HEADER + SECURE_TAG !== buf.length || buf.readUInt16LE(24) === 0) throw new SecureError('encrypted length or key id');
  return { type: buf[3]!, uid: [...buf.subarray(4, 10)].map(b => b.toString(16).padStart(2, '0')).join(':'),
    boot: buf.readUInt32LE(10), seq: buf.readUInt32LE(14), uptimeMs: buf.readUInt32LE(18), keyId: buf.readUInt16LE(24), epoch: buf.subarray(26, 42) };
}
function nonce(boot: number, seq: number): Buffer {
  const b = Buffer.alloc(12); b.writeUInt32LE(boot, 4); b.writeUInt32LE(seq, 8); return b;
}
export function encryptPayload(h: Omit<SecureHeader, 'epoch'>, payload: Buffer, key: Buffer, epoch = randomBytes(16)): Buffer {
  if (payload.length > 776 || epoch.length !== 16 || key.length !== 32) throw new SecureError('encrypted payload too large or invalid key');
  const b = Buffer.alloc(SECURE_HEADER); b.write('TM'); b[2] = 2; b[3] = h.type; uidBytes(h.uid).copy(b, 4);
  b.writeUInt32LE(h.boot, 10); b.writeUInt32LE(h.seq, 14); b.writeUInt32LE(h.uptimeMs, 18);
  b.writeUInt16LE(payload.length, 22); b.writeUInt16LE(h.keyId, 24); epoch.copy(b, 26);
  const c = createCipheriv('aes-256-gcm', key, nonce(h.boot, h.seq), { authTagLength: SECURE_TAG }); c.setAAD(b);
  return Buffer.concat([b, c.update(payload), c.final(), c.getAuthTag()]);
}
export function decryptPayload(buf: Buffer, key: Buffer): { header: SecureHeader; payload: Buffer } {
  const h = secureHeader(buf);
  try {
    const c = createDecipheriv('aes-256-gcm', key, nonce(h.boot, h.seq), { authTagLength: SECURE_TAG });
    c.setAAD(buf.subarray(0, SECURE_HEADER)); c.setAuthTag(buf.subarray(-SECURE_TAG));
    // No plaintext is returned until final() has authenticated it.
    return { header: h, payload: Buffer.concat([c.update(buf.subarray(SECURE_HEADER, -SECURE_TAG)), c.final()]) };
  } catch { throw new SecureError('encrypted authentication failed'); }
}
/** Convert an already built v1 payload; the legacy HMAC is not put on the wire. */
export function encryptPacket(legacy: Buffer, device: DeviceKey, boot = 0, epoch = randomBytes(16), role = 'downlink'): Buffer {
  const uid = [...legacy.subarray(4, 10)].map(b => b.toString(16).padStart(2, '0')).join(':');
  const isDown = legacy[3] === 0x10 || legacy[3] === 0x11;
  const seq = isDown ? legacy.readUInt32LE(22) : legacy.readUInt32LE(12);
  return encryptPayload({ type: legacy[3]!, uid, boot, seq, uptimeMs: legacy.readUInt32LE(16), keyId: device.id },
    legacy.subarray(22, -8), deriveKey(device.master, uid, device.id, role, epoch), epoch);
}

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SecureError('invalid device key file');
  return v as Record<string, unknown>;
}
/** A separate mode-0600 file, never nodes.json or a console response. Restart after rotation. */
export class DeviceKeys {
  private readonly devices = new Map<string, Device>();
  private readonly legacy = new Set<string>();
  constructor(value: unknown, private readonly now: () => number = Date.now) {
    const root = object(value);
    if (root.version !== 2 || Object.keys(root).some(k => !['version', 'nodes', 'legacy'].includes(k))) throw new SecureError('invalid device key schema');
    const nodes = object(root.nodes), legacy = root.legacy ?? [];
    if (Object.keys(nodes).length > 5000 || !Array.isArray(legacy) || legacy.length > 5000) throw new SecureError('device key capacity exceeded');
    const secrets = new Set<string>();
    const key = (v: unknown, previous: boolean): DeviceKey => {
      const k = object(v);
      if (Object.keys(k).some(n => !['id', 'secret', 'expiresAt'].includes(n)) || !Number.isInteger(k.id) || Number(k.id) < 1 || Number(k.id) > 65535 || typeof k.secret !== 'string' || !/^[0-9a-f]{64}$/.test(k.secret) || /^0+$/.test(k.secret)) throw new SecureError('invalid per-device key');
      if (secrets.has(k.secret)) throw new SecureError('device keys must be distinct'); secrets.add(k.secret);
      if (previous && (!Number.isSafeInteger(k.expiresAt) || Number(k.expiresAt) > now() + 30 * 86400_000)) throw new SecureError('previous key needs a bounded expiry');
      if (!previous && k.expiresAt !== undefined) throw new SecureError('current key cannot have a rotation expiry');
      return { id: Number(k.id), master: Buffer.from(k.secret, 'hex'), ...(previous ? { expiresAt: Number(k.expiresAt) } : {}) };
    };
    for (const [uid, value] of Object.entries(nodes)) {
      uidBytes(uid); const v = object(value);
      if (Object.keys(v).some(k => !['current', 'previous', 'revoked'].includes(k)) || (v.revoked !== undefined && typeof v.revoked !== 'boolean')) throw new SecureError('invalid device policy');
      const current = key(v.current, false), previous = v.previous === undefined ? undefined : key(v.previous, true);
      if (previous?.id === current.id) throw new SecureError('rotation requires a new key id');
      this.devices.set(uid, { current, previous, revoked: v.revoked === true });
    }
    for (const uid of legacy) {
      if (typeof uid !== 'string') throw new SecureError('invalid legacy identity'); uidBytes(uid);
      if (this.devices.has(uid) || this.legacy.has(uid)) throw new SecureError('conflicting device policy'); this.legacy.add(uid);
    }
  }
  static fromFile(path: string): DeviceKeys {
    const s = statSync(path);
    if (!s.isFile() || s.size > 2 * 1024 * 1024 || (s.mode & 0o077)) throw new SecureError('device key file must be a bounded mode-0600 file');
    return new DeviceKeys(JSON.parse(readFileSync(path, 'utf8')));
  }
  allowsLegacy(uid: string): boolean { return this.legacy.has(uid); }
  keys(uid: string): DeviceKey[] {
    const d = this.devices.get(uid);
    return !d || d.revoked ? [] : [d.current, ...(d.previous && d.previous.expiresAt! > this.now() ? [d.previous] : [])];
  }
  find(uid: string, id: number): DeviceKey | undefined { return this.keys(uid).find(k => k.id === id); }
}

/** Per-gateway credentials. Supplying this policy disables shared-token fallback. */
export class GatewayKeys {
  private readonly entries = new Map<string, { current: Buffer; previous?: { token: Buffer; expiresAt: number }; revoked: boolean }>();
  constructor(value: unknown, private readonly now: () => number = Date.now) {
    const root = object(value), entries = object(root.gateways);
    if (root.version !== 1 || Object.keys(root).some(k => !['version', 'gateways'].includes(k)) || Object.keys(entries).length > 5000) throw new SecureError('invalid gateway credential schema');
    const seen = new Set<string>();
    const token = (value: unknown): Buffer => {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value) || seen.has(value)) throw new SecureError('gateway credentials must be distinct random 64-hex strings');
      seen.add(value); return Buffer.from(value, 'utf8');
    };
    for (const [id, raw] of Object.entries(entries)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new SecureError('invalid gateway identity');
      const v = object(raw);
      if (Object.keys(v).some(k => !['current', 'previous', 'revoked'].includes(k)) || (v.revoked !== undefined && typeof v.revoked !== 'boolean')) throw new SecureError('invalid gateway credential policy');
      let previous: { token: Buffer; expiresAt: number } | undefined;
      if (v.previous !== undefined) {
        const p = object(v.previous);
        if (Object.keys(p).some(k => !['secret', 'expiresAt'].includes(k)) || !Number.isSafeInteger(p.expiresAt) || Number(p.expiresAt) > now() + 30 * 86400_000) throw new SecureError('previous gateway token needs a bounded expiry');
        previous = { token: token(p.secret), expiresAt: Number(p.expiresAt) };
      }
      this.entries.set(id, { current: token(v.current), previous, revoked: v.revoked === true });
    }
  }
  static fromFile(path: string): GatewayKeys {
    const s = statSync(path);
    if (!s.isFile() || s.size > 2 * 1024 * 1024 || (s.mode & 0o077)) throw new SecureError('gateway key file must be a bounded mode-0600 file');
    return new GatewayKeys(JSON.parse(readFileSync(path, 'utf8')));
  }
  tokens(id: string): Buffer[] {
    const e = this.entries.get(id);
    return !e || e.revoked ? [] : [e.current, ...(e.previous && e.previous.expiresAt > this.now() ? [e.previous.token] : [])];
  }
}
