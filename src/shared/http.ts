import type { IncomingMessage } from 'node:http';

/** Parse direct-server request targets without letting a malformed URL throw out of a socket callback. */
export function requestUrl(raw: string | undefined): URL | null {
  if (!raw?.startsWith('/') || raw.startsWith('//')) return null;
  try { return new URL(raw, 'http://local'); } catch { return null; }
}

/** Browsers send Origin on WebSocket upgrades; CLI/device clients may omit it. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host === req.headers.host;
  } catch { return false; }
}
