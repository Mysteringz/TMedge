/**
 * Claims about the edge. Each test names a behaviour a student or an admin
 * would notice if it broke.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floorToPixel, pixelAreaCm2, pixelToFloor } from '../src/shared/geometry.js';
import { Ingest } from '../src/edge/ingest.js';
import { OccupancyEngine, DEFAULT_OCCUPANCY } from '../src/edge/occupancy.js';
import { parsePacket, REPORT_GLOBAL_SHIFT, type Report } from '../src/edge/protocol.js';
import { buildRegistry, ConfigError } from '../src/edge/registry.js';
import type { TableState } from '../src/shared/types.js';
import { identity, KEY, makerspace, nodesJson, personAt, report, siteJson } from './fixtures.js';

const REAL = '30:ed:a0:cb:f5:f8';          // owns M3
const M2_NODE = '02:00:00:00:00:02';
const M4_NODE = '02:00:00:00:00:04';

function engine() {
  const reg = makerspace();
  return { reg, eng: new OccupancyEngine(reg, 'test') };
}

function parse(buf: Buffer): Report {
  return parsePacket(buf, { keys: [KEY], allowUnsigned: false }) as Report;
}

function table(eng: OccupancyEngine, id: string, now: number): TableState {
  const t = eng.snapshot(now).floors[0]?.tables.find((x) => x.id === id);
  assert.ok(t, `table ${id}`);
  return t;
}

/** Feed `frames` reports at 1 fps from each (uid, detections-maker) pair. */
function run(eng: OccupancyEngine, reg: ReturnType<typeof makerspace>, frames: number, t0: number,
  sources: { uid: string; people: [number, number][]; flags?: number }[]): number {
  const ids = new Map(sources.map((s) => [s.uid, identity(s.uid)]));
  let t = t0;
  for (let f = 0; f < frames; f++) {
    t = t0 + f * 1000;
    for (const s of sources) {
      const pose = reg.nodes.get(s.uid)?.pose;
      assert.ok(pose);
      const id = ids.get(s.uid);
      assert.ok(id);
      eng.ingest(parse(report(id, s.people.map(([x, y]) => personAt(pose, x, y)), f, s.flags)), t);
    }
  }
  return t;
}

const seat = (reg: ReturnType<typeof makerspace>, id: string): [number, number] => {
  const s = reg.seatIndex.get(id)?.seat;
  assert.ok(s, id);
  return [s.x, s.y];
};

// --- geometry ------------------------------------------------------------------

test('geometry: the optical axis lands directly under the node, and pixel<->floor round-trips', () => {
  const pose = { x: 500, y: 300, heightCm: 350, yawDeg: 30, mirror: true };
  const [x, y] = pixelToFloor(pose, 16, 12);
  assert.ok(Math.abs(x - 500) < 1e-9 && Math.abs(y - 300) < 1e-9);
  for (const [u, v] of [[0.5, 0.5], [31.5, 23.5], [10.25, 17.75]] as const) {
    const [fx, fy] = pixelToFloor(pose, u, v);
    const back = floorToPixel(pose, fx, fy);
    assert.ok(back && Math.abs(back[0] - u) < 1e-6 && Math.abs(back[1] - v) < 1e-6);
  }
});

test('geometry: a higher mount sees further for the same pixel', () => {
  const low = pixelToFloor({ x: 0, y: 0, heightCm: 300, yawDeg: 0, mirror: false }, 28, 12);
  const high = pixelToFloor({ x: 0, y: 0, heightCm: 500, yawDeg: 0, mirror: false }, 28, 12);
  assert.ok(high[0] > low[0] * 1.9, `${high[0]} vs ${low[0]}`);
});

// --- registry --------------------------------------------------------------------

