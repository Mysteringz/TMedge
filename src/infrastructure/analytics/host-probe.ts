/**
 * What the machine is doing: processor, memory, swap, network and disks.
 *
 * On Linux the figures come from /proc, because Node's own are not the ones
 * an operator means: `os.freemem()` has counted page cache as "used" on some
 * releases, and `os.cpus()` drops steal time -- which on a burstable cloud
 * instance is exactly the number that says the box is being throttled.
 * Everywhere else (a developer's Mac) it falls back to `os`, and says what it
 * could not measure rather than guessing.
 */
import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

export interface CpuTimes { total: number; idle: number; iowait: number; steal: number }
export interface MemoryInfo { totalBytes: number; availableBytes: number; swapTotalBytes: number | null; swapFreeBytes: number | null }
export interface NetCounters { rxBytes: number; txBytes: number }

export interface HostSample {
  cpuBusyPercent: number | null;
  cpuStealPercent: number | null;
  cpuIowaitPercent: number | null;
  load1: number;
  load5: number;
  load15: number;
  memory: MemoryInfo;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
}

export interface DiskUsage {
  id: 'system' | 'data';
  label: string;
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** As `df` prints it: of the space an unprivileged process can use. */
  usedPercent: number;
}

/** The aggregate `cpu` line of /proc/stat, in clock ticks. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
  // guest time is already inside user, so it is not added again.
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait, steal };
}

export function parseMeminfo(text: string): MemoryInfo | null {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal'), available = kb('MemAvailable');
  if (total === null || available === null) return null;
  return { totalBytes: total, availableBytes: available, swapTotalBytes: kb('SwapTotal'), swapFreeBytes: kb('SwapFree') };
}

/** Bytes in and out across every interface but loopback. */
export function parseNetDev(text: string): NetCounters | null {
  let rx = 0, tx = 0, seen = false;
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    const fields = line.slice(at + 1).trim().split(/\s+/).map(Number);
    if (name === 'lo' || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0] ?? 0; tx += fields[8] ?? 0; seen = true;
  }
  return seen ? { rxBytes: rx, txBytes: tx } : null;
}

/** Shares of the time between two readings. Null when no time has passed or the counters went backwards. */
export function cpuShares(previous: CpuTimes, next: CpuTimes): { busy: number; steal: number; iowait: number } | null {
  const total = next.total - previous.total;
  if (!(total > 0)) return null;
  const share = (a: number, b: number) => Math.min(100, Math.max(0, (b - a) / total * 100));
  const idle = share(previous.idle, next.idle), iowait = share(previous.iowait, next.iowait);
  return { busy: Math.max(0, 100 - idle - iowait), steal: share(previous.steal, next.steal), iowait };
}

function osCpuTimes(): CpuTimes {
  let total = 0, idle = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { total, idle, iowait: 0, steal: 0 };
}

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export class HostProbe {
  private cpu: CpuTimes | null = null;
  private net: { at: number; counters: NetCounters } | null = null;
  /** Injectable so a test can hand it canned /proc text. */
  constructor(private readonly readProc: (path: string) => string | null = process.platform === 'linux' ? read : () => null) {}

  sample(now: number = Date.now()): HostSample {
    const procStat = this.readProc('/proc/stat');
    const cpu = (procStat ? parseProcStat(procStat) : null) ?? osCpuTimes();
    const shares = this.cpu ? cpuShares(this.cpu, cpu) : null;
    this.cpu = cpu;

    const meminfo = this.readProc('/proc/meminfo');
    const memory = (meminfo ? parseMeminfo(meminfo) : null)
      ?? { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapTotalBytes: null, swapFreeBytes: null };

    const netDev = this.readProc('/proc/net/dev');
    const counters = netDev ? parseNetDev(netDev) : null;
    let rx: number | null = null, tx: number | null = null;
    if (counters && this.net && now > this.net.at && counters.rxBytes >= this.net.counters.rxBytes && counters.txBytes >= this.net.counters.txBytes) {
      const seconds = (now - this.net.at) / 1000;
      rx = (counters.rxBytes - this.net.counters.rxBytes) / seconds;
      tx = (counters.txBytes - this.net.counters.txBytes) / seconds;
    }
    this.net = counters ? { at: now, counters } : null;

    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    return {
      cpuBusyPercent: shares?.busy ?? null,
      // Only /proc can tell these apart from idle; elsewhere they are unknown, not zero.
      cpuStealPercent: procStat && shares ? shares.steal : null,
      cpuIowaitPercent: procStat && shares ? shares.iowait : null,
      load1, load5, load15, memory,
      netRxBytesPerSec: rx, netTxBytesPerSec: tx,
    };
  }
}

/** The volumes the service lives on: the system disk and, if it is a different device, the data directory's. */
export async function diskUsage(dataDir: string, root = '/'): Promise<DiskUsage[]> {
  const out: DiskUsage[] = [];
  let rootDev: number | null = null, dataDev: number | null = null;
  try { rootDev = statSync(root).dev; } catch { /* unreadable */ }
  try { dataDev = statSync(dataDir).dev; } catch { /* not created yet */ }
  const shared = rootDev !== null && dataDev === rootDev;
  const targets: { id: DiskUsage['id']; label: string; path: string }[] = [];
  if (rootDev !== null) targets.push({ id: 'system', label: shared || dataDev === null ? 'System and data volume' : 'System volume', path: root });
  if (dataDev !== null && !shared) targets.push({ id: 'data', label: 'Data volume', path: dataDir });
  for (const target of targets) {
    try {
      const s = await statfs(target.path);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize, used = (s.blocks - s.bfree) * s.bsize;
      if (!(total > 0)) continue;
      out.push({ ...target, totalBytes: total, usedBytes: used, freeBytes: free, usedPercent: used + free > 0 ? used / (used + free) * 100 : 0 });
    } catch { /* a volume that cannot be read is left out, never reported as empty */ }
  }
  return out;
}

export interface HostFacts { hostname: string; platform: string; kernel: string; arch: string; cores: number; cpuModel: string | null; uptimeS: number }

export function hostFacts(): HostFacts {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(), platform: os.platform(), kernel: os.release(), arch: os.arch(),
    cores: cpus.length, cpuModel: cpus[0]?.model.trim() || null, uptimeS: Math.round(os.uptime()),
  };
}
