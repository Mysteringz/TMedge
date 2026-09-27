/**
 * Edge settings, all from the environment (or .env, loaded by npm scripts).
 * Nothing secret is ever logged.
 */
import { hostname } from 'node:os';

export interface EdgeConfig {
  edgeId: string;
  keys: Buffer[];
  allowUnsigned: boolean;
  udpPort: number;
  udpHost: string;
  sitePath: string;
  nodesPath: string;
  dataDir: string;
  recordRaw: boolean;
  consolePort: number;
  consoleHost: string;
  /** The algo debugger, 0 to leave it off. Same password and bind rule as the console. */
  algoPort: number;
  adminPassword: string | null;
  pushUrls: string[];
  pushToken: string;
  publishMs: number;
  /** TCP port for access gateways (TMWAccess / TMLAccess); 0 disables. */
  gatewayPort: number;
  gatewayToken: Buffer | null;
  /**
   * Direct node listener (docs/DIRECT_NODE_PROTOCOL.md): TMsense nodes that
   * reach this edge themselves over WSS, through the tunnel. Port 0 = off.
   */
  nodeHost: string;
  nodePort: number;
  nodeLimits: NodeListenerLimits;
  /** Test only: serve the node listener over TLS itself (PEM paths). Production terminates TLS at Cloudflare. */
  nodeTls: { certPath: string; keyPath: string } | null;
}

export interface NodeListenerLimits {
  /** Authenticated sessions at once. */
  maxSessions: number;
  /** Unauthenticated handshakes at once, in total and from one source. */
  maxPending: number;
  maxPendingPerSource: number;
  /** Upgrades one source may attempt per minute. */
  upgradesPerMinute: number;
  /** Per node: messages and bytes per second (token bucket, 2 s of burst). */
  messagesPerSec: number;
  bytesPerSec: number;
  /** How long an OTA download grant stays usable. */
  grantMs: number;
}

export const DEFAULT_NODE_LIMITS: NodeListenerLimits = {
  maxSessions: 256,
  maxPending: 64,
  maxPendingPerSource: 8,
  upgradesPerMinute: 60,
  // A node at its fastest refresh (8 fps) with RAW every frame sends about
  // 17 messages and 8 kB a second; these leave room for that and no more.
  messagesPerSec: 40,
  bytesPerSec: 32768,
  grantMs: 600_000,
};

export class EnvError extends Error {}

function int(env: NodeJS.ProcessEnv, k: string, def: number, min: number, max: number): number {
  const raw = env[k];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new EnvError(`${k} must be an integer ${min}..${max}, got "${raw}"`);
  return v;
}

export function loadEdgeConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const key = env.TM_KEY ?? '';
  const allowUnsigned = env.ALLOW_UNSIGNED === '1';
  if (!key && !allowUnsigned) {
    throw new EnvError('TM_KEY is not set. Set it to the key the nodes sign with, or ALLOW_UNSIGNED=1 for a bench test.');
  }
  // During a key rotation the edge accepts both; nodes are re-keyed one by one.
  const keys = [key, env.TM_KEY_PREVIOUS ?? ''].filter((k) => k.length > 0).map((k) => Buffer.from(k, 'utf8'));

  const adminPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null;
  const pushUrls = (env.WEB_PUSH_URLS ?? 'http://127.0.0.1:8080').split(',').map((s) => s.trim()).filter(Boolean);
  for (const u of pushUrls) {
    try {
      new URL(u);
    } catch {
      throw new EnvError(`WEB_PUSH_URLS: "${u}" is not a URL`);
    }
  }
  const pushToken = env.WEB_PUSH_TOKEN ?? '';
  if (pushUrls.length > 0 && pushToken.length < 16) {
    throw new EnvError('WEB_PUSH_TOKEN must be set (16+ chars) when WEB_PUSH_URLS is; the web tier rejects unauthenticated snapshots.');
  }

  const nodePort = int(env, 'NODE_PORT', 0, 0, 65535);
  if (nodePort > 0 && keys.length === 0) {
    // ALLOW_UNSIGNED is a bench convenience for UDP; a node reaching the edge
    // over the internet authenticates with the key or not at all.
    throw new EnvError('NODE_PORT is set but TM_KEY is not: the direct node listener always requires a signing key.');
  }
  const certPath = env.NODE_TLS_CERT ?? '';
  const keyPath = env.NODE_TLS_KEY ?? '';
  if ((certPath === '') !== (keyPath === '')) throw new EnvError('NODE_TLS_CERT and NODE_TLS_KEY go together (test only)');

  return {
    edgeId: env.EDGE_ID || hostname(),
    keys,
    allowUnsigned,
    udpPort: int(env, 'UDP_PORT', 5200, 1, 65535),
    udpHost: env.UDP_HOST || '0.0.0.0',
    sitePath: env.SITE_CONFIG || 'config/site.json',
    nodesPath: env.NODES_CONFIG || 'config/nodes.json',
    dataDir: env.DATA_DIR || 'data',
    recordRaw: env.RECORD_RAW === '1',
    consolePort: int(env, 'CONSOLE_PORT', 8090, 1, 65535),
    algoPort: int(env, 'ALGO_PORT', 8091, 0, 65535),
    // Without a password the console shows raw thermal frames to anyone who
    // can reach it, so it is then only reachable from this machine.
    consoleHost: env.CONSOLE_HOST || (adminPassword ? '0.0.0.0' : '127.0.0.1'),
    adminPassword,
    pushUrls,
    pushToken,
    publishMs: int(env, 'PUBLISH_MS', 2000, 200, 60000),
    gatewayPort: int(env, 'GATEWAY_PORT', 5210, 0, 65535),
    gatewayToken: (() => {
      const t = env.TMGW_TOKEN ?? '';
      if (t && t.length < 16) throw new EnvError('TMGW_TOKEN must be 16+ chars');
      return t ? Buffer.from(t, 'utf8') : null;
    })(),
    // Loopback: in production cloudflared is the only thing that should reach it.
    nodeHost: env.NODE_HOST || '127.0.0.1',
    nodePort,
    nodeLimits: {
      maxSessions: int(env, 'NODE_MAX_SESSIONS', DEFAULT_NODE_LIMITS.maxSessions, 1, 5000),
      maxPending: int(env, 'NODE_MAX_PENDING', DEFAULT_NODE_LIMITS.maxPending, 1, 5000),
      maxPendingPerSource: int(env, 'NODE_MAX_PENDING_PER_SOURCE', DEFAULT_NODE_LIMITS.maxPendingPerSource, 1, 5000),
      upgradesPerMinute: int(env, 'NODE_UPGRADES_PER_MIN', DEFAULT_NODE_LIMITS.upgradesPerMinute, 1, 100000),
      messagesPerSec: int(env, 'NODE_MSGS_PER_SEC', DEFAULT_NODE_LIMITS.messagesPerSec, 1, 10000),
      bytesPerSec: int(env, 'NODE_BYTES_PER_SEC', DEFAULT_NODE_LIMITS.bytesPerSec, 1024, 10_000_000),
      grantMs: int(env, 'NODE_GRANT_MS', DEFAULT_NODE_LIMITS.grantMs, 10_000, 3_600_000),
    },
    nodeTls: certPath ? { certPath, keyPath } : null,
  };
}
