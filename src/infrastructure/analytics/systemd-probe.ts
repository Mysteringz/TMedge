/**
 * The state of the units this deployment is made of, as systemd reports it.
 *
 * Read-only by construction: the one thing run is `systemctl show`, with the
 * unit names as arguments (never through a shell) and only names that match
 * a strict pattern. On a machine without systemd -- a developer's Mac, a
 * container -- the source is simply `disabled`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

export interface UnitStatus {
  unit: string;
  description: string | null;
  /** active | inactive | failed | activating | deactivating | reloading */
  activeState: string;
  subState: string;
  /** When it last became active, ms since epoch; null if it is not active or the host did not say. */
  activeSince: number | null;
  restarts: number | null;
  memoryBytes: number | null;
}

// Starts with a letter or digit, so no name can be read as an option.
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,127}$/;
const PROPERTIES = 'Id,Description,LoadState,ActiveState,SubState,ActiveEnterTimestampMonotonic,NRestarts,MemoryCurrent';

/** The units a stock install has. Ones this machine does not have are left out of the result, not shown as stopped. */
export const DEFAULT_UNITS = [
  'tmedge-edge.service', 'tmedge-web.service', 'tmedge-sim.service', 'cloudflared.service', 'tailscaled.service',
  'tmedge-training.service', 'tmedge-training-tunnel.service', 'tmedge-prune.timer',
] as const;

export function isUnitName(value: string): boolean {
  return UNIT_NAME.test(value);
}

/**
 * `systemctl show` prints one `Key=Value` block per unit, blank line between.
 * `uptimeS`/`now` turn the monotonic "became active" stamp into a wall-clock
 * time without parsing a localised date.
 */
export function parseSystemctlShow(text: string, uptimeS: number, now: number): UnitStatus[] {
  const out: UnitStatus[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const unit = fields.get('Id');
    if (!unit || !isUnitName(unit) || fields.get('LoadState') !== 'loaded') continue;
    const number = (key: string): number | null => {
      const raw = fields.get(key);
      // systemd prints "[not set]" or 2^64-1 for a figure it does not track.
      if (!raw || !/^\d+$/.test(raw) || raw.length > 15) return null;
      return Number(raw);
    };
    const activeState = fields.get('ActiveState') ?? 'unknown';
    const monotonicUs = number('ActiveEnterTimestampMonotonic');
    const activeSince = activeState === 'active' && monotonicUs !== null && monotonicUs > 0
      ? Math.round(now - (uptimeS * 1000 - monotonicUs / 1000)) : null;
    out.push({
      unit, description: fields.get('Description') || null, activeState, subState: fields.get('SubState') ?? '',
      activeSince, restarts: number('NRestarts'), memoryBytes: number('MemoryCurrent'),
    });
  }
  return out;
}

export class SystemdProbe {
  private cached: { at: number; value: UnitStatus[] | null } | null = null;
  private running: Promise<UnitStatus[] | null> | null = null;
  readonly units: string[];

  constructor(units: readonly string[] = DEFAULT_UNITS, private readonly maxAgeMs = 15_000) {
    this.units = units.filter(isUnitName).slice(0, 32);
  }

  /** False where there is no systemd to ask; the caller reports the source as disabled. */
  get supported(): boolean {
    return process.platform === 'linux' && this.units.length > 0 && existsSync('/run/systemd/system');
  }

  /** Null when systemd could not be asked. One call at a time, and at most one every `maxAgeMs`. */
  read(now: number = Date.now()): Promise<UnitStatus[] | null> {
    if (!this.supported) return Promise.resolve(null);
    if (this.cached && now - this.cached.at < this.maxAgeMs) return Promise.resolve(this.cached.value);
    this.running ??= new Promise<UnitStatus[] | null>((resolve) => {
      try {
        execFile('systemctl', ['show', '--no-pager', `--property=${PROPERTIES}`, '--', ...this.units],
          { timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true },
          (error, stdout) => resolve(error ? null : parseSystemctlShow(String(stdout), os.uptime(), Date.now())));
      } catch { resolve(null); }
    }).then((value) => {
      this.cached = { at: Date.now(), value };
      this.running = null;
      return value;
    });
    return this.running;
  }
}
