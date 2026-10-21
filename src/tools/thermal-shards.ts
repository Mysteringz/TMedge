/**
 * Thermal day shards, as written by `python3 -m tools.thermalml shards`.
 *
 * One shard is every thermal frame one sensor recorded in one day (days start
 * at 04:00 Hong Kong time): `<day>.thermal.gz` holds N x 768 bytes, row-major
 * 24x32, and `<day>.json` the times, scaling and ids. Python trains on them;
 * this side replays the edge's own detector over the same frames, so the two
 * are scored on identical input. A shard that does not match its own index is
 * refused rather than half-read: a silently short day would make a detector
 * look better or worse than it is.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { GRID_SIZE } from '../edge/protocol.js';

export const SHARD_VERSION = 1;

export interface ThermalShard {
  sensor: string;
  day: string;
  locked: boolean;
  count: number;
  at: number[];
  frame: (number | null)[];
  tMin: number[];
  step: number[];
  id: string[];
  pixels: Uint8Array;
}

export interface ShardRef {
  sensor: string;
  day: string;
  locked: boolean;
  gz: string;
  json: string;
}

/** The sensor's directory name: its uid without colons, like the model files. */
export function sensorDir(uid: string): string {
  return uid.replaceAll(':', '');
}

function numbers(v: unknown, n: number, what: string, nullable = false): number[] {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`${what}: expected ${n} entries`);
  for (const x of v) {
    if (x === null && nullable) continue;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${what}: not a finite number`);
  }
  return v as number[];
}

export function readShard(ref: Pick<ShardRef, 'gz' | 'json'>): ThermalShard {
  const doc = JSON.parse(readFileSync(ref.json, 'utf8')) as Record<string, unknown>;
  if (doc.version !== SHARD_VERSION) throw new Error(`${ref.json}: unsupported shard version`);
  const count = doc.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error(`${ref.json}: bad count`);
  if (typeof doc.sensor !== 'string' || typeof doc.day !== 'string' || typeof doc.locked !== 'boolean') {
    throw new Error(`${ref.json}: sensor, day and locked are required`);
  }
  const pixels = gunzipSync(readFileSync(ref.gz));
  if (pixels.length !== count * GRID_SIZE) throw new Error(`${ref.gz}: ${pixels.length} bytes, expected ${count * GRID_SIZE}`);
  if (createHash('sha256').update(pixels).digest('hex') !== doc.payloadSha256) {
    throw new Error(`${ref.gz}: pixels do not match the index`);
  }
  const at = numbers(doc.at, count, 'at');
  for (let i = 1; i < count; i++) {
    if ((at[i] ?? 0) < (at[i - 1] ?? 0)) throw new Error(`${ref.json}: frames are not in time order`);
  }
  const id = doc.id;
  if (!Array.isArray(id) || id.length !== count || !id.every((v) => typeof v === 'string')) throw new Error(`${ref.json}: bad id list`);
  return {
    sensor: doc.sensor,
    day: doc.day,
    locked: doc.locked,
    count,
    at,
    frame: numbers(doc.frame, count, 'frame', true),
    tMin: numbers(doc.tMin, count, 'tMin'),
    step: numbers(doc.step, count, 'step'),
    id: id as string[],
    pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length),
  };
}

/** Every shard under `root`, oldest day first; the locked test days only when asked. */
export function listShards(root: string, includeLocked: boolean): ShardRef[] {
  const out: ShardRef[] = [];
  const scan = (base: string, locked: boolean) => {
    if (!existsSync(base)) return;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (name === 'locked' || !statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.json')) continue;
        const day = f.slice(0, -'.json'.length);
        const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sensor?: unknown; locked?: unknown };
        if (typeof doc.sensor !== 'string' || doc.locked !== locked) throw new Error(`${join(dir, f)}: in the wrong folder`);
        out.push({ sensor: doc.sensor, day, locked, gz: join(dir, `${day}.thermal.gz`), json: join(dir, f) });
      }
    }
  };
  scan(root, false);
  if (includeLocked) scan(join(root, 'locked'), true);
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.sensor.localeCompare(b.sensor));
}
