/**
 * Talking to a running TMsense over its serial console: `show`, `set`, `save`,
 * `reboot`, and reading back what it now says about itself.
 *
 * The protocol is the firmware's (TMsense/src/tm_settings.cpp): `show` prints
 * `name : value` lines from `uid` through `boot`, and each `set` answers
 * `<name> updated`. TMflash's NodeConsole.swift and Pipeline.swift are the
 * same logic for the Mac app; a change to the console's field names has to
 * reach all three.
 *
 * Written against a line-at-a-time link rather than a serial port, so the
 * test suite can stand a fake node in for the hardware (test/flasher.test.ts).
 */
import {
  canonicalCloudUrl, provisioningCommands, scrub, secretsOf,
  type ConsoleCommand, type FrameRate, type NodeSettings, type UplinkMode, type UplinkTransport,
} from './settings.js';

export interface LineLink {
  write(text: string): Promise<void>;
  /** The next complete line, or null once `timeoutMs` has passed without one. */
  readLine(timeoutMs: number): Promise<string | null>;
}

export class FlasherError extends Error {}

/** What a TMsense node reports for `show`. */
export class NodeInfo {
  constructor(readonly fields: Readonly<Record<string, string>>) {}

  get uid(): string | null { return this.fields.uid ?? null; }
  get firmware(): string | null { return this.fields.fw ?? null; }
  get nodeId(): number | null {
    const text = this.fields.node_id;
    return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
  }
  get mode(): UplinkMode | null {
    const mode = this.fields.mode;
    return mode === 'wifi' || mode === 'lora' ? mode : null;
  }
  get ssid(): string | null {
    const ssid = this.fields.ssid;
    return ssid === undefined || ssid === '(unset)' ? null : ssid;
  }
  get passwordSet(): boolean { return this.fields.password === '(set)'; }
  get keySet(): boolean { return this.fields.key === '(set)'; }
  /** First edge (Wi-Fi destination), null if none. */
  get edge(): string | null {
    const first = this.fields.edges?.split(' ')[0];
    return !first || first === '(none)' ? null : first;
  }
  get loraGateway(): string | null {
    const gateway = this.fields.lora_gw;
    return gateway === undefined || gateway === '(none)' ? null : gateway;
  }
  /** What the firmware says it can do (`caps : wss1,ota-https1`); empty on older firmware. */
  get capabilities(): ReadonlySet<string> {
    return new Set((this.fields.caps ?? '').split(',').map((cap) => cap.trim()).filter(Boolean));
  }
  /** The firmware has the direct-to-cloud transport and its settings. */
  get supportsDirectCloud(): boolean { return this.capabilities.has('wss1'); }
  get supportsFrameRate(): boolean { return this.capabilities.has('fps1'); }
  /** Configured complete-frame rate; measured fps is reported separately in telemetry. */
  get frameRate(): FrameRate | null {
    const fps = Number(this.fields.fps);
    return fps === 1 || fps === 2 || fps === 4 ? fps : null;
  }
  /** No `transport` line means firmware from before direct cloud: UDP. */
  get transport(): UplinkTransport { return this.fields.transport === 'wss' ? 'wss' : 'udp'; }
  get cloudUrl(): string | null {
    const url = this.fields.cloud_url;
    return url === undefined || url === '(none)' ? null : url;
  }
}

/**
 * Parses one console line; null for anything that is not a `show` field
 * (frame logs, `param` lines, the boot banner).
 */
export function parseField(line: string): [string, string] | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const name = line.slice(0, colon).trim();
  if (!/^[a-z_]+$/.test(name)) return null;
  return [name, line.slice(colon + 1).trim()];
}

/**
 * Differences between what was asked for and what the node reports.
 * `errors` mean the node is not provisioned as asked; `warnings` mean it is,
 * but will not work as a node yet (e.g. no key: TMedge rejects it).
 */
