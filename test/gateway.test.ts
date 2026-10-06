/**
 * Claims about the access-gateway link (TMGW v1): only a gateway holding the
 * token gets in; what it forwards is judged exactly like a direct datagram;
 * commands find their way back to the node through it.
 */
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayServer, FrameReader, frame, addressed, parseAddressed, helloMac, T_HELLO, T_WELCOME, T_DENY, T_UPLINK, T_DOWNLINK, T_IMAGE_READY, MAX_FRAME } from '../src/edge/gwlink.js';
import { Ingest } from '../src/edge/ingest.js';
import { CMD_IDENTIFY } from '../src/edge/protocol.js';
import { identity, KEY, report } from './fixtures.js';

const TOKEN = Buffer.from('gateway-token-for-tests');
const NODE = '30:ed:a0:cb:f5:f8';

test('gateway: per-identity tokens and durable HELLO history survive restart', async () => {
  const helloPath = join(mkdtempSync(join(tmpdir(), 'gateway-hello-')), 'hello.json');
  const opts = { port: 0, host: '127.0.0.1', token: TOKEN, tokens: (id: string) => id === 'esanhouse' ? [Buffer.from('specific-gateway-token')] : [],
    edgeId: 'test-edge', onUplink: () => undefined, helloPath, now: () => 1000 };
  const first = new GatewayServer(opts), port = await first.listen();
  const a = await client(port, Buffer.from('specific-gateway-token'), 1000, 'persisted-nonce');
  assert.ok(await a.next(T_WELCOME)); a.sock.destroy(); await first.close();
  const second = new GatewayServer(opts), p2 = await second.listen();
  try {
    const replay = await client(p2, Buffer.from('specific-gateway-token'), 1000, 'persisted-nonce');
    assert.ok(await replay.next(T_DENY)); replay.sock.destroy();
    const shared = await client(p2, TOKEN, 1000, 'fresh-nonce');
    assert.ok(await shared.next(T_DENY), 'shared token cannot bypass the identity policy'); shared.sock.destroy();
  } finally { await second.close(); }
});

test('gateway: a listener requiring WSS rejects raw TCP before authentication', async () => {
  const gw = new GatewayServer({ port: 0, host: '127.0.0.1', token: TOKEN, edgeId: 'test', onUplink: () => assert.fail(), allowRawTcp: false });
  const port = await gw.listen();
  try {
    const socket = connect(port, '127.0.0.1'); socket.on('error', () => undefined);
    const closed = new Promise<void>(r => socket.once('close', () => r()));
    socket.write(frame(T_HELLO, Buffer.from('{}'))); await closed;
    assert.equal(gw.gateways().length, 0);
  } finally { await gw.close(); }
});

async function server(onUplink: (d: Buffer, src: string) => void, now = Date.now) {
  const gw = new GatewayServer({ port: 0, host: '127.0.0.1', token: TOKEN, edgeId: 'test-edge', onUplink, now });
  const port = await gw.listen();
  return { gw, port };
}

/** A minimal gateway client: returns the socket and a queue of frames received. */
async function client(port: number, token = TOKEN, ts = Date.now(), nonce = 'n1') {
  const sock: Socket = connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  const frames: { type: number; payload: Buffer }[] = [];
  const reader = new FrameReader();
  sock.on('data', (c: Buffer) => reader.push(c, (type, payload) => frames.push({ type, payload: Buffer.from(payload) })));
  sock.write(frame(T_HELLO, Buffer.from(JSON.stringify({ v: 1, gatewayId: 'esanhouse', ts, nonce, mac: helloMac(token, 'esanhouse', ts, nonce) }))));
  const next = async (type: number, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = frames.findIndex((f) => f.type === type);
      if (i >= 0) return frames.splice(i, 1)[0]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  };
  return { sock, next };
}

test('gateway: a wrong token or a stale HELLO is refused', async () => {
  const { gw, port } = await server(() => assert.fail('no uplink expected'));
  try {
    const bad = await client(port, Buffer.from('wrong-token-wrong-token'));
    assert.match(String((await bad.next(T_DENY))?.payload), /bad token/);
    bad.sock.destroy();
    const stale = await client(port, TOKEN, Date.now() - 10 * 60_000);
    assert.match(String((await stale.next(T_DENY))?.payload), /clock skew|replayed/);
    stale.sock.destroy();
    assert.equal(gw.gateways().length, 0);
  } finally {
    await gw.close();
  }
});

