/**
 * Claims about the HKUMySeat portal: which table a group is sent to, and
 * what the portal does when a sensor is down.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allocate, floorIsDark, gridPosition, knownFree, label, largestTableFree, walkOrder } from '../src/shared/allocate.js';
import { spaceInfo, VENUES } from '../src/shared/venues.js';
import { asEmail, createWebApp } from '../src/web/main.js';
import type { FloorState, TableState } from '../src/shared/types.js';

/** Maker space A's real geometry: two rows of five six-seat tables. */
function floor(free: (number | null)[]): FloorState {
  const xs = [154, 374, 601, 821, 1057];
  const tables: TableState[] = free.map((f, i) => {
    const capacity = 6;
    const unknown = f === null;
    return {
      id: `M${i + 1}`,
      name: `M${i + 1}`,
      zoneId: 'makerspace',
      rect: { x: xs[i % 5] ?? 0, y: i < 5 ? 72 : 295, width: 105, height: 167 },
      capacity,
      occupied: unknown ? null : capacity - (f ?? 0),
      free: unknown ? null : f,
      status: unknown ? 'unknown' : 'ok',
      seats: [],
    };
  });
  const known = tables.filter((t) => t.free !== null);
  return {
    id: 'iw-maker-a', building: 'Innovation Wing', name: 'Maker space A', width: 1300, height: 580,
    outline: [[0, 0], [1300, 0], [1300, 580], [0, 580]], zones: [], tables,
    totals: {
      seats: tables.length * 6,
      free: known.reduce((s, t) => s + (t.free ?? 0), 0),
      occupied: known.reduce((s, t) => s + (t.occupied ?? 0), 0),
      unknownSeats: (tables.length - known.length) * 6,
      tablesFullyFree: known.filter((t) => t.free === 6).length,
    },
  };
}

test('a group is sent to the fewest tables that seat them together', () => {
  // M1 full, M2 has 4, M3 and M4 empty.
  const f = floor([0, 4, 6, 6, 2, 0, 5, 6, 3, 0]);
  const four = allocate(f, 4);
  assert.deepEqual(four?.shares.map((s) => s.name), ['M2'], 'one table with room beats spreading a group');
  assert.equal(four?.label, 'Table M2');

  // M2+M3 seats eight too, but wastes two seats where M4+M5 wastes none.
  const eight = allocate(f, 8);
  assert.deepEqual(eight?.shares.map((s) => `${s.name}:${s.take}`), ['M4:6', 'M5:2'], 'a run of neighbours, greedily filled');
  assert.equal(eight?.label, 'Tables M4–M5');
});

test('of two runs the same length, the one wasting fewer seats wins', () => {
  //        M1 M2 M3 M4 M5 | M6 M7 M8 M9 M10
  const f = floor([4, 4, 0, 3, 3, 0, 0, 0, 0, 0]);
  const six = allocate(f, 6);
  assert.deepEqual(six?.shares.map((s) => `${s.name}:${s.take}`), ['M4:3', 'M5:3'],
    'M1+M2 is just as short a walk but leaves two seats stranded');
  const three = allocate(f, 3);
  assert.deepEqual(three?.shares.map((s) => s.name), ['M4'], 'one table, exactly filled, beats a bigger one');
});

test('a group larger than the free run gets no answer, never a guess', () => {
  const f = floor([2, 0, 2, 0, 2, 0, 2, 0, 2, 0]);
  assert.equal(allocate(f, 3), null, 'nothing contiguous adds up to three');
  assert.equal(knownFree(f), 10, 'the seats are still counted as free');
  assert.equal(largestTableFree(f), 2);
});

