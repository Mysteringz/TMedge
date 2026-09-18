/** Edge process and host health for the console. */
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export class HostMonitor {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  readonly startedAt = Date.now();

  constructor() {
    this.loop.enable();
  }

  sample() {
    const mem = process.memoryUsage();
    // p99 over the last interval, then reset, so the figure is current rather
    // than the worst moment since boot.
    const lagMs = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    return {
      startedAt: this.startedAt,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpuLoad1: os.loadavg()[0] ?? 0,
      cpus: os.cpus().length,
      memRssMb: Math.round(mem.rss / 1048576),
      memHeapMb: Math.round(mem.heapUsed / 1048576),
      sysFreeMb: Math.round(os.freemem() / 1048576),
      sysTotalMb: Math.round(os.totalmem() / 1048576),
      eventLoopLagMs: Math.round(lagMs * 10) / 10,
    };
  }
}