test('gateway: forwarded datagrams are judged like direct ones, and commands route back through the gateway', async () => {
  const ing = new Ingest({
    port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY,
    routeViaGateway: (address, buf) => gw.sendDownlink(address, buf),
  });
  const seen: string[] = [];
  const rejected: string[] = [];
  ing.on('report', (_p, address) => seen.push(address));
  ing.on('rejected', (_a, reason) => rejected.push(reason));
  const { gw, port } = await server((d, src) => ing.handle(d, src));
  try {
    const c = await client(port);
    assert.ok(await c.next(T_WELCOME), 'welcomed');
    const id = identity(NODE);
    c.sock.write(frame(T_UPLINK, addressed('192.168.0.9', 58000, report(id, [], 1))));
    const forged = report({ uid: NODE, boot: 1, seq: 99, key: Buffer.from('not-the-key') }, [], 2);
    c.sock.write(frame(T_UPLINK, addressed('192.168.0.9', 58000, forged)));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, ['gw:esanhouse|192.168.0.9:58000']);
    assert.deepEqual(rejected, ['bad signature'], 'the gateway cannot launder a forged packet');
    assert.equal(gw.gateways()[0]?.uplink, 2);

    await ing.sendCommand(NODE, CMD_IDENTIFY, 0, 5);
    const down = await c.next(T_DOWNLINK);
    const d = down && parseAddressed(down.payload);
    assert.ok(d, 'command came down the link');
    assert.equal(d.addr, '192.168.0.9');
    assert.equal(d.port, 58000);
    assert.equal(d.datagram[3], 0x10, 'it is a TM COMMAND');
    c.sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(ing.sendCommand(NODE, CMD_IDENTIFY, 0, 5), /gateway .* not connected/);
  } finally {
    await gw.close();
  }
});

test('gateway over WebSocket on the same port: same auth, relay and commands; CF-Connecting-IP trusted only from loopback', async () => {
  const ing = new Ingest({
    port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY,
    routeViaGateway: (address, buf) => gw.sendDownlink(address, buf),
  });
  const seen: string[] = [];
  ing.on('report', (_p, address) => seen.push(address));
  const { gw, port } = await server((d, src) => ing.handle(d, src));
  try {
    // A plain HTTP request to the port is not mistaken for TMGW.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 426);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tmgw`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const got: { type: number; payload: Buffer }[] = [];
    const reader = new FrameReader();
    ws.onmessage = (e) => reader.push(Buffer.from(e.data as ArrayBuffer), (type, payload) => got.push({ type, payload: Buffer.from(payload) }));
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const ts = Date.now();
    ws.send(frame(T_HELLO, Buffer.from(JSON.stringify({ v: 1, gatewayId: 'cf-gw', ts, nonce: 'w', mac: helloMac(TOKEN, 'cf-gw', ts, 'w') }))));
    ws.send(frame(T_UPLINK, addressed('192.168.0.9', 58000, report(identity(NODE), [], 1))));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(got.some((f) => f.type === T_WELCOME));
    assert.deepEqual(seen, ['gw:cf-gw|192.168.0.9:58000']);
    const info = gw.gateways()[0];
    assert.equal(info?.transport, 'websocket');
    assert.equal(info?.remote, '203.0.113.7 via Cloudflare', 'from loopback (cloudflared), the header names the gateway');
    await ing.sendCommand(NODE, CMD_IDENTIFY, 0, 5);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(got.some((f) => f.type === T_DOWNLINK), 'command came down the WebSocket');
    ws.close();
  } finally {
    await gw.close();
  }
});

test('gateway: replaying an accepted HELLO does not replace the live gateway', async () => {
  const { gw, port } = await server(() => undefined);
  const ts = Date.now();
  try {
    const original = await client(port, TOKEN, ts);
    assert.ok(await original.next(T_WELCOME));
    const connectedAt = gw.gateways()[0]?.connectedAt;
    const replay = await client(port, TOKEN, ts);
    assert.match(String((await replay.next(T_DENY))?.payload), /replayed HELLO/);
    assert.equal(original.sock.destroyed, false, 'the accepted connection survives');
    assert.equal(gw.gateways()[0]?.connectedAt, connectedAt);
    replay.sock.destroy();
    original.sock.destroy();
  } finally { await gw.close(); }
});