export function verifyNode(info: NodeInfo, id: number, s: NodeSettings): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const f = info.fields;
  if (info.nodeId !== id) errors.push(`node ID reads ${f.node_id ?? 'nothing'}, expected ${id}`);
  if (info.mode !== s.mode) errors.push(`mode reads ${f.mode ?? 'nothing'}, expected ${s.mode}`);
  if (s.frameRate !== null && info.frameRate !== s.frameRate) errors.push(`frame rate reads ${f.fps ?? 'nothing'}, expected ${s.frameRate} fps`);
  if (s.mode === 'wifi') {
    if (s.ssid && info.ssid !== s.ssid) errors.push('SSID was not stored');
    if (s.password && !info.passwordSet) errors.push('Wi-Fi password was not stored');
    if (s.gateway && info.edge !== s.gateway) errors.push(`TMWAccess IP reads ${info.edge ?? 'nothing'}, expected ${s.gateway}`);
    if (info.ssid === null) warnings.push('no Wi-Fi SSID on the node');
    if (!info.passwordSet) warnings.push('no Wi-Fi password on the node');
    if (s.transport === 'wss' || info.transport === 'wss') {
      if (info.transport !== s.transport) errors.push(`transport reads ${f.transport ?? 'nothing (old firmware)'}, expected ${s.transport}`);
      const want = canonicalCloudUrl(s.cloudUrl);
      if (want && info.cloudUrl !== want) errors.push(`cloud URL reads ${info.cloudUrl ?? 'nothing'}, expected ${want}`);
      if (s.transport === 'wss' && info.cloudUrl === null) errors.push('no cloud URL on the node: transport wss has nowhere to go');
      if (info.edge === null) warnings.push('no TMWAccess IP kept on the node: a USB rollback to UDP will need one');
    } else {
      if (info.supportsDirectCloud && info.transport !== 'udp') errors.push(`transport reads ${f.transport ?? 'nothing'}, expected udp`);
      if (info.edge === null) warnings.push('no TMWAccess IP on the node: it has nowhere to send');
    }
  } else {
    if (s.gateway && info.loraGateway !== s.gateway) errors.push(`TMLAccess IP reads ${info.loraGateway ?? 'nothing'}, expected ${s.gateway}`);
    if (info.loraGateway === null) warnings.push('no TMLAccess IP on the node');
    warnings.push('this firmware has no LoRa uplink yet: the node stores the settings but sends nothing until it does');
  }
  if (s.key && !info.keySet) errors.push('signing key was not stored');
  if (!info.keySet) warnings.push('no signing key: telemetry is unsigned and TMedge will reject it');
  return { errors, warnings };
}

export interface BootWatch {
  /** Joined Wi-Fi as this address; null if it did not. */
  ip: string | null;
  /** TMedge acknowledged a report from this boot (transport wss only). */
  edgeAccepted: boolean;
  /** Why the cloud session last failed, as the node put it. */
  cloudError: string | null;
}

const FAILURES = ['invalid', 'unknown', 'usage:', 'SAVE FAILED', 'line too long'];
const BOOT_PREFIXES = ['[boot]', '[wifi]', '[lora]', '[sensor]', '[cloud]'];

