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

/**
 * One route parameter as a string. Express 5 types a parameter as
 * `string | string[]` (a named wildcard matches many segments); every route
 * here takes single segments, so anything else reads as empty -- the route
 * then answers "not found" rather than coercing a list into an id.
 */
export function routeParam(params: Record<string, string | string[] | undefined>, name: string): string {
  const v = params[name];
  return typeof v === 'string' ? v : '';
}
