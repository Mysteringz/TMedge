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
  adminPassword: string | null;
  pushUrls: string[];
  pushToken: string;
  publishMs: number;
}

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
    // Without a password the console shows raw thermal frames to anyone who
    // can reach it, so it is then only reachable from this machine.
    consoleHost: env.CONSOLE_HOST || (adminPassword ? '0.0.0.0' : '127.0.0.1'),
    adminPassword,
    pushUrls,
    pushToken,
    publishMs: int(env, 'PUBLISH_MS', 2000, 200, 60000),
  };
}
