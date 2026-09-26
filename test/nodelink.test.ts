/**
 * Claims about direct-to-cloud nodes (tmnode.v1). Each names what a student,
 * an admin or an installer would notice if it broke.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { DEFAULT_NODE_LIMITS, EnvError, loadEdgeConfig, type NodeListenerLimits } from '../src/edge/config.js';
import { Ingest } from '../src/edge/ingest.js';
import { CLOSE, NodeServer, SUBPROTOCOL } from '../src/edge/nodelink.js';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { buildRaw, buildStatus, CMD_IDENTIFY, tag, TYPE_COMMAND, TYPE_OTA, type Report } from '../src/edge/protocol.js';
import { DirectNodeClient } from '../src/tools/directnode.js';
import { identity, KEY, makerspace, personAt, report } from './fixtures.js';

const REAL = '30:ed:a0:cb:f5:f8';       // owns M3
const OTHER = '02:00:00:00:00:02';      // registered too
const PREVIOUS = Buffer.from('previous-key');
const BUILD = '0123456789abcdef';
const IMAGE = Buffer.alloc(4096, 7);

interface Harness {
  ing: Ingest;
  server: NodeServer;
  url: string;
  port: number;
  clock: { mono: number | null };
  reports: Report[];
  approved: Set<string>;
  close(): Promise<void>;
}

async function harness(limits: Partial<NodeListenerLimits> = {}, timings = {}): Promise<Harness> {
  const reg = makerspace();
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY, PREVIOUS], allowUnsigned: true }, commandKey: KEY });
  const reports: Report[] = [];
  ing.on('report', (p) => reports.push(p));
  const clock: { mono: number | null } = { mono: null };
  const approved = new Set<string>();
  const server = new NodeServer({
    host: '127.0.0.1', port: 0, limits: { ...DEFAULT_NODE_LIMITS, ...limits }, keys: [KEY, PREVIOUS],
    isRegistered: (uid) => reg.nodes.has(uid),
    ingest: (d, r) => ing.handle(d, r),
    dropRoute: (uid, sid) => void ing.dropDirectRoute(uid, sid),
    image: (id) => (id === BUILD ? IMAGE : null),
    otaApproved: (uid, id) => approved.has(`${uid}|${id}`),
    mono: () => clock.mono ?? performance.now(),
    timings,
  });
  const port = await server.listen();
  return {
    ing, server, port, url: `ws://127.0.0.1:${port}/tmnode`, clock, reports, approved,
    close: () => server.close(),
  };
}

async function connected(h: Harness, uid = REAL, key = KEY): Promise<DirectNodeClient> {
  const c = new DirectNodeClient(h.url, uid, key);
  await c.connect();
  return c;
}

const closed = (c: DirectNodeClient, ms = 2000) => c.until(() => c.closeCode !== null, ms);

/** Poll a server-side condition: the client hears nothing when the server updates its own state. */
async function eventually(pred: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- handshake -------------------------------------------------------------------

test('direct: a registered node with the site key authenticates, and its accepted REPORT is acknowledged', async () => {
  const h = await harness();
  const c = await connected(h);
  const id = identity(REAL, 9);
  c.send(report(id, [], 1));
  await c.until(() => c.acks.length === 1);
  assert.deepEqual(c.acks[0], { session: c.session, boot: 9, seq: 0 });
  assert.equal(h.reports.length, 1, 'the report reached occupancy exactly once');
  assert.equal(h.ing.links.get(REAL)?.route?.kind, 'direct');
  assert.equal(c.ws?.protocol, SUBPROTOCOL);
  assert.equal(c.ws?.extensions, '', 'no permessage-deflate on the node endpoint');
  c.close();
  await h.close();
});

test('direct: an unknown node, a wrong key and a wrong nonce are all refused with the same answer', async () => {
  const h = await harness();
  const cases = [
    new DirectNodeClient(h.url, 'aa:bb:cc:dd:ee:ff', KEY),
    new DirectNodeClient(h.url, REAL, Buffer.from('not-the-key')),
    new DirectNodeClient(h.url, REAL, KEY, { macOverride: () => createHmac('sha256', KEY).update(`tmnode1|${REAL}|${'0'.repeat(64)}`).digest('hex') }),
  ];
  for (const c of cases) {
    await assert.rejects(c.connect());
    assert.equal(c.closeCode, CLOSE.authFailed);
    assert.equal(c.closeReason, 'authentication failed');
  }
  assert.equal(h.ing.links.size, 0);
  await h.close();
});

test('direct: a replayed auth (captured nonce + mac) does not open a second session', async () => {
  const h = await harness();
  let captured: { nonce: string; mac: string } | null = null;
  const first = new DirectNodeClient(h.url, REAL, KEY, {
    macOverride: (nonce) => {
      const mac = createHmac('sha256', KEY).update(`tmnode1|${REAL}|${nonce}`).digest('hex');
      captured = { nonce, mac };
      return mac;
    },
  });
  await first.connect();
  const cap = captured as { nonce: string; mac: string } | null;
  assert.ok(cap);
  const ws = new WebSocket(h.url, SUBPROTOCOL);
  const code = await new Promise<number>((resolve) => {
    ws.on('message', () => ws.send(JSON.stringify({ type: 'auth', v: 1, uid: REAL, nonce: cap.nonce, mac: cap.mac })));
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(code, CLOSE.authFailed);
  first.close();
  await h.close();
});

test('direct: the wrong subprotocol or path is refused before any WebSocket opens', async () => {
  const h = await harness();
  const status = (url: string, protocol: string) => new Promise<number>((resolve) => {
    const ws = new WebSocket(url, protocol);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => resolve(101));
    ws.on('error', () => undefined);
  });
  assert.equal(await status(h.url, 'tmnode.v2'), 400);
  assert.equal(await status(`ws://127.0.0.1:${h.port}/tmgw`, SUBPROTOCOL), 404);
  assert.equal(await status(`${h.url}?x=1`, SUBPROTOCOL), 404);
  await h.close();
});

test('direct: a silent client loses its handshake after the timeout, and packets before auth close the socket', async () => {
  const h = await harness({}, { handshakeMs: 150 });
  const silent = await new Promise<number>((resolve) => {
    const ws = new WebSocket(h.url, SUBPROTOCOL);
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(silent, CLOSE.handshakeTimeout);
  const early = await new Promise<number>((resolve) => {
    const ws = new WebSocket(h.url, SUBPROTOCOL);
    ws.on('message', () => ws.send(report(identity(REAL), [], 1)));
    ws.on('close', (c) => resolve(c));
  });
  assert.equal(early, CLOSE.badMessage);
  assert.equal(h.reports.length, 0);
  await h.close();
});

test('direct: a node still on TM_KEY_PREVIOUS gets commands signed with that key, which it can verify', async () => {
  const h = await harness();
  const c = await connected(h, REAL, PREVIOUS);
  c.send(report({ uid: REAL, boot: 3, seq: 0, key: PREVIOUS }, [], 1));
  await c.until(() => c.acks.length === 1);
  await h.ing.sendCommand(REAL, CMD_IDENTIFY, 0, 5);
  await c.until(() => c.downlinks.length === 1);
  const cmd = c.downlinks[0];
  assert.ok(cmd);
  assert.equal(cmd[3], TYPE_COMMAND);
  const body = cmd.subarray(0, cmd.length - 8);
  assert.deepEqual(cmd.subarray(cmd.length - 8), tag(PREVIOUS, body), 'signed with the key the session proved');
  c.close();
  await h.close();
});

test('direct: packets must verify with the session key and carry the session uid', async () => {
  const h = await harness();
  const c = await connected(h, REAL, KEY);
  c.send(report({ uid: REAL, boot: 1, seq: 0, key: PREVIOUS }, [], 1));   // valid on the edge, not on this session
  c.send(report(identity(OTHER), [], 1));                                  // another node's packet
  c.send(report({ uid: REAL, boot: 1, seq: 1, key: null }, [], 2));        // unsigned: ALLOW_UNSIGNED never applies here
  c.send(report(identity(REAL), [], 3));
  await c.until(() => c.acks.length === 1);
  assert.equal(h.reports.length, 1);
  assert.equal(h.ing.rejectReasons.get('bad signature'), 1);
  assert.equal(h.ing.rejectReasons.get('uid does not match the session'), 1);
  assert.equal(h.ing.rejectReasons.get('unsigned'), 1);
  c.close();
  await h.close();
});

// --- replay and routing ---------------------------------------------------------------

test('direct: one replay rule for every transport: a report already heard over UDP gets no ACK and no second count', async () => {
  const h = await harness();
  const c = await connected(h);
  const id = identity(REAL, 4);
  const a = report(id, [], 1);
  const b = report(id, [], 2);
  assert.equal(h.ing.handle(a, '10.0.0.9').ok, true);
  c.send(a);                 // same bytes over the socket
  c.send(b);
  await c.until(() => c.acks.length === 1);
  assert.equal(c.acks[0]?.seq, 1, 'only the new packet is acknowledged');
  assert.equal(h.reports.length, 2);
  assert.equal(h.ing.handle(b, '10.0.0.9').ok, false, 'and the WSS copy is a replay for UDP');
  c.close();
  await h.close();
});

test('direct: a rejected packet cannot move the route, and a closed session is never retried over UDP', async () => {
  const h = await harness();
  const c = await connected(h);
  const id = identity(REAL, 2);
  c.send(report(id, [], 1));
  await c.until(() => c.acks.length === 1);
  const forged = report({ uid: REAL, boot: 2, seq: 99, key: Buffer.from('forged') }, [], 2);
  assert.equal(h.ing.handle(forged, '10.6.6.6').ok, false);
  assert.equal(h.ing.links.get(REAL)?.route?.kind, 'direct');
  c.close();
  await eventually(() => h.ing.links.get(REAL)?.route === null);
  await assert.rejects(h.ing.sendCommand(REAL, CMD_IDENTIFY), /direct session has closed/);
  await h.close();
});

test('direct: a reconnect takes over only with its first accepted packet, and the old session\'s late close cannot remove it', async () => {
  const h = await harness();
  const a = await connected(h);
  const id = identity(REAL, 5);
  a.send(report(id, [], 1));
  await a.until(() => a.acks.length === 1);

  const b = await connected(h);
  await h.ing.sendCommand(REAL, CMD_IDENTIFY);
  await a.until(() => a.downlinks.length === 1);
  assert.equal(b.downlinks.length, 0, 'authenticated but not yet proven: commands still go to the old session');

  b.send(report(id, [], 2));   // same boot: the sequence simply continues
  await b.until(() => b.acks.length === 1);
  await closed(a);
  assert.equal(a.closeCode, CLOSE.replaced);
  const route = h.ing.links.get(REAL)?.route;
  assert.equal(route?.kind === 'direct' ? route.session.sessionId : null, b.session, 'the late close of A left B in place');
  await h.ing.sendCommand(REAL, CMD_IDENTIFY);
  await b.until(() => b.downlinks.length === 1);
  b.close();
  await h.close();
});

// --- freshness --------------------------------------------------------------------

test('direct: a backlog delivered late is refused before it reaches occupancy, and gets no ACK', async () => {
  const h = await harness();
  h.clock.mono = 1_000_000;
  const c = await connected(h);
  const id = identity(REAL, 8);
  // Frames carry uptime = frame * 1000. Delivered on time for 5 s...
  for (let f = 1; f <= 5; f++) {
    h.clock.mono = 1_000_000 + f * 1000;
    c.send(report(id, [], f));
    await c.until(() => c.acks.length === f);
  }
  // ...then the socket stalls for 30 s and the frames queued meanwhile arrive at once.
  h.clock.mono = 1_000_000 + 36_000;
  for (let f = 6; f <= 8; f++) c.send(report(id, [], f));
  // A fresh frame from now is fine.
  c.send(report(id, [], 36));
  await c.until(() => c.acks.length === 6);
  assert.deepEqual(h.reports.map((r) => r.frame), [1, 2, 3, 4, 5, 36]);
  assert.ok([...h.ing.rejectReasons.keys()].some((k) => k.startsWith('delayed')));
  c.close();
  await h.close();
});

test('direct: a node clock running 100 ppm slow for a day is followed, not rejected', async () => {
  const h = await harness();
  h.clock.mono = 0;
  const c = await connected(h);
  const id = identity(REAL, 11);
  // One report a minute for 24 h, the node's uptime losing 100 us per second.
  for (let m = 0; m <= 24 * 60; m++) {
    h.clock.mono = m * 60_000;
    const uptime = Math.round(m * 60_000 * (1 - 100e-6));
    c.send(reportAt(id, uptime, m));
    await c.until(() => c.acks.length === m + 1);
  }
  assert.equal(h.ing.rejectReasons.size, 0);
  c.close();
  await h.close();
});

function reportAt(id: ReturnType<typeof identity>, uptime: number, frame: number): Buffer {
  const buf = report(id, [], frame);
  buf.writeUInt32LE(uptime >>> 0, 16);
  return resign(buf, KEY);
}

function resign(buf: Buffer, key: Buffer): Buffer {
  const n = buf.length - 8;
  tag(key, buf.subarray(0, n)).copy(buf, n);
  return buf;
}

test('direct: a STATUS stream alone never keeps a table live', async () => {
  const reg = makerspace();
  const eng = new OccupancyEngine(reg, 'test');
  const h = await harness();
  h.ing.on('report', (p, _a, at) => eng.ingest(p, at));
  const c = await connected(h);
  const id = identity(REAL, 12);
  for (let i = 0; i < 5; i++) {
    c.send(buildStatus(id, i * 1000, {
      fw: 'tmsense-1.4', ip: '0.0.0.0', rssi: -50, channel: 1, freeHeap: 1, minHeap: 1, stackFree: 1, wifiDrops: 0,
      sensorErrors: 0, frames: 0, fps: 1, vdd: 3.3, ta: 30, lastCmd: 0, flags: 1, params: {},
    }));
  }
  await c.until(() => c.acks.length === 5);
  const m3 = eng.snapshot(Date.now()).floors[0]?.tables.find((t) => t.id === 'M3');
  assert.equal(m3?.status, 'unknown');
  assert.equal(m3?.occupied, null);
  c.close();
  await h.close();
});

test('direct: the same REPORTs give the same occupancy whether they came over UDP or WSS', async () => {
  const reg = makerspace();
  const pose = reg.nodes.get(REAL)?.pose;
  assert.ok(pose);
  const seat = [...reg.seatIndex.values()].find((s) => s.table.id === 'M3')?.seat;
  assert.ok(seat);
  const frames = (id: ReturnType<typeof identity>) => Array.from({ length: 12 }, (_, f) => report(id, [personAt(pose, seat.x, seat.y)], f));
  const t0 = Date.now();

  const viaUdp = new OccupancyEngine(reg, 'udp');
  const ingU = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY });
  ingU.on('report', (p) => viaUdp.ingest(p, t0 + p.frame * 1000));
  for (const b of frames(identity(REAL, 20))) ingU.handle(b, '10.0.0.9');

  const viaWss = new OccupancyEngine(reg, 'wss');
  const h = await harness();
  h.ing.on('report', (p) => viaWss.ingest(p, t0 + p.frame * 1000));
  const c = await connected(h);
  for (const b of frames(identity(REAL, 20))) c.send(b);
  await c.until(() => c.acks.length === 12);

  const m3 = (e: OccupancyEngine) => e.snapshot(t0 + 11_500).floors[0]?.tables.find((t) => t.id === 'M3');
  assert.deepEqual(m3(viaWss), m3(viaUdp));
  assert.equal(m3(viaWss)?.occupied, 1);
  c.close();
  await h.close();
});

// --- bounds -----------------------------------------------------------------------

test('direct: an oversized message closes the session, and a flood is dropped rather than queued', async () => {
  const h = await harness({ messagesPerSec: 5 });
  const c = await connected(h);
  const id = identity(REAL, 13);
  for (let f = 0; f < 40; f++) c.send(report(id, [], f));
  await c.until(() => c.acks.length >= 10);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(c.acks.length < 40, `${c.acks.length} of 40 acknowledged`);
  assert.ok((h.server.stats().rejects['rate limited'] ?? 0) > 0);
  c.send(Buffer.alloc(900));
  await closed(c);
  assert.equal(c.closeCode, 1009);
  await h.close();
});

test('direct: a RAW frame at its full 806 bytes fits', async () => {
  const h = await harness();
  const c = await connected(h);
  const id = identity(REAL, 14);
  const raw = buildRaw(id, 1000, 1, new Array(768).fill(0).map((_, i) => 20 + (i % 32) * 0.2));
  assert.equal(raw.length, 806);
  const raws: number[] = [];
  h.ing.on('raw', (p) => raws.push(p.frame));
  c.send(raw);
  c.send(report(id, [], 1));
  await c.until(() => c.acks.length === 1);
  assert.deepEqual(raws, [1]);
  c.close();
  await h.close();
});

// --- OTA ---------------------------------------------------------------------------

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('direct OTA: the grant precedes the signed request with the same sequence, and only it opens the download', async () => {
  const h = await harness();
  const c = await connected(h);
  c.send(report(identity(REAL, 15), [], 1));
  await c.until(() => c.acks.length === 1);
  h.approved.add(`${REAL}|${BUILD}`);
  const sha = 'ab'.repeat(32);
  await h.ing.sendOta(REAL, { port: 443, size: IMAGE.length, sha256: sha, path: `/fw/${BUILD}.bin` });
  await c.until(() => c.downlinks.length === 1 && c.grants.length === 1);
  const grant = c.grants[0];
  const ota = c.downlinks[0];
  assert.ok(grant && ota);
  assert.equal(ota[3], TYPE_OTA);
  assert.equal(ota.readUInt32LE(22), grant.seq, 'grant and signed request carry one sequence');
  assert.equal(grant.build, BUILD);

  const ok = await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${grant.token}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, IMAGE);
  assert.match(String(ok.headers['cache-control']), /no-store/);

  assert.equal((await get(h.port, `/fw/${BUILD}.bin`)).status, 401, 'no token');
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${'0'.repeat(64)}` })).status, 401, 'wrong token');
  assert.equal((await get(h.port, `/fw/fedcba9876543210.bin`, { authorization: `Bearer ${grant.token}` })).status, 401, 'another build');
  assert.equal((await get(h.port, `/fw/${BUILD}.bin?token=${grant.token}`)).status, 404, 'never in a URL');
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${grant.token}` }, 'POST')).status, 405);

  // A retry is allowed until the rollout stops wanting it; then the same token is dead.
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${grant.token}` })).status, 200);
  h.approved.clear();
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${grant.token}` })).status, 403);
  c.close();
  await h.close();
});

