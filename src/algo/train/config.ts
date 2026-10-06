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
   * Which HpcBackend submits jobs: "none", or "vpn-ssh" -- Plan A, each
   * person's own HKUVPN tunnel and SSH login (HANDOVER.md §4), chosen on
   * 2026-10-06 (docs/hpc/decisions.md).
   */
  backend: 'none' | 'vpn-ssh';
  /** Plan A's settings; present exactly when backend is "vpn-ssh". */
  planA: PlanAConfig | null;
  partitions: Partition[];
  defaultPartition: string;
  modules: string[];
  maxUploadMb: number;
  maxUnpackedMb: number;
  /** Per person, across all of their jobs' extracted code. */
  quotaMb: number;
}

export interface PlanAConfig {
  /** host[:port] of the AnyConnect server: vpn2fa.hku.hk. */
  vpnHost: string;
  /** VPN usernames are UID@<domain> (§2); the person picks one of these. */
  vpnDomains: string[];
  /** openconnect --servercert pin; null means the system's CAs decide (HKU's real certificate). */
  vpnServerCert: string | null;
  /** openconnect --authgroup, if M0 finds HKU shows a group menu. */
  vpnAuthGroup: string | null;
  /** The login node for SSH, sbatch and the code copy (host name or IP, inside the VPN). */
  submitHost: string;
  /**
   * The SSH account. null: each person's own HKU UID. A name: one account
   * the whole team shares (e.g. "ing"), with its own password -- see sshAuth.
   */
  sshUser: string | null;
  /**
   * "pin": SSH takes the person's Portal PIN (HPC2021's rule, §2).
   * "shared-password": everyone types the shared account's password at each
   * sign-in; only its fingerprint is kept, on the box (hpc/fingerprint.ts).
   */
  sshAuth: 'pin' | 'shared-password';
  /** Pinned host keys; null = DATA_DIR/algo/train/known_hosts (npm run hpc-hostkeys). */
  knownHosts: string | null;
  idleTtlSeconds: number;
  maxSessions: number;
  socksPorts: [number, number];
  tools: { openconnect: string | null; ocproxy: string | null; ssh: string | null };
}

const HOST_PORT = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
/** Paths end up in command lines; nothing a shell would reinterpret. */
const ABS_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;

function parsePlanA(raw: unknown, where: string): PlanAConfig {
  const o = obj(raw, where);
  only(o, where, ['vpnHost', 'vpnDomains', 'vpnServerCert', 'vpnAuthGroup', 'submitHost', 'sshUser', 'sshAuth', 'knownHosts', 'idleTtlSeconds', 'maxSessions', 'socksPorts', 'tools']);
  if (typeof o.vpnHost !== 'string' || !HOST_PORT.test(o.vpnHost)) throw new ConfigError(`${where}.vpnHost: expected host or host:port`);
  if (!Array.isArray(o.vpnDomains) || o.vpnDomains.length < 1 || o.vpnDomains.length > 8 ||
      o.vpnDomains.some((d) => typeof d !== 'string' || !/^[a-z0-9.-]{1,100}$/.test(d))) {
    throw new ConfigError(`${where}.vpnDomains: expected 1-8 domains like "hku.hk"`);
  }
  const cert = o.vpnServerCert ?? null;
  if (cert !== null && (typeof cert !== 'string' || !/^(?:pin-sha256:[A-Za-z0-9+/]{43}=|sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/.test(cert))) {
    throw new ConfigError(`${where}.vpnServerCert: expected pin-sha256:<base64> or null`);
  }
  const group = o.vpnAuthGroup ?? null;
  if (group !== null && (typeof group !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(group))) throw new ConfigError(`${where}.vpnAuthGroup: expected a group name or null`);
  if (typeof o.submitHost !== 'string' || !HOST.test(o.submitHost) || o.submitHost.startsWith('-')) throw new ConfigError(`${where}.submitHost: expected a host name or IP`);
  const sshUser = o.sshUser ?? null;
  if (sshUser !== null && (typeof sshUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser))) throw new ConfigError(`${where}.sshUser: expected a Unix user name or null`);
  const sshAuth = o.sshAuth ?? 'pin';
  if (sshAuth !== 'pin' && sshAuth !== 'shared-password') throw new ConfigError(`${where}.sshAuth: "pin" or "shared-password"`);
  if (sshAuth === 'shared-password' && sshUser === null) throw new ConfigError(`${where}.sshUser: required with sshAuth "shared-password" (whose password is it?)`);
  const known = o.knownHosts ?? null;
  if (known !== null && (typeof known !== 'string' || !ABS_PATH.test(known))) throw new ConfigError(`${where}.knownHosts: expected an absolute path or null`);
  const ports = o.socksPorts;
  if (!Array.isArray(ports) || ports.length !== 2 || !ports.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) ||
      (ports[0] as number) > (ports[1] as number) || (ports[1] as number) - (ports[0] as number) > 1000) {
    throw new ConfigError(`${where}.socksPorts: expected [first, last] within 1024-65535, at most 1000 apart`);
  }
  const t = obj(o.tools ?? {}, `${where}.tools`);
  only(t, `${where}.tools`, ['openconnect', 'ocproxy', 'ssh']);
  const tool = (k: string) => {
    const v = t[k] ?? null;
    if (v !== null && (typeof v !== 'string' || !ABS_PATH.test(v))) throw new ConfigError(`${where}.tools.${k}: expected an absolute path or null`);
    return v as string | null;
  };
  return {
    vpnHost: o.vpnHost, vpnDomains: o.vpnDomains as string[], vpnServerCert: cert as string | null, vpnAuthGroup: group as string | null,
    submitHost: o.submitHost, sshUser: sshUser as string | null, sshAuth, knownHosts: known as string | null,
    idleTtlSeconds: int(o, 'idleTtlSeconds', where, 60, 3600, 600),
    maxSessions: int(o, 'maxSessions', where, 1, 50, 10),
    socksPorts: [ports[0] as number, ports[1] as number],
    tools: { openconnect: tool('openconnect'), ocproxy: tool('ocproxy'), ssh: tool('ssh') },
  };
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
  only(o, where, ['verified', 'source', 'backend', 'planA', 'partitions', 'defaultPartition', 'modules',
    'maxUploadMb', 'maxUnpackedMb', 'quotaMb']);
  const verified = bool(o, 'verified', where);
  const source = typeof o.source === 'string' ? o.source : '';
  if (o.backend !== 'none' && o.backend !== 'vpn-ssh') {
    // Plan B (pull agent) and C (an official HKU route) are not built.
    throw new ConfigError(`${where}.backend: "none" or "vpn-ssh" (got ${JSON.stringify(o.backend)})`);
  }
  const backend = o.backend;
  if (backend === 'vpn-ssh' && o.planA === undefined) throw new ConfigError(`${where}.planA: required when backend is "vpn-ssh"`);
  if (backend === 'none' && o.planA !== undefined) throw new ConfigError(`${where}.planA: only with backend "vpn-ssh"`);
  const planA = backend === 'vpn-ssh' ? parsePlanA(o.planA, `${where}.planA`) : null;
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
    verified, source, backend, planA, partitions, defaultPartition, modules,
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
