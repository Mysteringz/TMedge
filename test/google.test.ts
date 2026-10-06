/**
 * "Continue with Google": the whole round trip against a stand-in for
 * Google's token endpoint, and every way a forged or stale answer is refused.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonStudentAccountRepository } from '../src/infrastructure/web/json-student-account-repository.js';
import { googleFromEnv } from '../src/web/google.js';
import { createWebApp, loadWebConfig } from '../src/web/main.js';

const CLIENT = '1234-test.apps.googleusercontent.com';
const REDIRECT = 'https://hkumyseat.com/auth/google/callback';

/** What Google's token endpoint would say for the code it issued. */
type Claims = Record<string, unknown>;
const jwt = (claims: Claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

async function start(opts: { signupOpen?: boolean; studentPersistenceMode?: 'file' | 'postgres' } = {}) {
  // Each test sets what the next token exchange returns, given the nonce the
  // browser carried to Google; `exchanges` records what we sent.
  let answer: (nonce: string) => Claims = () => ({});
  let lastNonce = '';
  const exchanges: URLSearchParams[] = [];
  const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
    exchanges.push(init.body);
    return new Response(JSON.stringify({ id_token: jwt(answer(lastNonce)) }), { status: 200 });
  }) as unknown as typeof fetch;
  const usersPath = join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json');
  const config = {
    port: 0, host: '127.0.0.1', pushToken: 'edge-token-for-tests-0123456789', sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath,
    allowedDomains: ['connect.hku.hk'], signupOpen: opts.signupOpen ?? true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
    google: { clientId: CLIENT, clientSecret: 'client-secret', redirectUri: REDIRECT, fetch: fakeFetch },
    studentPersistenceMode: opts.studentPersistenceMode,
  };
  const web = opts.studentPersistenceMode === 'postgres'
    ? createWebApp(config, { accounts: new JsonStudentAccountRepository(usersPath, ['connect.hku.hk']) })
    : createWebApp(config);
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;

  /** Click the button: returns the attempt cookie and the state/nonce Google was sent. */
  const begin = async (next = '/dashboard/spaces/') => {
    const res = await fetch(`${base}/auth/google?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get('location') ?? '');
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    lastNonce = to.searchParams.get('nonce') ?? '';
    return { to, cookie, state: to.searchParams.get('state') ?? '' };
  };
  /** Google redirects back. */
  const callback = (query: Record<string, string>, cookie: string) =>
    fetch(`${base}/auth/google/callback?${new URLSearchParams(query)}`, { redirect: 'manual', headers: { cookie } });
  const good = (nonce: string, more: Claims = {}): Claims => ({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-111', email: 'chan.taiman@gmail.com', email_verified: true,
    name: 'Chan Tai Man', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...more,
  });
  return {
    ...web, base, begin, callback, good, exchanges,
    answer: (f: (nonce: string) => Claims) => { answer = f; },
    close: () => new Promise<void>((r) => web.server.close(() => r())),
  };
}

test('google: any verified Google account signs in, lands where it was going, and can see the data', async () => {
  const w = await start();
  try {
    const { to, cookie, state } = await w.begin('/dashboard/spaces/');
    assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(to.searchParams.get('client_id'), CLIENT);
    assert.equal(to.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!to.toString().includes('client-secret'), 'the secret never goes to the browser');

    w.answer((n) => w.good(n));
    const back = await w.callback({ code: 'c1', state }, cookie);
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/dashboard/spaces/');
    const session = (back.headers.get('set-cookie') ?? '').match(/tm_session=[^;]+/)?.[0] ?? '';
    assert.ok(session, 'signed in');
    assert.equal(back.headers.get('cache-control'), 'no-store');

    // The exchange proved possession of the PKCE verifier and used our registered redirect.
    const sent = w.exchanges[0];
    assert.equal(sent?.get('redirect_uri'), REDIRECT);
    assert.ok((sent?.get('code_verifier') ?? '').length >= 32);

    // A gmail address: no university domain rule for Google.
    const me = await (await fetch(`${w.base}/api/me`, { headers: { cookie: session } })).json() as { email: string; name: string };
    assert.deepEqual(me, { email: 'chan.taiman@gmail.com', name: 'Chan Tai Man' });
    assert.equal((await fetch(`${w.base}/api/occupancy`, { headers: { cookie: session } })).status, 200);

    // A Google-only account has no password, so no password opens it.
    const pw = await fetch(`${w.base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'chan.taiman@gmail.com', password: '' }),
    });
    assert.equal(pw.status, 401);
  } finally {
    await w.close();
  }
});

