/**
 * "Continue with Google": OpenID Connect, authorization-code flow with PKCE,
 * done entirely on the server with node:crypto and fetch (the web tier's
 * runtime deps stay express and ws).
 *
 * The browser only ever carries two things: a redirect to Google, and a short
 * signed cookie holding this attempt's state, nonce, PKCE verifier and where
 * to go afterwards. The code Google sends back is exchanged with the client
 * secret over TLS straight to Google's token endpoint, so the ID token in that
 * answer came from Google itself (OIDC Core 3.1.3.7 allows TLS to stand in for
 * the signature check in exactly this case). Its claims are still checked:
 * issuer, audience, expiry, our nonce, and a verified email.
 *
 * Any Google account may sign in -- unlike the password form, which is held
 * to ALLOWED_EMAIL_DOMAINS. What identifies the person is Google's `sub`;
 * the email is only how the account is keyed and shown.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeNext } from './navigation.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Long enough to pick an account and pass 2-step verification; no longer. */
const ATTEMPT_MS = 10 * 60_000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Exactly as registered on the OAuth client, e.g. https://hkumyseat.com/auth/google/callback */
  redirectUri: string;
  /** Replaces the call to Google's token endpoint in tests. */
  fetch?: typeof fetch;
}

/** Who Google says signed in. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/**
 * Why a sign-in was refused. `reason` goes to the server log; the student
 * only sees `code`, which the login page turns into a sentence.
 */
export class GoogleError extends Error {
  constructor(readonly code: 'cancelled' | 'failed', readonly reason: string) {
    super(reason);
  }
}

/**
 * All three or none, for the same reason as Turnstile: a half-made setup would
 * draw a button that can only fail.
 */
export function googleFromEnv(env: NodeJS.ProcessEnv): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim() ?? '';
  if (!clientId && !clientSecret && !redirectUri) return null;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI together, or none of them');
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error('GOOGLE_CLIENT_ID does not look like a Google OAuth client ID');
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error('GOOGLE_REDIRECT_URI must be an absolute URL');
  }
  if (url.pathname !== '/auth/google/callback' || url.search || url.hash || url.username || url.password) throw new Error('GOOGLE_REDIRECT_URI must end in /auth/google/callback without credentials, query or fragment');
  // Google itself only allows http for localhost; say so here rather than on Google's error page.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('GOOGLE_REDIRECT_URI must be https (http only for localhost)');
  }
  return { clientId, clientSecret, redirectUri };
}

interface Attempt { s: string; n: string; v: string; next: string; x: number }

export class GoogleLogin {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GoogleConfig, private readonly secret: Buffer) {
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  /** Where to send the browser, and the cookie that remembers this attempt. */
  begin(next: string, now = Date.now()): { url: string; cookie: string } {
    const attempt: Attempt = { s: rnd(), n: rnd(), v: rnd(), next: safeNext(next), x: now + ATTEMPT_MS };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: attempt.s,
      nonce: attempt.n,
      code_challenge: createHash('sha256').update(attempt.v).digest('base64url'),
      code_challenge_method: 'S256',
      // A shared lab machine is signed in to somebody's Google already: ask.
      prompt: 'select_account',
    }).toString();
    const body = Buffer.from(JSON.stringify(attempt)).toString('base64url');
    return { url: url.toString(), cookie: `${body}.${this.mac(body)}` };
  }

  /**
   * Google's redirect back, checked against the cookie from begin(). Returns
   * the identity and the page the student was headed for, or throws.
   */
  async finish(query: Record<string, unknown>, cookie: string | undefined, now = Date.now()): Promise<GoogleIdentity & { next: string }> {
    if (query.error === 'access_denied') throw new GoogleError('cancelled', 'the student declined on Google\'s consent screen');
    if (typeof query.error === 'string') throw new GoogleError('failed', `Google returned error ${JSON.stringify(query.error)}`);
    const attempt = this.readAttempt(cookie, now);
    // state ties this redirect to the browser that started it: without it, an
    // attacker could sign a student in to the attacker's account (login CSRF).
    if (typeof query.state !== 'string' || !same(query.state, attempt.s)) throw new GoogleError('failed', 'state does not match this browser\'s attempt');
    if (typeof query.code !== 'string' || !query.code || query.code.length > 2048) throw new GoogleError('failed', 'no authorization code');

    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        body: new URLSearchParams({
          code: query.code,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          redirect_uri: this.cfg.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: attempt.v,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new GoogleError('failed', `token endpoint unreachable (${(err as Error).message})`);
    }
    const out = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
    // Google's codes (invalid_grant, invalid_client, redirect_uri_mismatch) name the cause.
    if (!res.ok) throw new GoogleError('failed', `token endpoint answered HTTP ${res.status} ${JSON.stringify(out.error ?? '')}`);
    if (typeof out.id_token !== 'string' || out.id_token.length > 16_384) throw new GoogleError('failed', 'token response has no valid id_token');

    const claims = decodeJwtPayload(out.id_token);
    if (!claims) throw new GoogleError('failed', 'id_token is not a JWT');
    if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) throw new GoogleError('failed', `id_token issuer ${JSON.stringify(claims.iss)}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.every((a) => typeof a === 'string') || !aud.includes(this.cfg.clientId)) throw new GoogleError('failed', 'id_token was issued to another client');
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== this.cfg.clientId) throw new GoogleError('failed', 'id_token azp is another client');
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new GoogleError('failed', 'id_token has expired');
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat * 1000 > now + 60_000) throw new GoogleError('failed', 'id_token has invalid issue time');
    if (typeof claims.nonce !== 'string' || !same(claims.nonce, attempt.n)) throw new GoogleError('failed', 'id_token nonce does not match');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleError('failed', 'id_token has no valid subject');
    if (typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claims.email) || claims.email_verified !== true) {
      throw new GoogleError('failed', 'Google account has no verified email');
    }
    const name = typeof claims.name === 'string' ? claims.name : '';
    return { sub: claims.sub, email: claims.email, name, next: attempt.next };
  }

  private readAttempt(cookie: string | undefined, now: number): Attempt {
    if (!cookie || cookie.length > 4096 || cookie.split('.').length !== 2) throw new GoogleError('failed', 'invalid attempt cookie');
    const [body, mac] = cookie.split('.');
    if (!body || !mac || !same(mac, this.mac(body))) throw new GoogleError('failed', 'no sign-in attempt cookie (expired, or started in another browser)');
    let a: Attempt;
    try {
      a = JSON.parse(Buffer.from(body, 'base64url').toString()) as Attempt;
    } catch {
      throw new GoogleError('failed', 'unreadable attempt cookie');
    }
    if (typeof a.x !== 'number' || !Number.isFinite(a.x) || a.x <= now || a.x > now + ATTEMPT_MS ||
        ![a.s, a.n, a.v].every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v)) ||
        typeof a.next !== 'string' || safeNext(a.next) !== a.next) throw new GoogleError('failed', 'sign-in attempt expired or invalid');
    return a;
  }

  // A different key from the session cookie's, so neither cookie can ever
  // pass for the other even though both are signed with SESSION_SECRET.
  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(`google-attempt:${body}`).digest('base64url');
  }
}

function rnd(): string {
  return randomBytes(24).toString('base64url');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  const part = parts[1]!;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString()) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