test('gateway: rejection is terminal even if a valid HELLO follows in the same read', async () => {
  const { gw, port } = await server(() => assert.fail('no uplink expected'));
  const sock = connect(port, '127.0.0.1');
  const frames: number[] = [];
  const reader = new FrameReader();
  sock.on('data', (b: Buffer) => reader.push(b, (type) => frames.push(type)));
  try {
    await new Promise<void>((r) => sock.once('connect', r));
    const ts = Date.now();
    const nonce = 'coalesced';
    const hello = frame(T_HELLO, Buffer.from(JSON.stringify({ v: 1, gatewayId: 'esanhouse', ts, nonce, mac: helloMac(TOKEN, 'esanhouse', ts, nonce) })));
    sock.write(Buffer.concat([frame(T_UPLINK, Buffer.alloc(0)), hello]));
    await new Promise<void>((r) => sock.once('close', () => r()));
    assert.deepEqual(frames, [T_DENY]);
    assert.equal(gw.gateways().length, 0);
  } finally { sock.destroy(); await gw.close(); }
});

test('gateway: a fragmented HTTP method is routed to the HTTP server', async () => {
  const { gw, port } = await server(() => undefined);
  const sock = connect(port, '127.0.0.1');
  let response = '';
  sock.on('data', (d) => { response += d.toString(); });
  try {
    await new Promise<void>((r) => sock.once('connect', r));
    sock.write('G');
    await new Promise((r) => setTimeout(r, 30));
    sock.write('ET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await new Promise<void>((r) => sock.once('close', () => r()));
    assert.match(response, /^HTTP\/1.1 426/);
  } finally { sock.destroy(); await gw.close(); }
});

test('gateway: malformed upgrade URLs receive an error and leave the server working', async () => {
  const { gw, port } = await server(() => undefined);
  const sock = connect(port, '127.0.0.1');
  let response = '';
  sock.on('data', (d) => { response += d.toString(); });
  try {
    await new Promise<void>((r) => sock.once('connect', r));
    sock.write('GET http://[bad/tmgw HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await new Promise<void>((r) => sock.once('close', () => r()));
    assert.match(response, /^HTTP\/1.1 400/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 426);
  } finally { sock.destroy(); await gw.close(); }
});

test('gateway: close includes clients still waiting to send their first byte', async () => {
  const { gw, port } = await server(() => undefined);
  const sock = connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', r));
  const start = Date.now();
  await gw.close();
  assert.ok(Date.now() - start < 1000);
  sock.destroy();
});

test('gateway: rejects non-IP addresses and invalid image-ready payloads', async () => {
  const ready: unknown[] = [];
  const gw = new GatewayServer({ port: 0, host: '127.0.0.1', token: TOKEN, edgeId: 'test', onUplink: () => assert.fail('bad IP must not reach ingest'), onImageReady: (_id, result) => ready.push(result) });
  const port = await gw.listen();
  try {
    const c = await client(port);
    assert.ok(await c.next(T_WELCOME));
    const badAddress = Buffer.concat([Buffer.from([6]), Buffer.from('host.x'), Buffer.from([1, 0]), report(identity(NODE), [], 1)]);
    c.sock.write(frame(T_UPLINK, badAddress));
    for (const value of [null, {}, { id: '0123456789abcdef', ok: true, port: 0 }, { id: '0123456789abcdef', ok: 'true', port: 5282 }]) {
      c.sock.write(frame(T_IMAGE_READY, Buffer.from(JSON.stringify(value))));
    }
    c.sock.write(frame(T_IMAGE_READY, Buffer.from(JSON.stringify({ id: '0123456789abcdef', ok: true, port: 5282 }))));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(gw.gateways()[0]?.uplink, 0);
    assert.deepEqual(ready, [{ id: '0123456789abcdef', ok: true, port: 5282 }]);
    c.sock.destroy();
  } finally { await gw.close(); }
});

test('gateway framing: handles byte fragments and refuses oversized outbound frames', () => {
  const reader = new FrameReader();
  const got: string[] = [];
  const input = Buffer.concat([frame(T_HELLO, Buffer.from('hello')), frame(T_UPLINK, Buffer.from('data'))]);
  for (const b of input) reader.push(Buffer.from([b]), (_type, p) => got.push(p.toString()));
  assert.deepEqual(got, ['hello', 'data']);
  assert.throws(() => frame(T_HELLO, Buffer.alloc(MAX_FRAME)), /bad frame/);
  assert.throws(() => addressed('example.com', 5200, Buffer.alloc(0)), /bad node address/);
});
