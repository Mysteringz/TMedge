/**
 * Simulated TMnodes: `npm run simulate -- [options]`.
 *
 * Every node marked "simulated": true in config/nodes.json becomes a virtual
 * node sending real, signed protocol-v1 packets over UDP -- the same bytes a
 * TMnode sends, so the edge cannot tell the difference. Real nodes in the
 * same config keep running alongside.
 *
 * The world: students take seats in sessions (arrive, stay, leave), a few
 * people walk the aisles, and every node reports what its lens would see of
 * them -- including neighbouring tables, so the edge's overlap handling is
 * exercised. Detections carry pixel noise, misses, the occasional false
 * blob, and merge when two people are closer than the sensor can resolve.
 *
 *   --load 0.5        mean share of seats taken
 *   --speed 1         time compression of sessions (10 = a 25 min session lasts 2.5 min)
 *   --walkers 2       people walking the aisles
 *   --raw-every 1     RAW frame every N frames (0 = none)
 *   --kill uid@secs   node goes silent after secs (repeatable) -- try the owner of a table
 *   --edge host:port  default 127.0.0.1:5200
 *   --seed 1
 *   --truth file.json rewrite the true seat states every second (for accuracy checks)
 */
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { floorToPixel, pixelAreaCm2 } from '../shared/geometry.js';
import { buildOtaStatus, buildRaw, buildReport, buildStatus, REPORT_BACKGROUND_READY, STATUS_SENSOR_OK, STATUS_BACKGROUND_READY, STATUS_SIGNED, type Detection, type Identity } from '../edge/protocol.js';
import { loadRegistry, type NodeDef, type Registry } from '../edge/registry.js';