test('google: a forged, replayed or foreign answer never signs anyone in', async () => {
  const w = await start();
  const refused = async (res: Response, why: string) => {
    assert.equal(res.status, 302, why);
    assert.match(res.headers.get('location') ?? '', /^\/login\/\?error=google/, why);
    assert.ok(!(res.headers.get('set-cookie') ?? '').includes('tm_session='), why);
  };
  try {
    w.answer((n) => w.good(n));
    let a = await w.begin();
    await refused(await w.callback({ code: 'c', state: a.state }, ''), 'no attempt cookie: started in another browser (login CSRF)');
    await refused(await w.callback({ code: 'c', state: 'not-the-state' }, a.cookie), 'state mismatch');
    await refused(await w.callback({ code: 'c', state: a.state }, a.cookie.slice(0, -3) + 'xyz'), 'tampered cookie');

    const cases: [string, (n: string) => Claims][] = [
      ['issued to another app', (n) => w.good(n, { aud: 'other.apps.googleusercontent.com' })],
      ['wrong issuer', (n) => w.good(n, { iss: 'https://evil.example' })],
      ['expired', (n) => w.good(n, { exp: Math.floor(Date.now() / 1000) - 10 })],
      ['nonce from another attempt', () => w.good('stale-nonce')],
      ['unverified email', (n) => w.good(n, { email_verified: false })],
    ];
    for (const [why, claims] of cases) {
      a = await w.begin();
      w.answer(claims);
      await refused(await w.callback({ code: 'c', state: a.state }, a.cookie), why);
    }
    assert.equal(w.users.size, 0);

    a = await w.begin();
    const cancel = await w.callback({ error: 'access_denied', state: a.state }, a.cookie);
    assert.equal(cancel.headers.get('location'), '/login/?error=google_cancelled');
  } finally {
    await w.close();
  }
});

test('google: malformed issue time, authorized party and subject are refused', async () => {
  const w = await start();
  try {
    for (const fields of [{ iat: Math.floor(Date.now() / 1000) + 600 }, { azp: 'other.apps.googleusercontent.com' }, { sub: 'x'.repeat(256) }]) {
      w.answer((n) => w.good(n, fields));
      const a = await w.begin();
      const result = await w.callback({ code: 'code', state: a.state }, a.cookie);
      assert.equal(result.headers.get('location'), '/login/?error=google');
      assert.ok(!(result.headers.get('set-cookie') ?? '').includes('tm_session='));
    }
  } finally { await w.close(); }
});

test('google: a matching email cannot auto-link an unverified password account', async () => {
  const w = await start();
  try {
    const signup = await fetch(`${w.base}/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u3587219', name: 'Password Person', password: 'a-long-enough-pin' }),
    });
    assert.equal(signup.status, 200);
    w.answer((n) => w.good(n, { sub: 'g-222', email: 'u3587219@connect.hku.hk' }));
    const a = await w.begin();
    const callback = await w.callback({ code: 'c', state: a.state }, a.cookie);
    assert.equal(callback.headers.get('location'), '/login/?error=google_taken');
    assert.ok(!(callback.headers.get('set-cookie') ?? '').includes('tm_session='));
    assert.equal(w.users.size, 1);
    assert.equal(w.users.get('u3587219@connect.hku.hk')?.google, undefined);
    const pw = await fetch(`${w.base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u3587219', password: 'a-long-enough-pin' }),
    });
    assert.equal(pw.status, 200, 'its original sign-in method is preserved');
  } finally { await w.close(); }
});