test('direct OTA: a grant survives the socket closing, until it expires', async () => {
  const h = await harness({ grantMs: 60_000 });
  h.clock.mono = 0;
  const c = await connected(h);
  c.send(reportAt(identity(REAL, 16), 0, 1));
  await c.until(() => c.acks.length === 1);
  h.approved.add(`${REAL}|${BUILD}`);
  await h.ing.sendOta(REAL, { port: 443, size: IMAGE.length, sha256: 'cd'.repeat(32), path: `/fw/${BUILD}.bin` });
  await c.until(() => c.grants.length === 1);
  const token = c.grants[0]?.token ?? '';
  c.close();
  await closed(c);
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${token}` })).status, 200);
  h.clock.mono = 61_000;
  assert.equal((await get(h.port, `/fw/${BUILD}.bin`, { authorization: `Bearer ${token}` })).status, 401);
  await h.close();
});

test('direct OTA: a direct node is only ever sent 443 and a /fw/<build>.bin path', async () => {
  const h = await harness();
  const c = await connected(h);
  c.send(report(identity(REAL, 17), [], 1));
  await c.until(() => c.acks.length === 1);
  h.approved.add(`${REAL}|${BUILD}`);
  await assert.rejects(h.ing.sendOta(REAL, { port: 8090, size: 1, sha256: 'ab'.repeat(32), path: `/fw/${BUILD}.bin` }), /443/);
  await assert.rejects(h.ing.sendOta(REAL, { port: 443, size: 1, sha256: 'ab'.repeat(32), path: '/console/fw.bin' }), /443/);
  h.approved.clear();
  await assert.rejects(h.ing.sendOta(REAL, { port: 443, size: 1, sha256: 'ab'.repeat(32), path: `/fw/${BUILD}.bin` }), /grant/);
  assert.equal(c.downlinks.length, 0);
  c.close();
  await h.close();
});

test('direct: the node listener serves health and firmware, and nothing a person could read', async () => {
  const h = await harness();
  assert.equal((await get(h.port, '/healthz')).status, 200);
  for (const path of ['/', '/api/state', '/api/nodes/30:ed:a0:cb:f5:f8/raw', '/index.html', '/fw/', '/tmgw']) {
    assert.equal((await get(h.port, path)).status, 404, path);
  }
  await h.close();
});

// --- configuration ------------------------------------------------------------------

test('direct: enabling the node listener without a key refuses to start', () => {
  assert.throws(() => loadEdgeConfig({ ALLOW_UNSIGNED: '1', NODE_PORT: '5211', WEB_PUSH_URLS: '' }), EnvError);
  const cfg = loadEdgeConfig({ TM_KEY: 'k', NODE_PORT: '5211', WEB_PUSH_URLS: '' });
  assert.equal(cfg.nodeHost, '127.0.0.1', 'loopback unless told otherwise: the tunnel is the way in');
  assert.equal(loadEdgeConfig({ TM_KEY: 'k', WEB_PUSH_URLS: '' }).nodePort, 0, 'off by default');
  assert.throws(() => loadEdgeConfig({ TM_KEY: 'k', NODE_PORT: '5211', NODE_MSGS_PER_SEC: '0', WEB_PUSH_URLS: '' }), EnvError);
  assert.throws(() => loadEdgeConfig({ TM_KEY: 'k', NODE_TLS_CERT: 'x', WEB_PUSH_URLS: '' }), EnvError);
});

test('direct: a listener that cannot bind is an error, not a quiet half-start', async () => {
  const h = await harness();
  const clash = new NodeServer({
    host: '127.0.0.1', port: h.port, limits: DEFAULT_NODE_LIMITS, keys: [KEY], isRegistered: () => true,
    ingest: (d, r) => h.ing.handle(d, r), dropRoute: () => undefined, image: () => null, otaApproved: () => false,
  });
  await assert.rejects(clash.listen(), /EADDRINUSE/);
  await h.close();
});