test('a table with no working sensor is never allocated and never bridges a run', () => {
  // M2 is unknown; M1 and M3 have space either side of it.
  const f = floor([3, null, 3, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(allocate(f, 6), null, 'an unknown table cannot join two runs');
  assert.deepEqual(allocate(f, 3)?.shares.map((s) => s.name), ['M1']);
  assert.equal(knownFree(f), 6, 'its six seats are not counted as free');
  assert.equal(f.totals.unknownSeats, 6);
  assert.equal(floorIsDark(f), false);

  const dark = floor(Array(10).fill(null));
  assert.equal(floorIsDark(dark), true, 'nobody can see this floor');
  assert.equal(allocate(dark, 1), null);
  assert.equal(knownFree(dark), 0);
});

test('tables are ordered and addressed the way a person walks the room', () => {
  const f = floor([6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
  assert.deepEqual(walkOrder(f.tables).map((t) => t.name), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10'],
    'front row left to right, then the row behind');
  assert.deepEqual(gridPosition(f.tables, 'M1'), { row: 0, column: 0, rows: 2, columns: 5 });
  assert.deepEqual(gridPosition(f.tables, 'M10'), { row: 1, column: 4, rows: 2, columns: 5 });
  assert.equal(label(['M3']), 'Table M3');
  assert.equal(label(['M3', 'M4']), 'Tables M3–M4');
});

test('the pilot venue names the floors the edge actually publishes', () => {
  const twf = VENUES.find((v) => v.id === 'twf');
  assert.ok(twf?.open);
  assert.ok(twf.floorIds.includes('iw-maker-a'), 'Maker space A belongs to the Innovation Wing');
  assert.equal(spaceInfo('iw-maker-a').model?.room, 'Makerspace A floor', 'the 3D model knows which room node to frame');
  assert.equal(spaceInfo('nowhere').model, null, 'an unmapped floor still works, just without a 3D model');
  for (const v of VENUES.filter((x) => !x.open)) assert.deepEqual(v.floorIds, [], 'a venue without sensors claims no floors');
});

test('sign-in takes an HKU Portal UID or a full address', () => {
  const domains = ['hku.hk', 'connect.hku.hk'];
  assert.equal(asEmail('u3587219', domains), 'u3587219@connect.hku.hk');
  assert.equal(asEmail('U3587219', domains), 'u3587219@connect.hku.hk');
  assert.equal(asEmail(' u3587219 ', domains), 'u3587219@connect.hku.hk');
  assert.equal(asEmail('someone@connect.hku.hk', domains), 'someone@connect.hku.hk', 'an address is left alone');
  assert.equal(asEmail('u35', domains), 'u35', 'not a UID: left for the normal error path');
  assert.equal(asEmail('u312345678', domains), 'u312345678@connect.hku.hk', 'longer year groups too');
});

test('every portal screen serves the app, and none of them without signing in', async () => {
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: 'edge-token-for-tests-0123456789', sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmportal-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/', '/search', '/spaces', '/spaces/iw-maker-a']) {
      const out = await fetch(base + path, { redirect: 'manual' });
      assert.equal(out.status, 302, `${path} sends a stranger to sign in`);
      assert.equal(out.headers.get('location'), '/login');
    }
    await web.users.create('u3587219@connect.hku.hk', 'Chan Tai Man', 'a-long-enough-pin');
    const cookie = `tm_session=${web.sessions.issue('u3587219@connect.hku.hk')}`;
    for (const path of ['/', '/search', '/spaces', '/spaces/iw-maker-a']) {
      const out = await fetch(base + path, { headers: { cookie } });
      assert.equal(out.status, 200, `${path} serves the portal to a student`);
      const html = await out.text();
      assert.match(html, /HKUMySeat/);
      // A stale stylesheet is how a deploy half-lands on a student: the page
      // is never cached, and it asks for this build's assets by name.
      assert.equal(out.headers.get('cache-control'), 'no-store', `${path} is never cached`);
      assert.match(html, /\/styles\.css\?v=[0-9a-f]{10}/, `${path} asks for this build's stylesheet`);
      assert.match(html, /app\.js\?v=[0-9a-f]{10}/);
      assert.ok(!html.includes('{{v}}'), 'the stamp is filled in');
    }
  } finally {
    await new Promise<void>((r) => web.server.close(() => r()));
  }
});
