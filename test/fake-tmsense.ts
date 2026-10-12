/**
 * A pretend TMsense: it speaks the firmware's serial console (`show`, `set …`,
 * `save`, `reboot`) closely enough that the flasher's real console code runs
 * against it unchanged. The same node TMflash's Swift tests use
 * (TMflash/Tests/TMflashCoreTests/FakeNode.swift), for the web flasher.
 *
 * Time is the test's own: nothing here sleeps. `VirtualLink` advances a clock
 * when it is asked to wait, so "a silent board fails instead of hanging" is
 * a test that finishes at once.
 */
import type { LineLink } from '../src/shared/flasher/node-console.js';

export class FakeTmsense {
  // Behaviour knobs.
  /** Never answers: not a TMsense, or nothing flashed yet. */
  silent = false;
  /** Answer this setting with "invalid: …". */
  refuse: string | null = null;
  /** Say "updated" for this setting and then not keep it. */
  forget: string | null = null;
  wifiJoins = true;
  /** Firmware with the direct-to-cloud transport (tmsense-1.4+): `caps`, `transport`, `cloud_url`. */
  directCloud = true;
  /** Firmware with `set fps` and the configured rate in `show` (tmsense-1.6+). */
  frameRateSelection = true;
  /** With transport wss, the edge acknowledges a report after the reboot. */
  edgeAccepts = true;
  bootDelayMs = 300;

  /** Every line received, as received. */
  readonly received: string[] = [];
  saved: Record<string, string>;
  boots = 7;
  private ram: Record<string, string>;
  private readyAt = 0;

  constructor(readonly uid: string) {
    this.ram = {
      node_id: '(unset)', mode: 'wifi', lora_gw: '(none)', ssid: '(unset)', password: '(unset)',
      edges: '(none) ', key: '(unset - telemetry unsigned)', transport: 'udp', cloud_url: '(none)', fps: '1',
    };
    this.saved = { ...this.ram };
  }

  get firmware(): string {
    return this.frameRateSelection ? 'tmsense-1.6' : this.directCloud ? 'tmsense-1.4' : 'tmsense-1.1';
  }

  /** A reset: RAM reloads from flash and the console is deaf while it boots. */
  reset(now: number): string[] {
    this.ram = { ...this.saved };
    this.readyAt = now + this.bootDelayMs;
    this.boots += 1;
    if (this.silent) return [];
    const out = ['', `=== TMsense ${this.firmware} ===`, `[boot] uid     ${this.uid}   boot #${this.boots}`];
    const joins = this.wifiJoins && this.ram.ssid !== '(unset)' && this.ram.mode === 'wifi';
    if (joins) out.push(`[wifi] connected ip=192.168.0.${parseInt(this.uid.slice(-2), 16) || 1} rssi=-55 dBm ch=6, commands on udp/5201`);
    if (joins && this.ram.transport === 'wss') {
      out.push('[cloud] waiting-for-time', '[cloud] connecting');
      if (this.edgeAccepts) out.push('[cloud] ready', '[cloud] report accepted by the edge');
      else out.push('[cloud] backoff: tls: certificate refused');
    }
    return out;
  }

  /** One line typed at the console; the lines it prints back. */
  handle(text: string, now: number): string[] {
    // Still booting: input is lost, as on a real reset.
    if (this.silent || now < this.readyAt) return [];
    // TMsense discards a line of 160+ bytes whole (s_line[160]).
    if (Buffer.byteLength(text) >= 160) return ['line too long, ignored'];
    if (!text) return [];
    this.received.push(text);
    const [verb, what, ...rest] = text.split(' ');
    const value = rest.join(' ');
    if (verb === 'show') return this.show();
    if (verb === 'save') { this.saved = { ...this.ram }; return ['saved']; }
    if (verb === 'reboot') return this.reset(now);
    if (verb !== 'set' || !what || !value) return ['unknown command; try `help`'];
    if (what === this.refuse) return [`invalid: ${what}`];
    const keep = (field: string, stored: string): void => { if (what !== this.forget) this.ram[field] = stored; };
    switch (what) {
      case 'id': keep('node_id', value); break;
      case 'mode':
        if (value === 'lora' && this.ram.transport === 'wss') return ['invalid: LoRa has no wss transport; `set transport udp` first'];
        keep('mode', value); break;
      case 'lora_gw': keep('lora_gw', value); break;
      case 'ssid': keep('ssid', value); break;
      case 'pass': keep('password', '(set)'); break;
      case 'edges': keep('edges', `${value} `); break;
      case 'key': keep('key', '(set)'); break;
      case 'fps':
        if (!this.frameRateSelection) return ['unknown setting'];
        if (!['1', '2', '4'].includes(value)) return ['invalid: fps must be 1, 2 or 4'];
        keep('fps', value); break;
      case 'cloud_url':
        if (!this.directCloud) return ['unknown setting'];
        if (!value.startsWith('wss://') || value.length > 128 || value.includes('?')) return ['invalid: cloud_url must start with wss://'];
        keep('cloud_url', value); break;
      case 'transport':
        if (!this.directCloud) return ['unknown setting'];
        if (value === 'wss' && this.ram.cloud_url === '(none)') return ['invalid: set cloud_url first'];
        if (value === 'wss' && this.ram.mode !== 'wifi') return ['invalid: transport wss needs mode wifi'];
        if (value !== 'udp' && value !== 'wss') return ['invalid: transport must be udp or wss'];
        keep('transport', value); break;
      default: return ['unknown setting'];
    }
    return [`${what} updated (not saved)`];
  }

  private show(): string[] {
    const r = this.ram;
    const out = [`uid       : ${this.uid}`, `fw        : ${this.firmware}`];
    const keys = ['node_id', 'mode', 'lora_gw', 'ssid', 'password', 'edges', 'key'];
    if (this.directCloud) keys.push('transport', 'cloud_url');
    for (const key of keys) out.push(`${key.padEnd(10)}: ${r[key] ?? ''}`);
    const caps = this.directCloud ? ['wss1', 'ota-https1'] : [];
    if (this.frameRateSelection) { caps.push('fps1'); out.push(`fps       : ${r.fps ?? '1'}`); }
    if (caps.length > 0) out.push(`caps      : ${caps.join(',')}`);
    if (this.directCloud) {
      out.push(`uplink    : ${r.transport === 'wss' ? 'wss off' : 'udp, wifi not joined'}`);
      out.push(`report_ack: ${r.transport === 'wss' ? 'never' : 'n/a (udp has no acknowledgement)'}`);
    }
    out.push(`boot      : ${this.boots}   last_cmd: 0`, 'param min_contrast = 50 centi-C');
    return out;
  }
}

/**
 * The flasher's end of a serial cable to a FakeTmsense, on a clock that only
 * moves when the flasher waits.
 */
export class VirtualLink implements LineLink {
  time = 0;
  private readonly lines: string[] = [];
  private pending = '';
  private frames = 0;

  constructor(readonly node: FakeTmsense) {}

  readonly now = (): number => this.time;

  async write(text: string): Promise<void> {
    this.pending += text.replaceAll('\r', '');
    for (;;) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.lines.push(...this.node.handle(line, this.time));
    }
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) { this.time += 1; return line; }
    this.time += Math.max(timeoutMs, 1);
    // Frame logs arrive whether or not anyone is typing.
    if (!this.node.silent && timeoutMs >= 100 && ++this.frames % 3 === 0) this.lines.push(`[frame ${this.frames}] people=1 scene 21.0..33.5 C fps=1.00`);
    return null;
  }
}
