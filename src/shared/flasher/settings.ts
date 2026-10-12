/**
 * What gets written to a TMsense node over its serial console, and the lines
 * that write it.
 *
 * This is TMflash's NodeSettings (TMflash/Sources/TMflashCore/NodeSettings.swift)
 * for the console's web flasher. The two speak to the same firmware, so the
 * limits and the command order here are the firmware's
 * (TMsense/src/tm_settings.cpp), not a choice made in this file: change all
 * three together.
 *
 * No DOM and no Node APIs: the browser runs this and the test suite checks it.
 */

export type UplinkMode = 'wifi' | 'lora';
/** `udp` sends to a local gateway (`edges`); `wss` goes straight to TMedge. */
export type UplinkTransport = 'udp' | 'wss';
/** Complete thermal frames per second. */
export type FrameRate = 1 | 2 | 4;

/**
 * An empty string means "keep what the node already has", so re-flashing
 * firmware never forces anyone to re-type a password, and a fresh node is
 * caught by verification instead.
 */
export interface NodeSettings {
  mode: UplinkMode;
  ssid: string;
  password: string;
  /** TMWAccess IP in Wi-Fi mode, TMLAccess IP in LoRa mode. */
  gateway: string;
  /** Shared signing key (TMedge's TM_KEY). */
  key: string;
  transport: UplinkTransport;
  /** TMedge's node endpoint for `wss`, e.g. wss://sense.example.com/tmnode. */
  cloudUrl: string;
  /** null keeps the node's current rate, including when re-flashing it. */
  frameRate: FrameRate | null;
}

export const EMPTY_SETTINGS: NodeSettings = {
  mode: 'wifi', ssid: '', password: '', gateway: '', key: '', transport: 'udp', cloudUrl: '', frameRate: null,
};

// Limits mirror TMsense's TmSettings buffers and its 160-byte console line.
export const MAX_SSID = 32;
export const MAX_PASSWORD = 63;
export const MAX_KEY = 64;
/** TMsense TM_CLOUD_URL_MAX: ASCII bytes, never truncated. */
export const MAX_CLOUD_URL = 128;
export const MIN_NODE_ID = 1;
export const MAX_NODE_ID = 65535;

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

export function gatewayName(mode: UplinkMode): string {
  return mode === 'wifi' ? 'TMWAccess' : 'TMLAccess';
}

export function isIPv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * The form TMsense stores and compares: lowercase scheme and host, no
 * explicit :443. The firmware refuses an uppercase host rather than guessing,
 * so the flasher normalises before sending.
 */
export function canonicalCloudUrl(raw: string): string {
  const text = raw.trim();
  const schemeEnd = text.indexOf('://');
  if (schemeEnd < 0) return text;
  const rest = text.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  let authority = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  if (authority.endsWith(':443')) authority = authority.slice(0, -4);
  return `${text.slice(0, schemeEnd).toLowerCase()}://${authority}${slash < 0 ? '' : rest.slice(slash)}`;
}

/**
 * Mirrors TMsense tm_cloud_parse_url for a production build: the same URL is
 * refused in the same way on both sides, before a node is touched.
 */
export function cloudUrlProblem(url: string): string | null {
  if (url.length === 0 || utf8(url) > MAX_CLOUD_URL) return `Cloud URL must be 1–${MAX_CLOUD_URL} characters`;
  if (/[^\x21-\x7e]|[%\\]/.test(url)) return 'Cloud URL may contain only printable ASCII, no spaces, % or \\';
  if (url.includes('?') || url.includes('#')) return 'Cloud URL must not have a query or fragment';
  if (!url.startsWith('wss://')) return 'Cloud URL must start with wss://';
  const rest = url.slice(6);
  const slash = rest.indexOf('/');
  if (slash < 0) return 'Cloud URL needs a path, like /tmnode';
  const authority = rest.slice(0, slash);
  if (authority.includes('@')) return 'Cloud URL must not contain a user name or password';
  let host = authority;
  const colon = authority.indexOf(':');
  if (colon >= 0) {
    host = authority.slice(0, colon);
    if (authority.slice(colon + 1) !== '443') return 'Cloud URL port must be 443';
  }
  const labels = host.split('.');
  const hostOk = host.length > 0 && host.length <= 100 && /[a-z]/.test(host)
    && labels.every((label) => /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith('-') && !label.endsWith('-'));
  if (!hostOk) return 'Cloud URL host must be a lowercase DNS name';
  const path = rest.slice(slash);
  if (path.length < 2 || path.length > 64 || !/^[A-Za-z0-9/\-_.~]+$/.test(path) || path.includes('//')
    || path.split('/').some((part) => part === '.' || part === '..')) return 'Cloud URL path must be like /tmnode';
  return null;
}