test('registry: the makerspace config loads as 10 tables, 60 seats, 10 nodes', () => {
  const reg = makerspace();
  const maker = [...reg.tables.values()].filter((t) => t.floorId === 'iw-maker-a');
  assert.equal(maker.length, 10);
  assert.equal(maker.reduce((a, t) => a + t.seats.length, 0), 60);
  assert.equal([...reg.nodes.values()].filter((n) => n.floorId === 'iw-maker-a').length, 10);
  assert.equal(reg.tables.get('M3')?.owner, REAL);
  assert.deepEqual(reg.tables.get('M3')?.coveredBy.slice(0, 1), [REAL]);
});

test('registry: typos and ambiguity refuse to start instead of silently miscounting', () => {
  const bad = (mutate: (site: any, nodes: any) => void, msg: RegExp) => {
    const s = siteJson() as any;
    const n = nodesJson() as any;
    mutate(s, n);
    assert.throws(() => buildRegistry(s, n), (e: unknown) => e instanceof ConfigError && msg.test(e.message));
  };
  bad((s) => (s.floors[0].tables[0].capcity = 6), /unknown field "capcity"/);
  bad((s) => (s.floors[0].tables[1].id = 'M1'), /duplicate table id/);
  bad((s) => (s.floors[0].tables[0].zone = 'nope'), /no zone "nope"/);
  bad((_s, n) => n.nodes[1].owns.push('M1'), /already owned/);
  bad((_s, n) => (n.nodes[0].owns = ['M99']), /no table "M99"/);
  bad((_s, n) => (n.nodes[0].uid = n.nodes[1].uid), /duplicate uid/);
  bad((_s, n) => (n.nodes[0].pose.heightCm = 90), /heightCm/);
  bad((_s, n) => {
    n.nodes[4].owns = [];
    n.nodes[0].owns = ['M5'];            // a node above M1 cannot see M5, 8.5 m away
  }, /cannot see all of its seats/);
});

// --- ingest ------------------------------------------------------------------------

test('ingest: replays and duplicates are rejected; a reboot (boot+1, seq 0) is accepted', () => {
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY });
  const seen: number[] = [];
  const rejected: string[] = [];
  ing.on('report', (p) => seen.push(p.seq));
  ing.on('rejected', (_a, r) => rejected.push(r));
  const id = identity(REAL, 5);
  const a = report(id, [], 1);
  const b = report(id, [], 2);
  ing.handle(a, '10.0.0.9');
  ing.handle(b, '10.0.0.9');
  ing.handle(a, '10.0.0.9');                          // replay of an old packet
  ing.handle(b, '10.0.0.9');                          // duplicate
  const rebooted = identity(REAL, 6);                 // node power-cycled: seq restarts
  ing.handle(report(rebooted, [], 0), '10.0.0.77');   // ...and DHCP moved it
  const oldBoot = identity(REAL, 5);
  oldBoot.seq = 1000;
  ing.handle(report(oldBoot, [], 3), '10.0.0.9');     // captured before the reboot, replayed after
  assert.deepEqual(seen, [0, 1, 0]);
  assert.equal(rejected.length, 3);
  assert.equal(ing.links.get(REAL)?.address, '10.0.0.77');
});

test('ingest: wrong key, tampering and unsigned packets are rejected and counted by reason', () => {
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY });
  let accepted = 0;
  ing.on('report', () => accepted++);
  ing.handle(report({ uid: REAL, boot: 1, seq: 0, key: Buffer.from('other') }, [], 1), '1.1.1.1');
  const t = report(identity(REAL), [], 1);
  t[25] = (t[25] ?? 0) ^ 1;
  ing.handle(t, '1.1.1.1');
  ing.handle(report({ uid: REAL, boot: 1, seq: 0, key: null }, [], 1), '1.1.1.1');
  assert.equal(accepted, 0);
  assert.equal(ing.rejectReasons.get('bad signature'), 2);
  assert.equal(ing.rejectReasons.get('unsigned'), 1);
});

test('ingest: sequence gaps show up as loss', () => {
  const ing = new Ingest({ port: 0, host: '127.0.0.1', verify: { keys: [KEY], allowUnsigned: false }, commandKey: KEY });
  const id = identity(REAL);
  for (let f = 0; f <= 10; f++) {
    const buf = report(id, [], f);
    if (f !== 4 && f !== 9) ing.handle(buf, '1.1.1.1');   // lose 2 of 11
  }
  assert.ok(Math.abs(ing.lossRate(REAL) - 2 / 11) < 1e-9, String(ing.lossRate(REAL)));
});