interface Args {
  load: number;
  speed: number;
  walkers: number;
  rawEvery: number;
  kills: Map<string, number>;
  host: string;
  port: number;
  seed: number;
  duration: number;
  truth: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { load: 0.5, speed: 1, walkers: 2, rawEvery: 1, kills: new Map(), host: '127.0.0.1', port: 5200, seed: 1, duration: 0, truth: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1] ?? '';
    const num = () => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} needs a number`);
      i++;
      return n;
    };
    switch (k) {
      case '--load': a.load = Math.min(0.98, Math.max(0.02, num())); break;
      case '--speed': a.speed = Math.max(0.1, num()); break;
      case '--walkers': a.walkers = Math.max(0, Math.round(num())); break;
      case '--raw-every': a.rawEvery = Math.max(0, Math.round(num())); break;
      case '--seed': a.seed = num(); break;
      case '--duration': a.duration = num(); break;
      case '--truth': a.truth = v; i++; break;
      case '--edge': {
        const [h, p] = v.split(':');
        a.host = h || a.host;
        a.port = Number(p) || a.port;
        i++;
        break;
      }
      case '--kill': {
        const [uid, secs] = v.split('@');
        if (!uid || !secs) throw new Error('--kill uid@seconds');
        a.kills.set(uid.toLowerCase(), Number(secs));
        i++;
        break;
      }
      default: throw new Error(`unknown option ${k}`);
    }
  }
  return a;
}

// Small deterministic PRNG so a run can be repeated with --seed.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

interface Person { x: number; y: number; heat: number; seat: string | null; vx?: number; vy?: number }

const SESSION_MEAN_S = 25 * 60;

class World {
  readonly seats: { id: string; x: number; y: number; occupiedUntil: number; freeUntil: number; heat: number }[] = [];
  walkers: Person[] = [];
  private readonly r: ReturnType<typeof rng>;

  constructor(reg: Registry, private readonly a: Args) {
    this.r = rng(a.seed);
    for (const t of reg.tables.values()) {
      for (const s of t.seats) {
        // Start near steady state: each seat taken with probability `load`.
        const taken = this.r.next() < a.load;
        this.seats.push({
          id: s.id, x: s.x, y: s.y,
          occupiedUntil: taken ? this.exp(SESSION_MEAN_S) : 0,
          freeUntil: taken ? 0 : this.exp(this.vacantMean()),
          heat: 1 + 0.15 * this.r.gauss(),
        });
      }
    }
    const floor = reg.floors[0];
    for (let i = 0; i < a.walkers && floor; i++) {
      // Aisles: between the two rows of tables and along the front.
      const y = i % 2 === 0 ? 268 : 505;
      this.walkers.push({ x: 80 + this.r.next() * 1100, y, heat: 1, seat: null, vx: (this.r.next() < 0.5 ? -1 : 1) * 120, vy: 0 });
    }
  }

  private vacantMean(): number {
    return (SESSION_MEAN_S * (1 - this.a.load)) / this.a.load;
  }

  private exp(meanS: number): number {
    return (-Math.log(1 - this.r.next()) * meanS) / this.a.speed;
  }

  step(t: number, dt: number): Person[] {
    const people: Person[] = [];
    for (const s of this.seats) {
      if (s.occupiedUntil > t) {
        // Seated people shift a little: leaning, turning, reaching.
        people.push({ x: s.x + 6 * this.r.gauss(), y: s.y + 6 * this.r.gauss(), heat: s.heat, seat: s.id });
      } else if (s.occupiedUntil > 0) {
        s.occupiedUntil = 0;
        s.freeUntil = t + this.exp(this.vacantMean());
      } else if (s.freeUntil <= t) {
        s.occupiedUntil = t + this.exp(SESSION_MEAN_S);
        s.heat = 1 + 0.15 * this.r.gauss();
      }
    }
    for (const w of this.walkers) {
      w.x += (w.vx ?? 0) * dt;
      if (w.x < 70 || w.x > 1210) w.vx = -(w.vx ?? 0);
      people.push({ ...w });
    }
    return people;
  }
}

/** Heat of one person as this node sees them: more pixels the closer they are. */
function personHeat(node: NodeDef, x: number, y: number, px: [number, number]): { heat: number; area: number } {
  const pixelCm2 = pixelAreaCm2(node.pose, px[0], px[1]);
  const personCm2 = Math.PI * 26 * 26;                 // head and shoulders from above
  const pixels = personCm2 / pixelCm2;
  // ~4 C over the blob, about what the detector scenarios show.
  return { heat: 4.2 * pixels * 1.9, area: Math.max(1, Math.round(pixels * 1.9)) };
}

function observe(node: NodeDef, people: Person[], r: ReturnType<typeof rng>): Detection[] {
  const blobs: (Detection & { n: number })[] = [];
  for (const p of people) {
    const px = floorToPixel(node.pose, p.x, p.y);
    if (!px || px[0] < 0.3 || px[0] > 31.7 || px[1] < 0.3 || px[1] > 23.7) continue;
    if (r.next() < 0.03) continue;                     // missed this frame
    const { heat, area } = personHeat(node, p.x, p.y, px);
    const d = { x: px[0] + 0.12 * r.gauss(), y: px[1] + 0.12 * r.gauss(), area, contrast: 4.5 + 0.8 * r.gauss(), peak: 30 + r.gauss(), heat: heat * p.heat * (1 + 0.1 * r.gauss()), n: 1 };
    // Closer than ~1.3 px: the sensor sees one blob.
    const near = blobs.find((b) => Math.hypot(b.x - d.x, b.y - d.y) < 1.3);
    if (near) {
      const w = near.heat + d.heat;
      near.x = (near.x * near.heat + d.x * d.heat) / w;
      near.y = (near.y * near.heat + d.y * d.heat) / w;
      near.heat = w;
      near.area += d.area;
      near.n += 1;
    } else {
      blobs.push(d);
    }
  }
  if (r.next() < 0.004) {                              // a stray warm blob: a hot drink, a phone
    blobs.push({ x: r.next() * 32, y: r.next() * 24, area: 1, contrast: 1.4, peak: 26, heat: 2, n: 0 });
  }
  return blobs.map(({ n: _n, ...d }) => d);
}

function renderRaw(dets: Detection[], r: ReturnType<typeof rng>, t: number): Float32Array {
  const img = new Float32Array(768);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      // Floor with a window-side gradient, furniture texture, slow drift, noise.
      img[y * 32 + x] = 22.8 + 0.04 * x + 0.3 * Math.sin(x * 0.7) * Math.cos(y * 0.5) + 0.2 * Math.sin(t / 600) + 0.15 * r.gauss();
    }
  }
  for (const d of dets) {
    const sigma = Math.max(0.55, Math.sqrt(d.area) / 2.6);
    for (let y = Math.max(0, Math.floor(d.y - 4)); y < Math.min(24, d.y + 4); y++) {
      for (let x = Math.max(0, Math.floor(d.x - 4)); x < Math.min(32, d.x + 4); x++) {
        const g = Math.exp(-(((x + 0.5 - d.x) ** 2 + (y + 0.5 - d.y) ** 2) / (2 * sigma * sigma)));
        img[y * 32 + x] = (img[y * 32 + x] ?? 0) + d.contrast * g;
      }
    }
  }
  return img;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const key = process.env.TM_KEY ? Buffer.from(process.env.TM_KEY) : null;
  if (!key) console.warn('[sim] TM_KEY not set: sending UNSIGNED packets (the edge rejects them unless ALLOW_UNSIGNED=1)');
  const reg = loadRegistry(process.env.SITE_CONFIG || 'config/site.json', process.env.NODES_CONFIG || 'config/nodes.json');
  const nodes = [...reg.nodes.values()].filter((n) => n.simulated);
  if (nodes.length === 0) throw new Error('no nodes with "simulated": true in nodes.json');

  const world = new World(reg, a);
  const r = rng(a.seed + 7);
  const sock = dgram.createSocket('udp4');
  // Boot counter from the clock: each simulator run is a "reboot", which the
  // edge accepts because (boot, seq) went up.
  const boot = Math.floor(Date.now() / 1000) & 0xffff;
  const ids = new Map<string, Identity>(nodes.map((n) => [n.uid, { uid: n.uid, boot, seq: 0, key }]));
  const start = Date.now();
  let frame = 0;
  // Resolve once: given a hostname, dgram does an async lookup per send, and
  // datagrams can then leave out of order -- which the edge rightly rejects as
  // replays (seen with --edge edge:5200 under Docker).
  const addr = (await lookup(a.host, { family: 4 })).address;
  const send = (b: Buffer) => sock.send(b, a.port, addr);

  // Virtual nodes take firmware updates too: they fetch the image the edge
  // points them at, check it against the hash in the request, and report the
  // same progress a real node would. It exercises the whole path -- the
  // gateway's or the edge's image server included -- without hardware.
  const down = dgram.createSocket('udp4');
  down.bind(5201, '0.0.0.0', () => console.log('[sim] listening for commands and updates on udp/5201'));
  down.on('error', (err) => console.warn(`[sim] downlink: ${err.message} (updates will not be simulated)`));
  down.on('message', (msg, from) => {
    if (msg.length < 22 || msg[3] !== 0x11) return;   // only OTA requests
    const uid = [...msg.subarray(4, 10)].map((x) => x.toString(16).padStart(2, '0')).join(':');
    const id = ids.get(uid);
    if (!id) return;
    const p = msg.subarray(22);
    const port = p.readUInt16LE(4);
    const size = p.readUInt32LE(6);
    const sha = p.subarray(10, 42).toString('hex');
    // The path is a fixed 48-byte NUL-padded field; anything after it is the
    // signature, not the path.
    const path = p.subarray(42, 90).toString('latin1').replace(/\0[\s\S]*$/, '');
    const image = sha.slice(0, 8);
    const say = (state: 'downloading' | 'verifying' | 'applying' | 'rebooting' | 'confirmed' | 'failed',
                 percent: number, error?: 'http' | 'size' | 'sha') => {
      send(buildOtaStatus(id, Date.now() - start, { state, percent, image, ...(error ? { error } : {}) }));
    };
    void (async () => {
      say('downloading', 0);
      try {
        const url = `http://${from.address}:${port}${path}`;
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`[sim] ${uid}: ${url} -> ${res.status}`);
          return say('failed', 0, 'http');
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        say('downloading', 100);
        if (bytes.length !== size) return say('failed', 100, 'size');
        say('verifying', 100);
        if (createHash('sha256').update(bytes).digest('hex') !== sha) return say('failed', 100, 'sha');
        say('applying', 100);
        say('rebooting', 100);
        // A real node reboots and proves itself before confirming; a virtual
        // one waits the same sort of moment.
        setTimeout(() => say('confirmed', 100), 3000);
      } catch (err) {
        console.warn(`[sim] ${uid}: update failed: ${(err as Error).message}`);
        say('failed', 0, 'http');
      }
    })();
  });

  console.log(`[sim] ${nodes.length} virtual nodes -> ${a.host}:${a.port}, load ${a.load}, speed x${a.speed}, ${a.walkers} walkers` +
    (a.kills.size ? `, killing ${[...a.kills].map(([u, s]) => `${u}@${s}s`).join(' ')}` : ''));

  const timer = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    if (a.duration && elapsed > a.duration) {
      clearInterval(timer);
      sock.close();
      return;
    }
    const people = world.step(elapsed, 1);
    for (const n of nodes) {
      const dead = a.kills.get(n.uid);
      if (dead !== undefined && elapsed > dead) continue;
      const id = ids.get(n.uid);
      if (!id) continue;
      const uptime = Math.round(elapsed * 1000);
      const dets = observe(n, people, r);
      const learning = frame < 20;
      send(buildReport(id, uptime, {
        frame, ta: 33.5, sceneMin: 22.5, sceneMax: 27 + (dets.length ? 4 : 0), bgMean: 23.2,
        flags: learning ? 0 : REPORT_BACKGROUND_READY, detections: learning ? [] : dets,
      }));
      if (a.rawEvery > 0 && frame % a.rawEvery === 0) send(buildRaw(id, uptime, frame, renderRaw(learning ? [] : dets, r, elapsed)));
      if (frame % 10 === 0) {
        send(buildStatus(id, uptime, {
          fw: 'sim-1.0.0', ip: '127.0.0.1', rssi: -50 - Math.round(10 * r.next()), channel: 6,
          freeHeap: 238000, minHeap: 230000, stackFree: 5700, wifiDrops: 0, sensorErrors: 0, frames: frame,
          fps: 1, vdd: 3.3, ta: 33.5, lastCmd: 0,
          flags: STATUS_SENSOR_OK | (learning ? 0 : STATUS_BACKGROUND_READY) | (key ? STATUS_SIGNED : 0),
          params: { min_contrast: 60, min_peak: 120, noise_k: 40, min_area: 1, max_area: 60, bg_tau: 90, bg_frames: 20, raw_every: a.rawEvery, refresh: 2, split_sep: 19 },
        }));
      }
    }
    if (a.truth) {
      const seats = Object.fromEntries(world.seats.map((s) => [s.id, s.occupiedUntil > elapsed]));
      writeFileSync(a.truth, JSON.stringify({ t: Date.now(), seats, killed: [...a.kills].filter(([, s]) => elapsed > s).map(([u]) => u) }));
    }
    if (frame % 30 === 0) {
      const seated = people.filter((p) => p.seat).length;
      console.log(`[sim] t=${Math.round(elapsed)}s seated=${seated}/${world.seats.length} walking=${people.length - seated}`);
    }
    frame++;
  }, 1000);
}

main().catch((err: unknown) => {
  console.error('[sim]', err instanceof Error ? err.message : err);
  process.exit(1);
});
