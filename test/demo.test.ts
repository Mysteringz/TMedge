/**
 * Claims about console-only floors and the RGB verification rig: none of it
 * can reach students, and the RGB path only takes signed frames from a rig.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EdgeConfig } from '../src/edge/config.js';
import { startConsole } from '../src/edge/console.js';
import { Ingest } from '../src/edge/ingest.js';
import { OccupancyEngine } from '../src/edge/occupancy.js';
import { parsePacket, type Report } from '../src/edge/protocol.js';
import { floorToPixel, pixelToFloor } from '../src/shared/geometry.js';
import { buildRegistry, ConfigError } from '../src/edge/registry.js';
import { EdgeRuntime } from '../src/edge/runtime.js';
import { identity, KEY, nodesJson, report, siteJson } from './fixtures.js';

const RIG = '2c:cf:67:0b:c0:94';

function runtime() {
  const cfg: EdgeConfig = {
    edgeId: 'test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1',
    sitePath: '', nodesPath: '', dataDir: mkdtempSync(join(tmpdir(), 'tmedge-')), recordRaw: false,
    consolePort: 0, consoleHost: '127.0.0.1', adminPassword: 'admin-pass', pushUrls: [], pushToken: '', publishMs: 1000,
    gatewayPort: 0, gatewayToken: null,
  };
  return new EdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
}

test('demo: a console-only floor is never in what the web tier receives', () => {
  const rt = runtime();
  const full = rt.engine.snapshot(Date.now());
  assert.ok(full.floors.some((f) => f.id === 'iw-intern-demo'), 'the console still sees it');
  const pub = rt.publicSnapshot(full);
  assert.deepEqual(pub.floors.map((f) => f.id), ['iw-maker-a']);
});

test('demo: an RGB node on a student-visible floor is refused at startup', () => {
  const n = nodesJson() as any;
  n.nodes.find((x: any) => x.uid === RIG).floor = 'iw-maker-a';
  n.nodes.find((x: any) => x.uid === RIG).owns = [];
  assert.throws(() => buildRegistry(siteJson(), n), (e: unknown) => e instanceof ConfigError && /RGB node is only allowed/.test(e.message));
});

test('demo: explicit seats must match capacity, and close seats are neighbours', () => {
  const reg = buildRegistry(siteJson(), nodesJson());
  const d1 = reg.tables.get('D1')!;
  assert.deepEqual(d1.seats.map((s) => s.id), ['D1-A', 'D1-B']);
  assert.deepEqual(d1.seats[0]?.neighbors, ['D1-B']);
  const s = siteJson() as any;
  s.floors[1].tables[0].capacity = 3;
  assert.throws(() => buildRegistry(s, nodesJson()), /exactly 3 seats/);
});

test('demo: a node heard through a local proxy is not sent commands that could never arrive', async () => {
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY });
  ing.handle(report(identity(RIG), [], 1), '127.0.0.1');
  await assert.rejects(ing.sendCommand(RIG, 2), /local proxy/);
});

test('demo: RGB frames need a valid signature, a fresh timestamp, and an RGB-enabled node', async () => {
  const rt = runtime();
  const server = startConsole(rt);
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  const sign = (uid: string, ts: number, key = KEY, body = jpeg) =>
    createHmac('sha256', key).update(`${uid}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  const post = (uid: string, ts: number, sig: string, body = jpeg) => fetch(`${base}/api/demo/rgb/${uid}`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-tm-ts': String(ts), 'x-tm-sig': sig }, body,
  });
  try {
    const t = Date.now();
    assert.equal((await post(RIG, t, sign(RIG, t))).status, 204);
    assert.equal(rt.rgb.get(RIG)?.jpeg.length, jpeg.length);
    assert.equal((await post(RIG, t, sign(RIG, t))).status, 401, 'replayed timestamp');
    assert.equal((await post(RIG, t + 1, sign(RIG, t + 1, Buffer.from('wrong')))).status, 401, 'wrong key');
    assert.equal((await post(RIG, t - 60_000, sign(RIG, t - 60_000))).status, 401, 'stale');
    const other = '02:00:00:00:00:01';
    assert.equal((await post(other, t + 2, sign(other, t + 2))).status, 403, 'not an RGB node');
    // Reading the frame back needs the admin password.
    assert.equal((await fetch(`${base}/api/nodes/${RIG}/rgb.jpg`)).status, 401);
    const auth = { authorization: `Basic ${Buffer.from('x:admin-pass').toString('base64')}` };
    assert.equal((await fetch(`${base}/api/nodes/${RIG}/rgb.jpg`, { headers: auth })).status, 200);
  } finally {
    server.close();
    await rt.recorder.close();
  }
});

test('demo: someone 75 cm from a seat of a compact desk does not take it (per-table seat radius)', () => {
  const reg = buildRegistry(siteJson(), nodesJson());
  const eng = new OccupancyEngine(reg, 'test');
  const pose = reg.nodes.get(RIG)!.pose;
  const id = identity(RIG);
  // Found on the rig: a person at the next piece of furniture landed 79 cm
  // from a desk seat -- inside the site-wide 80 cm -- and took it. Put someone
  // 75 cm from seat B, towards the middle of the room (away from seat A).
  const b = reg.seatIndex.get('D1-B')!.seat;
  const benchPx = floorToPixel(pose, b.x + 30, b.y - 69)!;
  const bench = { x: benchPx[0], y: benchPx[1], area: 9, contrast: 3, peak: 31, heat: 30 };
  const [bx, by] = pixelToFloor(pose, bench.x, bench.y);
  assert.ok(Math.hypot(b.x - bx, b.y - by) < 80, 'inside the old site-wide radius');
  for (let f = 0; f < 10; f++) eng.ingest(parsePacket(report(id, [bench], f), { keys: [KEY], allowUnsigned: false }) as Report, f * 1000);
  const d1 = eng.snapshot(9000).floors.find((x) => x.id === 'iw-intern-demo')!.tables[0]!;
  assert.equal(d1.occupied, 0);
  // Someone actually in chair B is still counted.
  const px = floorToPixel(pose, b.x, b.y)!;
  for (let f = 10; f < 20; f++) eng.ingest(parsePacket(report(id, [{ ...bench, x: px[0], y: px[1] }], f), { keys: [KEY], allowUnsigned: false }) as Report, f * 1000);
  assert.equal(eng.snapshot(19000).floors.find((x) => x.id === 'iw-intern-demo')!.tables[0]!.occupied, 1);
});

test('occupancy: one hunched person split into two blobs 46 cm apart takes one seat, not two', () => {
  const reg = buildRegistry(siteJson(), nodesJson());
  const eng = new OccupancyEngine(reg, 'test');
  const id = identity(RIG);
  // What the rig reported for one intern in a brown jacket: a small head blob
  // and a larger back blob, 46 cm apart -- here placed straddling the desk's
  // two seats, the way it put that one person in both of them.
  const pose = reg.nodes.get(RIG)!.pose;
  const a = reg.seatIndex.get('D1-A')!.seat;
  const b = reg.seatIndex.get('D1-B')!.seat;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const hp = floorToPixel(pose, mx - 23 * ux, my - 23 * uy)!;
  const bp = floorToPixel(pose, mx + 23 * ux, my + 23 * uy)!;
  const head = { x: hp[0], y: hp[1], area: 4, contrast: 1.25, peak: 24, heat: 4 };
  const back = { x: bp[0], y: bp[1], area: 18, contrast: 1.65, peak: 24.5, heat: 20 };
  for (let f = 0; f < 10; f++) eng.ingest(parsePacket(report(id, [head, back], f), { keys: [KEY], allowUnsigned: false }) as Report, f * 1000);
  const d1 = eng.snapshot(9000).floors.find((x) => x.id === 'iw-intern-demo')!.tables[0]!;
  assert.equal(d1.occupied, 1);
});

test('occupancy: a static warm object elsewhere in view does not make one seated person count as two', () => {
  const reg = buildRegistry(siteJson(), nodesJson());
  const eng = new OccupancyEngine(reg, 'test');
  const pose = reg.nodes.get(RIG)!.pose;
  const id = identity(RIG);
  const a = reg.seatIndex.get('D1-A')!.seat;
  const b = reg.seatIndex.get('D1-B')!.seat;
  const mid = floorToPixel(pose, (a.x + b.x) / 2, (a.y + b.y) / 2)!;
  // The warm chair by the computer desk: a small blob, every frame, far from any seat.
  const chair = { x: 17, y: 9.9, area: 8, contrast: 1.95, peak: 25.5, heat: 7.6 };
  const person = { x: mid[0], y: mid[1], area: 22, contrast: 2.15, peak: 25, heat: 25.5 };
  for (let f = 0; f < 60; f++) eng.ingest(parsePacket(report(id, [chair], f), { keys: [KEY], allowUnsigned: false }) as Report, f * 1000);
  for (let f = 60; f < 72; f++) eng.ingest(parsePacket(report(id, [chair, person], f), { keys: [KEY], allowUnsigned: false }) as Report, f * 1000);
  assert.equal(eng.snapshot(71000).floors.find((x) => x.id === 'iw-intern-demo')!.tables[0]!.occupied, 1);
});