test('google: an established subject finds the same account after its email changes', async () => {
  const w = await start();
  try {
    w.answer((n) => w.good(n));
    let a = await w.begin();
    assert.equal((await w.callback({ code: 'first', state: a.state }, a.cookie)).headers.get('location'), '/dashboard/spaces/');
    w.answer((n) => w.good(n, { email: 'changed@example.com' }));
    a = await w.begin();
    const callback = await w.callback({ code: 'second', state: a.state }, a.cookie);
    assert.equal(callback.headers.get('location'), '/dashboard/spaces/');
    assert.equal(w.users.size, 1);
    assert.equal(w.users.get('chan.taiman@gmail.com')?.google, 'g-111');
    assert.equal(w.users.get('changed@example.com'), undefined);
  } finally { await w.close(); }
});

test('google: with sign-up closed, only existing accounts get in', async () => {
  const w = await start({ signupOpen: false });
  try {
    w.answer((n) => w.good(n));
    const a = await w.begin();
    assert.equal((await w.callback({ code: 'c', state: a.state }, a.cookie)).headers.get('location'), '/login/?error=google_closed');
    assert.equal(w.users.size, 0);
  } finally {
    await w.close();
  }
});

test('google: the shell says whether the button is on; off, its routes do not exist', async () => {
  const on = await start();
  try {
    assert.match(await (await fetch(`${on.base}/login/`)).text(), /<meta name="google" content="on">/);
  } finally {
    await on.close();
  }
  const web = createWebApp({
    port: 0, host: '127.0.0.1', pushToken: 'edge-token-for-tests-0123456789', sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(mkdtempSync(join(tmpdir(), 'tmweb-')), 'users.json'),
    allowedDomains: ['connect.hku.hk'], signupOpen: true, cookieSecure: false, trustProxy: false, staleMs: 30_000,
  });
  await new Promise<void>((r) => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  try {
    assert.match(await (await fetch(`${base}/login/`)).text(), /<meta name="google" content="">/);
    assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 404);
  } finally {
    await new Promise<void>((r) => web.server.close(() => r()));
  }
});

test('google: PostgreSQL mode hides Google sign-in and both OAuth routes return 404', async () => {
  const w = await start({ studentPersistenceMode: 'postgres' });
  try {
    assert.match(await (await fetch(`${w.base}/login/`)).text(), /<meta name="google" content="">/);
    assert.equal((await fetch(`${w.base}/auth/google`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${w.base}/auth/google/callback?code=unused&state=unused`, { redirect: 'manual' })).status, 404);
  } finally {
    await w.close();
  }
});

test('google config is all three settings or none, and refuses a redirect it cannot use', () => {
  assert.equal(googleFromEnv({}), null);
  const ok = { GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REDIRECT_URI: REDIRECT };
  assert.deepEqual(googleFromEnv(ok), { clientId: CLIENT, clientSecret: 'x', redirectUri: REDIRECT });
  assert.throws(() => googleFromEnv({ ...ok, GOOGLE_CLIENT_SECRET: '' }), /together/);
  assert.throws(() => googleFromEnv({ ...ok, GOOGLE_CLIENT_ID: 'not-a-client' }), /client ID/);
  assert.throws(() => googleFromEnv({ ...ok, GOOGLE_REDIRECT_URI: 'http://hkumyseat.com/auth/google/callback' }), /https/);
  assert.throws(() => googleFromEnv({ ...ok, GOOGLE_REDIRECT_URI: 'https://hkumyseat.com/elsewhere' }), /callback/);
  assert.ok(googleFromEnv({ ...ok, GOOGLE_REDIRECT_URI: 'http://localhost:8080/auth/google/callback' }), 'local development');
  for (const uri of ['ftp://localhost/auth/google/callback', 'https://user:pass@hkumyseat.com/auth/google/callback', REDIRECT + '?extra=1', REDIRECT + '#fragment']) {
    assert.throws(() => googleFromEnv({ ...ok, GOOGLE_REDIRECT_URI: uri }));
  }
  const base = { WEB_PUSH_TOKEN: 'edge-token-for-tests-0123456789', SESSION_SECRET: 's'.repeat(40) };
  assert.equal(loadWebConfig(base).google, null);
  assert.equal(loadWebConfig({ ...base, ...ok }).google?.clientId, CLIENT);
});