/** Human-readable problems; empty means these settings can be written. */
export function settingsProblems(s: NodeSettings): string[] {
  const out: string[] = [];
  const fields: [string, string][] = [['SSID', s.ssid], ['Password', s.password], ['Gateway IP', s.gateway], ['Signing key', s.key], ['Cloud URL', s.cloudUrl]];
  // A line break would end the console line early and run the rest as a
  // second command; a control character has no business in any of these.
  for (const [name, value] of fields) if (/[\x00-\x1f\x7f]/.test(value)) out.push(`${name} cannot contain a line break or control character`);
  if (utf8(s.ssid) > MAX_SSID) out.push(`SSID is longer than ${MAX_SSID} bytes`);
  if (s.ssid.startsWith(' ') || s.ssid.endsWith(' ')) out.push('SSID starts or ends with a space');
  if (s.password && (utf8(s.password) < 8 || utf8(s.password) > MAX_PASSWORD)) out.push(`Wi-Fi password must be 8–${MAX_PASSWORD} characters (WPA2)`);
  if (s.gateway && !isIPv4(s.gateway)) out.push(`${gatewayName(s.mode)} IP “${s.gateway}” is not an IPv4 address`);
  if (utf8(s.key) > MAX_KEY) out.push(`Signing key is longer than ${MAX_KEY} bytes`);
  if (s.key.includes(' ')) out.push('Signing key cannot contain spaces');
  if (s.mode === 'lora' && s.transport === 'wss') out.push('LoRa has no direct-cloud transport; choose the local gateway');
  if (s.cloudUrl) {
    const problem = cloudUrlProblem(canonicalCloudUrl(s.cloudUrl));
    if (problem) out.push(problem);
  }
  return out;
}

export function nodeIdProblems(id: number | null): string[] {
  if (id === null) return ['Enter a node ID'];
  return Number.isInteger(id) && id >= MIN_NODE_ID && id <= MAX_NODE_ID ? [] : [`Node ID must be ${MIN_NODE_ID}–${MAX_NODE_ID}`];
}

/**
 * One line sent to the node's console, what a success looks like, and how it
 * may be shown in a log (secrets are masked).
 */
export interface ConsoleCommand {
  line: string;
  expect: string;
  display: string;
}

const command = (line: string, expect: string, display = line): ConsoleCommand => ({ line, expect, display });

/**
 * The console commands that apply `settings` and `id`, then save.
 *
 * `directCloud`: the firmware on the board understands `transport` and
 * `cloud_url` (its `show` lists capability wss1). Without it nothing about
 * transport is sent -- old firmware is UDP by definition -- and a request for
 * direct cloud is refused before any command, by the caller.
 */
export function provisioningCommands(id: number, s: NodeSettings, directCloud = false): ConsoleCommand[] {
  const out = [command(`set id ${id}`, 'id updated'), command(`set mode ${s.mode}`, 'mode updated')];
  if (s.mode === 'wifi') {
    if (s.ssid) out.push(command(`set ssid ${s.ssid}`, 'ssid updated'));
    if (s.password) out.push(command(`set pass ${s.password}`, 'pass updated', 'set pass ••••••'));
    if (s.gateway) out.push(command(`set edges ${s.gateway}`, 'edges updated'));
    if (directCloud) {
      // The URL first: the firmware refuses `transport wss` without one.
      const url = canonicalCloudUrl(s.cloudUrl);
      if (url) out.push(command(`set cloud_url ${url}`, 'cloud_url updated'));
      out.push(command(`set transport ${s.transport}`, 'transport updated'));
    }
  } else {
    // Leaving Wi-Fi: a node set to wss must go back to udp first, or the firmware refuses LoRa.
    if (directCloud) out.splice(1, 0, command('set transport udp', 'transport updated'));
    if (s.gateway) out.push(command(`set lora_gw ${s.gateway}`, 'lora_gw updated'));
  }
  if (s.key) out.push(command(`set key ${s.key}`, 'key updated', 'set key ••••••'));
  if (s.frameRate !== null) out.push(command(`set fps ${s.frameRate}`, 'fps updated'));
  out.push(command('save', 'saved'));
  return out;
}

/**
 * The secrets in these settings, for scrubbing anything about to be shown.
 * The firmware never prints them and the commands above mask them, so this
 * is the last of three guards rather than the only one.
 */
export function secretsOf(s: NodeSettings): string[] {
  return [s.password, s.key].filter((value) => value.length > 0);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('••••••');
  return out;
}