export class NodeConsole {
  constructor(
    private readonly link: LineLink,
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Waits until the firmware answers `show` (after a reset it may still be
   * booting), and returns what it reported.
   */
  async waitUntilReady(timeoutMs: number): Promise<NodeInfo> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.link.write('\nshow\n');
      const info = await this.collectShow(Math.min(1500, Math.max(100, deadline - this.now())));
      if (info) return info;
    }
    throw new FlasherError(`no answer from TMsense firmware within ${Math.round(timeoutMs / 1000)} s — is it a TMsense, and is its firmware running?`);
  }

  async show(timeoutMs = 4000): Promise<NodeInfo> {
    // Whatever the node was in the middle of printing is not the answer.
    const quiet = this.now() + 200;
    while (this.now() < quiet && await this.link.readLine(Math.max(1, quiet - this.now())) !== null) { /* discard */ }
    await this.link.write('show\n');
    const info = await this.collectShow(timeoutMs);
    if (!info) throw new FlasherError('node did not answer `show`');
    return info;
  }

  /**
   * Reads `show` output: fields from `uid` through `boot` (the last fixed
   * line before the parameters). Other output is skipped.
   */
  private async collectShow(timeoutMs: number): Promise<NodeInfo | null> {
    const deadline = this.now() + timeoutMs;
    let fields: Record<string, string> = {};
    for (;;) {
      const line = await this.link.readLine(Math.max(0, deadline - this.now()));
      if (line === null) return null;
      const field = parseField(line);
      if (!field) continue;
      const [name, value] = field;
      if (name === 'uid') fields = {};   // a fresh block
      fields[name] = value;
      if (name === 'boot' && fields.uid !== undefined) return new NodeInfo(fields);
    }
  }

  async run(c: ConsoleCommand, timeoutMs = 4000): Promise<void> {
    this.log(`› ${c.display}`);
    await this.link.write(`${c.line}\n`);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const line = await this.link.readLine(Math.max(0, deadline - this.now()));
      if (line === null) break;
      if (line.startsWith(c.expect)) return;
      if (FAILURES.some((failure) => line.startsWith(failure))) throw new FlasherError(`node refused \`${c.display}\`: ${line}`);
    }
    throw new FlasherError(`no answer to \`${c.display}\` within ${Math.round(timeoutMs / 1000)} s`);
  }

  /**
   * Reboots, waits for Wi-Fi, and -- if `cloudTimeoutMs` > 0 -- for the node
   * to say TMedge accepted one of its reports. Two separate facts: a DHCP
   * lease proves nothing about the edge.
   */
  async rebootAndWatch(wifiTimeoutMs: number, cloudTimeoutMs: number): Promise<BootWatch> {
    this.log('› reboot');
    await this.link.write('reboot\n');
    const watch: BootWatch = { ip: null, edgeAccepted: false, cloudError: null };
    let deadline = this.now() + wifiTimeoutMs;
    for (;;) {
      const line = await this.link.readLine(Math.max(0, deadline - this.now()));
      if (line === null) return watch;
      // "[wifi] connected ip=192.168.0.9 rssi=-60 dBm ch=6, ..."
      const joined = watch.ip === null ? /^\[wifi\] connected ip=(\S+)/.exec(line) : null;
      if (joined) {
        watch.ip = joined[1] ?? null;
        this.log(line);
        if (cloudTimeoutMs <= 0) return watch;
        deadline = this.now() + cloudTimeoutMs;
        continue;
      }
      if (line.startsWith('[cloud] report accepted')) {
        this.log(line);
        watch.edgeAccepted = true;
        return watch;
      }
      // "[cloud] backoff: tls: certificate refused"
      if (line.startsWith('[cloud] backoff: ')) watch.cloudError = line.slice('[cloud] backoff: '.length);
      if (BOOT_PREFIXES.some((prefix) => line.startsWith(prefix))) this.log(line);
    }
  }

  async reboot(): Promise<void> {
    this.log('› reboot');
    await this.link.write('reboot\n');
  }
}

/** Whether TMedge will talk to this node, as far as the flasher could find out. */
export type Admission =
  /** In the edge's list: nothing more to ask. */
  | { state: 'registered' }
  /** Queued; nobody has answered yet. Not a refusal. */
  | { state: 'pending' }
  | { state: 'denied' }
  /** The question could not be asked or its answer could not be read. */
  | { state: 'failed'; reason: string };

export type ProvisionStage = 'provisioning' | 'awaiting-approval' | 'joining-wifi' | 'reaching-edge';

export interface ProvisionOptions {
  /** For the node to answer after a reset. */
  bootTimeoutMs?: number;
  /** Reboot after saving and wait this long for the Wi-Fi join line; 0 = skip. */
  wifiTimeoutMs?: number;
  /**
   * Direct cloud: after joining Wi-Fi, wait this long for TMedge to accept a
   * report (time sync, TLS and authentication come first); 0 = skip.
   */
  edgeTimeoutMs?: number;
  log(line: string): void;
  stage(stage: ProvisionStage): void;
  /**
   * Ask the edge to admit this node. Absent = do not ask, for a node whose
   * uid is already in the edge's list.
   */
  admit?(info: NodeInfo): Promise<Admission>;
  now?(): number;
}

export interface Provisioned {
  info: NodeInfo;
  ip: string | null;
  /** null = not checked (UDP, or the check was skipped). */
  edgeAccepted: boolean | null;
  /** null = not asked. */
  admission: Admission | null;
  warnings: string[];
}

/**
 * Writes `settings` to the node on `link`, reads them back, asks the edge to
 * admit it, and watches it come up.
 *
 * The order is the Mac app's and each step is there for a reason: the
 * firmware is asked what it can do before anything is written, settings are
 * verified by reading them back rather than by trusting the replies, and the
 * edge is asked to admit the node *before* the node is asked to reach it --
 * an edge that has never heard of a uid answers its first packet with
 * "authentication failed", which would otherwise be reported as a broken node.
 */