// --- occupancy ---------------------------------------------------------------------

test('occupancy: one person at a seat of M3 takes exactly that seat', () => {
  const { reg, eng } = engine();
  const t = run(eng, reg, 8, 0, [{ uid: REAL, people: [seat(reg, 'M3-R2')] }]);
  const m3 = table(eng, 'M3', t);
  assert.equal(m3.status, 'ok');
  assert.equal(m3.occupied, 1);
  assert.deepEqual(m3.seats.filter((s) => s.occupied).map((s) => s.id), ['M3-R2']);
});

test('occupancy: a person seen by the owner AND a neighbour is counted once', () => {
  const { reg, eng } = engine();
  const p = seat(reg, 'M3-L1');
  // M2's node sees M3-L1 too (the views overlap at 3.5 m).
  assert.ok(floorToPixel(reg.nodes.get(M2_NODE)!.pose, p[0], p[1]));
  const t = run(eng, reg, 8, 0, [{ uid: REAL, people: [p] }, { uid: M2_NODE, people: [p] }]);
  const snap = eng.snapshot(t).floors[0]!;
  assert.equal(snap.tables.find((x) => x.id === 'M3')?.occupied, 1);
  assert.equal(snap.tables.find((x) => x.id === 'M2')?.occupied, 0);
  assert.equal(snap.totals.occupied, 1);
});

test('occupancy: when the owner goes silent a neighbour that sees the table takes over (fallback)', () => {
  const { reg, eng } = engine();
  const p = seat(reg, 'M3-R3');
  let t = run(eng, reg, 8, 0, [{ uid: REAL, people: [p] }, { uid: M4_NODE, people: [p] }]);
  assert.equal(table(eng, 'M3', t).status, 'ok');
  // Owner dies; only M4's node keeps reporting.
  t = run(eng, reg, 20, t + 1000, [{ uid: M4_NODE, people: [p] }]);
  const m3 = table(eng, 'M3', t);
  assert.equal(m3.status, 'fallback');
  assert.equal(m3.occupied, 1);
});

test('occupancy: silence is never emptiness -- a table nobody can see is unknown, and leaves the totals', () => {
  const { reg, eng } = engine();
  let t = run(eng, reg, 8, 0, [{ uid: REAL, people: [seat(reg, 'M3-L2')] }]);
  t += DEFAULT_OCCUPANCY.staleMs + 1000;
  const floor = eng.snapshot(t).floors[0]!;
  const m3 = floor.tables.find((x) => x.id === 'M3')!;
  assert.equal(m3.status, 'unknown');
  assert.equal(m3.occupied, null);
  assert.equal(m3.free, null);
  assert.ok(m3.seats.every((s) => s.occupied === null));
  assert.equal(floor.totals.free, 0);
  assert.equal(floor.totals.unknownSeats, 60);
});

test('occupancy: a node learning its background, or in a global shift, is not trusted', () => {
  const { reg, eng } = engine();
  const t = run(eng, reg, 8, 0, [{ uid: REAL, people: [seat(reg, 'M3-L2')], flags: REPORT_GLOBAL_SHIFT }]);
  assert.equal(table(eng, 'M3', t).status, 'unknown');
  const t2 = run(eng, reg, 8, t + 1000, [{ uid: REAL, people: [], flags: 0 }]);
  assert.equal(table(eng, 'M3', t2).status, 'unknown');
});

