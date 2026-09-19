/**
 * Claims about the access-gateway link (TMGW v1): only a gateway holding the
 * token gets in; what it forwards is judged exactly like a direct datagram;
 * commands find their way back to the node through it.
 */
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { GatewayServer, FrameReader, frame, addressed, parseAddressed, helloMac, T_HELLO, T_WELCOME, T_DENY, T_UPLINK, T_DOWNLINK } from '../src/edge/gwlink.js';
import { Ingest } from '../src/edge/ingest.js';
import { CMD_IDENTIFY } from '../src/edge/protocol.js';
import { identity, KEY, report } from './fixtures.js';

const TOKEN = Buffer.from('gateway-token-for-tests');
const NODE = '30:ed:a0:cb:f5:f8';

async function server(onUplink: (d: Buffer, src: string) => void, now = Date.now) {
  const gw = new GatewayServer({ port: 0, host: '127.0.0.1', token: TOKEN, edgeId: 'test-edge', onUplink, now });
  const port = await gw.listen();
  return { gw, port };
}

/** A minimal gateway client: returns the socket and a queue of frames received. */
async function client(port: number, token = TOKEN, ts = Date.now()) {
  const sock: Socket = connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));
  const frames: { type: number; payload: Buffer }[] = [];
  const reader = new FrameReader();
  sock.on('data', (c) => reader.push(c, (type, payload) => frames.push({ type, payload: Buffer.from(payload) })));
  const nonce = 'n1';
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
