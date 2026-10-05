import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceKeys, decryptPayload, deriveKey, encryptPacket, encryptPayload, secureHeader, TYPE_ACK } from '../src/edge/secure.js';
import { buildCommand, buildReport, parsePacket } from '../src/edge/protocol.js';
import { Ingest } from '../src/edge/ingest.js';
import { loadEdgeConfig } from '../src/edge/config.js';

const UID = '01:02:03:04:05:06', OTHER = '11:12:13:14:15:16';
const master = Buffer.alloc(32, 0x11), current = { id: 7, master };
const policy = () => ({ version: 2, nodes: { [UID]: { current: { id: 7, secret: master.toString('hex') } } } });
const devices = new DeviceKeys(policy());
const legacy = (seq = 100) => buildReport({ uid: UID, boot: 1, seq, key: Buffer.from('legacy') }, 1000,
  { frame: 1, ta: 22, sceneMin: 21, sceneMax: 30, bgMean: 23, flags: 1, detections: [] });
const report = (seq = 100) => encryptPacket(legacy(seq), current, 70000, Buffer.alloc(16, 0x22), 'uplink');
const verify = { keys: [Buffer.from('legacy')], allowUnsigned: true, devices };

test('encrypted packets authenticate every byte and enforce the device identity policy', () => {
  const packet = report();
  const p = parsePacket(packet, verify);
  assert.equal(p.boot, 70000); assert.equal(p.seq, 100); assert.equal(p.secureId, 7);
  for (let i = 0; i < packet.length; i++) {
    const changed = Buffer.from(packet); changed[i] = changed[i]! ^ 1;
    assert.throws(() => parsePacket(changed, verify), `tampering at byte ${i} must fail`);
  }
  assert.throws(() => parsePacket(legacy(), verify), /plaintext/);
  assert.throws(() => parsePacket(packet, { keys: [], allowUnsigned: true }), /key unavailable/);
  assert.throws(() => new DeviceKeys({ ...policy(), legacy: [UID] }), /conflicting/);
});

test('direction, device and epoch derivation separate keys, including restored counters', () => {
  const epoch = Buffer.alloc(16, 0x22);
  const a = deriveKey(master, UID, 7, 'uplink', epoch);
  for (const b of [deriveKey(master, UID, 7, 'downlink', epoch), deriveKey(master, OTHER, 7, 'uplink', epoch),
      deriveKey(master, UID, 8, 'uplink', epoch), deriveKey(master, UID, 7, 'uplink', Buffer.alloc(16, 0x23))]) assert.notDeepEqual(a, b);
  const fresh = encryptPacket(legacy(), current, 70000, undefined, 'uplink');
  assert.notDeepEqual(fresh, report()); assert.equal(parsePacket(fresh, verify).seq, 100);
  const h = secureHeader(report());
  assert.throws(() => decryptPayload(report(), deriveKey(master, UID, 7, 'downlink', h.epoch)), /authentication failed/);
  // Malformed/oversized input is rejected before decryption or allocating plaintext.
  for (let n = 0; n < 58; n++) assert.throws(() => decryptPayload(Buffer.alloc(n), a));
  assert.throws(() => encryptPayload({ type: 1, uid: UID, boot: 1, seq: 1, uptimeMs: 0, keyId: 7 }, Buffer.alloc(777), a), /too large/);
});

test('rotation overlap expires and revocation cannot fall back to a site key', () => {
  let now = 1000;
  const rotated = new DeviceKeys({ version: 2, nodes: { [UID]: {
    current: { id: 8, secret: '33'.repeat(32) }, previous: { id: 7, secret: '11'.repeat(32), expiresAt: 2000 },
  } } }, () => now);
  assert.equal(parsePacket(report(), { ...verify, devices: rotated }).secureId, 7);
  now = 2000;
  assert.throws(() => parsePacket(report(), { ...verify, devices: rotated }), /unavailable/);
  const revoked = new DeviceKeys({ version: 2, nodes: { [UID]: { current: { id: 7, secret: '11'.repeat(32) }, revoked: true } } });
  assert.throws(() => parsePacket(report(), { ...verify, devices: revoked }), /unavailable/);
  assert.throws(() => parsePacket(legacy(), { ...verify, devices: revoked }), /plaintext/);
  assert.throws(() => new DeviceKeys({ version: 2, nodes: { [UID]: { current: { id: 1, secret: '11'.repeat(32) } }, [OTHER]: { current: { id: 1, secret: '11'.repeat(32) } } } }), /distinct/);
});

test('device file permissions and schema fail closed; an encrypted-only edge needs no site key', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'device-keys-')), 'devices.json');
  writeFileSync(path, JSON.stringify(policy()), { mode: 0o600 });
  assert.ok(loadEdgeConfig({ DEVICE_KEYS_FILE: path, NODE_PORT: '5211', WEB_PUSH_URLS: '' }).devices);
  chmodSync(path, 0o644); assert.throws(() => DeviceKeys.fromFile(path), /0600/);
  chmodSync(path, 0o600); writeFileSync(path, '{}'); assert.throws(() => DeviceKeys.fromFile(path), /schema/);
});

test('encrypted report ACK and downlink wait for durable admission; restarts refuse replay', async () => {
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'secure-cursor-')), 'replay.jsonl');
  const sent: Buffer[] = []; let finish: (() => void) | undefined;
  const opts = { port: 0, host: '127.0.0.1', verify, commandKey: null, cursorPath,
    routeViaGateway: (_address: string, b: Buffer) => { sent.push(b); return true; } };
  const ing = new Ingest({ ...opts, journalSync: async () => new Promise<void>(r => { finish = r; }) });
  const pending = ing.handleDurable(report(), 'gw:test|10.0.0.1:5200');
  for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(finish); assert.equal(sent.length, 0); assert.equal(ing.links.size, 0);
  finish(); assert.equal((await pending).ok, true); assert.equal(sent.length, 1);
  const ack = sent[0]!; const h = secureHeader(ack);
  assert.equal(h.type, TYPE_ACK); assert.equal(h.boot, 70000); assert.equal(h.seq, 100);
  assert.deepEqual(decryptPayload(ack, deriveKey(master, UID, 7, 'ack', h.epoch)).payload, Buffer.from([1]));
  const seq = await ing.sendCommand(UID, 3, 0, 5);
  const command = sent[1]!; const ch = secureHeader(command);
  assert.equal(ch.seq, seq); assert.equal(ch.type, 0x10);
  const body = decryptPayload(command, deriveKey(master, UID, 7, 'downlink', ch.epoch)).payload;
  assert.deepEqual(body, buildCommand(UID, { seq, opcode: 3, arg0: 0, value: 5 }, Buffer.alloc(32)).subarray(22, -8));
  await ing.stop();
  const restarted = new Ingest(opts);
  assert.equal((await restarted.handleDurable(report(), 'gw:test|10.0.0.1:5200')).ok, false);
  assert.equal(sent.length, 2); await restarted.stop();
});
