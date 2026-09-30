import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Indicates a student account input or credential rule failure. */
export class AuthError extends Error {}

/** Issues and validates the stateless signed cookie used by student sessions. */
export class Sessions {
  constructor(private readonly secret: Buffer, private readonly ttlMs = 14 * 24 * 3600 * 1000) {}

  issue(email: string, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ e: email, x: now + this.ttlMs })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  get ttl(): number {
    return this.ttlMs;
  }

  read(token: string | undefined, now = Date.now()): string | null {
    return this.detail(token, now)?.email ?? null;
  }

  detail(token: string | undefined, now = Date.now()): { email: string; expiresAt: number } | null {
    if (!token) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const { e, x } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e: string; x: number };
      if (typeof e !== 'string' || typeof x !== 'number' || x <= now) return null;
      return { email: e, expiresAt: x };
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

/** Fixed-window limiter for login attempts, keyed by client address. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const hit = this.hits.get(key);
    if (!hit || hit.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    hit.n += 1;
    return hit.n <= this.max;
  }
}

/** Parses a Cookie header without introducing a framework dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
