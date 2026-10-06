/**
 * Module 02's view of HKU HPC2021: which partitions and modules a job may
 * ask for, and how big an upload may be. Loaded from config/hpc.json (or
 * HPC_CONFIG), strictly, like every other config here.
 *
 * Until the M0 feasibility spike has run (docs/hpc/m0-checklist.md) the
 * partitions and modules are placeholders, and the file says so with
 * `"verified": false`. The UI shows that flag, because a partition list that
 * looks authoritative but was guessed would be believed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ConfigError } from '../../edge/registry.js';

export interface Partition {
  name: string;
  /** Longest --time the partition accepts, in seconds. */
  maxSeconds: number;
  /** As written in the file, for messages and the UI. */
  maxTime: string;
  gpu: boolean;
  /** GPUs per job on a GPU partition. */
  maxGpus: number;
}

export interface HpcConfig {
  /** False until M0 replaced the placeholders with what sinfo/module avail report. */
  verified: boolean;
  source: string;
  /**
   * Which HpcBackend submits jobs. Only "none" exists until the human picks
   * Plan A, B or C after M0 (HANDOVER.md §3 decision gate).
   */
  backend: 'none';
  partitions: Partition[];
  defaultPartition: string;
  modules: string[];
  maxUploadMb: number;
  maxUnpackedMb: number;
  /** Per person, across all of their jobs' extracted code. */
  quotaMb: number;
}

/** Module names are rendered into `module load`; keep them boring. */
const MODULE = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/;
const PARTITION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${where}: expected an object`);
  return v as Obj;
}

function only(o: Obj, where: string, allowed: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

function int(o: Obj, k: string, where: string, min: number, max: number, fallback?: number): number {
  const v = o[k] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${where}.${k}: expected an integer in ${min}..${max}, got ${JSON.stringify(o[k])}`);
  }
  return v;
}

function bool(o: Obj, k: string, where: string): boolean {
  if (typeof o[k] !== 'boolean') throw new ConfigError(`${where}.${k}: expected true or false`);
  return o[k] as boolean;
}

/**
 * A SLURM time limit in the two forms the handover allows (§6.2):
 * `D-HH:MM:SS` or `H:MM:SS`. Null when it is neither, or is zero.
 */
export function parseTimeLimit(s: string): number | null {
  let m = /^(\d{1,2})-(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const [d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number];
    if (h > 23 || mi > 59 || se > 59) return null;
    const t = ((d * 24 + h) * 60 + mi) * 60 + se;
    return t > 0 ? t : null;
  }
  m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const [h, mi, se] = m.slice(1).map(Number) as [number, number, number];
    if (mi > 59 || se > 59) return null;
    const t = (h * 60 + mi) * 60 + se;
    return t > 0 ? t : null;
  }
  return null;
}

export function parseHpcConfig(raw: unknown, where = 'hpc.json'): HpcConfig {
  const o = obj(raw, where);
  only(o, where, ['verified', 'source', 'backend', 'partitions', 'defaultPartition', 'modules',
    'maxUploadMb', 'maxUnpackedMb', 'quotaMb']);
  const verified = bool(o, 'verified', where);
  const source = typeof o.source === 'string' ? o.source : '';
  if (o.backend !== 'none') {
    // Not a typo to be fixed by adding a value: a backend that reaches HKU is
    // M2+ work, which the handover gates on M0 results and a human's choice.
    throw new ConfigError(`${where}.backend: only "none" exists until the M0 gate is passed (got ${JSON.stringify(o.backend)})`);
  }
  if (!Array.isArray(o.partitions) || o.partitions.length === 0 || o.partitions.length > 32) {
    throw new ConfigError(`${where}.partitions: expected 1-32 partitions`);
  }
  const partitions = o.partitions.map((p, i): Partition => {
    const at = `${where}.partitions[${i}]`;
    const po = obj(p, at);
    only(po, at, ['name', 'maxTime', 'gpu', 'maxGpus']);
    if (typeof po.name !== 'string' || !PARTITION.test(po.name)) throw new ConfigError(`${at}.name: expected a partition name`);
    const maxTime = typeof po.maxTime === 'string' ? po.maxTime : '';
    const maxSeconds = parseTimeLimit(maxTime);
    if (maxSeconds === null) throw new ConfigError(`${at}.maxTime: expected D-HH:MM:SS or H:MM:SS`);
    const gpu = bool(po, 'gpu', at);
    const maxGpus = gpu ? int(po, 'maxGpus', at, 1, 8) : 0;
    if (!gpu && po.maxGpus !== undefined) throw new ConfigError(`${at}.maxGpus: only a GPU partition has GPUs`);
    return { name: po.name, maxTime, maxSeconds, gpu, maxGpus };
  });
  if (new Set(partitions.map((p) => p.name)).size !== partitions.length) throw new ConfigError(`${where}.partitions: duplicate name`);
  const defaultPartition = o.defaultPartition;
  if (typeof defaultPartition !== 'string' || !partitions.some((p) => p.name === defaultPartition)) {
    throw new ConfigError(`${where}.defaultPartition: must name one of the partitions`);
  }
  if (!Array.isArray(o.modules) || o.modules.length > 200 || o.modules.some((m) => typeof m !== 'string' || !MODULE.test(m))) {
    throw new ConfigError(`${where}.modules: expected up to 200 module names (letters, digits, . _ + / -)`);
  }
  const modules = o.modules as string[];
  if (new Set(modules).size !== modules.length) throw new ConfigError(`${where}.modules: duplicate module`);
  return {
    verified, source, backend: 'none', partitions, defaultPartition, modules,
    // Defaults are the handover's (§6.2, §10); the 1 GB unpacked limit is its zip-bomb line.
    maxUploadMb: int(o, 'maxUploadMb', where, 1, 1024, 200),
    maxUnpackedMb: int(o, 'maxUnpackedMb', where, 1, 1024, 1024),
    quotaMb: int(o, 'quotaMb', where, 1, 65536, 2048),
  };
}

export function loadHpcConfig(path: string): HpcConfig {
  if (!existsSync(path)) throw new ConfigError(`${path}: not found (module 02 needs it; see config/hpc.json)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  return parseHpcConfig(raw, path);
}
