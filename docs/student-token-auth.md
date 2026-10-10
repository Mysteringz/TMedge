# Student bearer authentication

External native apps and server-side integrations can authenticate student HTTP
API requests with an access token. Browser login continues using `tm_session`.
This initial integration is intended for apps you control. It does not implement
third-party OAuth consent, refresh tokens, or cross-origin browser access.

## Obtain a token

Send student credentials to the student web server over HTTPS:

```http
POST /api/auth/token
Content-Type: application/json

{"email":"u3587219","password":"YOUR_PIN"}
```

A full email address also works. UID expansion, account verification, login rate
limiting, and optional Turnstile follow the existing browser login rules. When
Turnstile is configured, include `cf-turnstile-response` solved for the `login`
action on an allowed hostname. A native client needs an interactive web view for
that challenge; this endpoint does not bypass it for automated clients.

Successful response:

```json
{
  "access_token": "SIGNED_ACCESS_TOKEN",
  "token_type": "Bearer",
  "expires_in": 900
}
```

The response sets no session cookie and uses `Cache-Control: no-store` and
`Pragma: no-cache`. Treat the token as an opaque credential: it uses TMedge's
existing signed-token format, not JWT. Its payload is signed, not encrypted, and
must not be logged or shared. Store it in the native platform's secure credential
storage or in a protected server-side store.

Tokens expire after 15 minutes. Authenticate again to obtain a new token; this
version does not issue refresh tokens. Passwordless Google accounts cannot use
password-based token login.

## Call student APIs

```http
GET /api/occupancy
Authorization: Bearer SIGNED_ACCESS_TOKEN
```

The shared student guard accepts bearer credentials for `/api/me`,
`/api/occupancy`, `/api/search?seats=2`, and `/api/activity`. Activity writes still
require JSON and `X-TM-Student-Activity: 1`; their origin, request metadata, body
validation, and rate limits remain in force. Native and server-side clients may
omit browser Origin and Fetch Metadata headers.

Bearer access does not authenticate HTML pages or WebSocket upgrades. Tokens in
URL parameters or request bodies are not used for authentication. Keep browser
requests on cookies and external HTTP API requests on Authorization headers.
Requests containing both a `tm_session` cookie and an Authorization header are
rejected with 400, even if both credentials refer to the same account. Unrelated
cookies, such as analytics cookies, do not interfere.

Malformed Authorization headers return 400. Invalid, expired, revoked, or
wrong-purpose access tokens return 401 with a Bearer `WWW-Authenticate` header.
Account storage failures fail closed. API responses include `Vary: Cookie,
Authorization` and `Cache-Control: no-store`.

## Revoke the current token

```http
DELETE /api/auth/token
Authorization: Bearer SIGNED_ACCESS_TOKEN
```

A successful response is 204 with no body. Revoke while the token is still valid;
an expired or previously revoked token returns 401. Revocation affects only this
access token, not browser sessions or other tokens. Browser logout likewise
revokes only its cookie session. Local removal of an access token is not server
revocation.

## Storage and separation

The server derives a separate access-token signing key from `SESSION_SECRET`
using the purpose `tmedge-student-access-v1`. No new environment variable or
database migration is needed. Student access tokens cannot substitute for
browser cookies, engineer sessions, or edge publisher credentials. Rotating
`SESSION_SECRET` invalidates browser sessions and student access tokens.

Revocations persist to `student-token-revocations.json` beside `USERS_FILE`,
including when accounts use PostgreSQL. Multiple web instances must share that
revocation file and signing secret to share revocations. Damaged or unreadable
revocation state fails closed. File-backed account
changes become visible after restarting the web server; PostgreSQL-backed
accounts are looked up for every authenticated request. Tokens bind to the
current account version, so a removed account or changed password invalidates
its tokens once that change is visible to the repository.

Login attempts share the existing browser login rate limiter. Login and revoke
events use the existing activity pipeline without recording raw tokens or
passwords. An external web browser hosted on another origin needs a separately
designed CORS and authorization flow; this feature adds no CORS allowlist.

The machine-readable endpoint contract is in
[student-token-auth.openapi.yaml](student-token-auth.openapi.yaml).