test('occupancy: a one-frame flicker does not take a seat; a brief absence does not release it', () => {
  const { reg, eng } = engine();
  const p = seat(reg, 'M3-L3');
  const id = identity(REAL);
  const pose = reg.nodes.get(REAL)!.pose;
  const feed = (f: number, present: boolean) => eng.ingest(parse(report(id, present ? [personAt(pose, ...p)] : [], f)), f * 1000);
  for (let f = 0; f < 10; f++) feed(f, f === 6);               // a single-frame blob
  assert.equal(table(eng, 'M3', 9000).occupied, 0);
  for (let f = 10; f < 20; f++) feed(f, true);                 // sits down
  assert.equal(table(eng, 'M3', 19000).occupied, 1);
  for (let f = 20; f < 30; f++) feed(f, false);                // leans out of view for 10 s
  assert.equal(table(eng, 'M3', 29000).occupied, 1);
  for (let f = 30; f < 55; f++) feed(f, false);                // actually left
  assert.equal(table(eng, 'M3', 54000).occupied, 0);
});

test('occupancy: a table never reports more people than seats, but the zone counts everyone', () => {
  const { reg, eng } = engine();
  const seats = reg.tables.get('M3')!.seats.map((s) => [s.x, s.y] as [number, number]);
  const seven: [number, number][] = [...seats, [seats[0]![0], seats[0]![1] + 25]];   // a 7th squeezed in
  // Every node reports everyone it can see, so M3's people are seen several times over.
  const sources = [...reg.nodes.values()].map((n) => ({
    uid: n.uid,
    people: seven.filter(([x, y]) => floorToPixel(n.pose, x, y) !== null),
  }));
  assert.ok(sources.filter((s) => s.people.length > 0).length >= 3, 'overlap: several nodes see M3');
  const t = run(eng, reg, 8, 0, sources);
  const floor = eng.snapshot(t).floors[0]!;
  const m3 = floor.tables.find((x) => x.id === 'M3')!;
  assert.equal(m3.occupied, 6);
  assert.equal(m3.free, 0);
  assert.equal(floor.zones[0]?.people, 7);
  assert.equal(floor.totals.occupied, 6);
});

test('occupancy: a blob with twice a typical person\'s heat takes two adjacent seats', () => {
  const { reg, eng } = engine();
  const pose = reg.nodes.get(REAL)!.pose;
  const id = identity(REAL);
  // Teach the node what one person looks like here.
  for (let f = 0; f < 40; f++) eng.ingest(parse(report(id, [personAt(pose, ...seat(reg, 'M3-R1'), 60)], f)), f * 1000);
  // Two neighbours merged into one blob between R1 and R2.
  const [x1, y1] = seat(reg, 'M3-R1');
  const [x2, y2] = seat(reg, 'M3-R2');
  for (let f = 40; f < 50; f++) eng.ingest(parse(report(id, [personAt(pose, (x1 + x2) / 2, (y1 + y2) / 2, 125)], f)), f * 1000);
  const m3 = table(eng, 'M3', 49000);
  assert.equal(m3.occupied, 2);
});

test('occupancy: one person under the node is one person, even though they cover more pixels than people at the edge of view', () => {
  const { reg, eng } = engine();
  const pose = reg.nodes.get(REAL)!.pose;
  const id = identity(REAL);
  // Physically consistent heat: the same person covers fewer pixels where each
  // pixel sees more floor (off-axis on a 110 deg lens).
  const physical = (x: number, y: number) => {
    const d = personAt(pose, x, y);
    return { ...d, heat: 3.0e5 / pixelAreaCm2(pose, d.x, d.y) };
  };
  // The node learns "one person" mostly from people at the edge of its view.
  const edgeSeats = ['M2-L1', 'M2-L3', 'M4-R1', 'M4-R3'].map((s) => seat(reg, s));
  for (let f = 0; f < 40; f++) eng.ingest(parse(report(id, edgeSeats.map(([x, y]) => physical(x, y)), f)), f * 1000);
  // Then one person sits at M3, nearly under the node.
  const [x, y] = seat(reg, 'M3-R2');
  for (let f = 40; f < 52; f++) eng.ingest(parse(report(id, [physical(x, y)], f)), f * 1000);
  assert.deepEqual(table(eng, 'M3', 51000).seats.filter((s) => s.occupied).map((s) => s.id), ['M3-R2']);
});