export async function provisionNode(link: LineLink, nodeId: number, settings: NodeSettings, options: ProvisionOptions): Promise<Provisioned> {
  const secrets = secretsOf(settings);
  try {
    return await provision(link, nodeId, settings, options, secrets);
  } catch (error) {
    // A refusal quotes the node's own line, and a node is free to quote the
    // command it was sent. Nothing leaves here with a secret in it.
    throw new FlasherError(scrub(error instanceof Error ? error.message : String(error), secrets));
  }
}

async function provision(link: LineLink, nodeId: number, settings: NodeSettings, options: ProvisionOptions, secrets: readonly string[]): Promise<Provisioned> {
  const log = (line: string) => options.log(scrub(line, secrets));
  const node = new NodeConsole(link, log, options.now);
  const before = await node.waitUntilReady(options.bootTimeoutMs ?? 25_000);
  log(`node ${before.uid ?? '?'} running ${before.firmware ?? 'unknown firmware'}`);
  // Asked before anything is written: old firmware would answer `set
  // transport` with "unknown setting" halfway through, or -- worse -- keep
  // sending over UDP while the record says cloud.
  if (settings.mode === 'wifi' && settings.transport === 'wss' && !before.supportsDirectCloud) {
    throw new FlasherError(`${before.firmware ?? 'this firmware'} has no direct-to-cloud transport: flash the current TMsense, or choose the local gateway`);
  }
  if (settings.frameRate !== null && !before.supportsFrameRate) {
    throw new FlasherError(`${before.firmware ?? 'this firmware'} has no frame-rate selection: flash TMsense 1.6 or newer, or keep the node's current rate`);
  }
  options.stage('provisioning');
  for (const c of provisioningCommands(nodeId, settings, before.supportsDirectCloud)) await node.run(c);
  const after = await node.show();
  const { errors, warnings } = verifyNode(after, nodeId, settings);
  if (errors.length > 0) throw new FlasherError(`verification failed: ${errors.join('; ')}`);
  const notes = [...warnings];
  let admission: Admission | null = null;

  if (options.admit && after.uid) {
    options.stage('awaiting-approval');
    admission = await options.admit(after);
    if (admission.state === 'denied') {
      throw new FlasherError(`TMedge turned down the request to admit ${after.uid}: the node is set up but will not be allowed to connect`);
    }
    if (admission.state === 'failed') throw new FlasherError(`TMedge admission failed: ${admission.reason}`);
    if (admission.state === 'pending') {
      notes.push(`TMedge has not admitted ${after.uid} yet — the request is waiting in Adoption; the node will connect once somebody approves it`);
    }
  }

  let ip: string | null = null;
  let edgeAccepted: boolean | null = null;
  const wifiTimeoutMs = options.wifiTimeoutMs ?? 30_000;
  const edgeTimeoutMs = options.edgeTimeoutMs ?? 90_000;
  if (settings.mode === 'wifi' && after.ssid !== null && wifiTimeoutMs > 0) {
    options.stage('joining-wifi');
    // No point waiting for an ACK from an edge that has not admitted this
    // node: it would refuse every packet and we would blame the node.
    const cloud = after.transport === 'wss' && edgeTimeoutMs > 0 && admission?.state !== 'pending';
    if (cloud) log(`then waiting up to ${Math.round(edgeTimeoutMs / 1000)} s for TMedge to accept a report`);
    const watch = await node.rebootAndWatch(wifiTimeoutMs, cloud ? edgeTimeoutMs : 0);
    ip = watch.ip;
    if (ip) log(`joined ${after.ssid} as ${ip}`);
    else notes.push(`did not join “${after.ssid}” within ${Math.round(wifiTimeoutMs / 1000)} s — check the SSID, password and signal`);
    if (cloud && ip) {
      options.stage('reaching-edge');
      edgeAccepted = watch.edgeAccepted;
      if (watch.edgeAccepted) log('TMedge accepted a report');
      else {
        notes.push(`joined Wi-Fi, but TMedge did not accept a report within ${Math.round(edgeTimeoutMs / 1000)} s`
          + `${watch.cloudError ? ` (last error: ${watch.cloudError})` : ''} — the node is not delivering occupancy yet`);
      }
    }
  } else {
    await node.reboot();
  }
  for (const note of notes) log(`⚠︎ ${note}`);
  return { info: after, ip, edgeAccepted, admission, warnings: notes };
}
