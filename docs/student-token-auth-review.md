# Student bearer authentication review

## Scope and decisions

Added external HTTP API access for student accounts on `feat/token-auth`.
Browser sessions remain HttpOnly cookies. External access uses the existing
signed-token implementation with a separate purpose-derived HMAC key and a
15-minute lifetime. No dependencies, environment variables, database schema
changes, frontend changes, or algo authentication changes were introduced.

The first version provides credential login and per-token revocation. It does
not provide refresh tokens, third-party OAuth consent, browser CORS access, or
bearer WebSocket authentication. Turnstile remains required when configured.
These constraints are described in `docs/student-token-auth.md`.

Existing project conventions were retained: Express router factories, injected
account repositories, typed async error middleware, the established JSON response
shapes, and Node's test runner. The generic skill examples mention other runners
and response envelopes; changing those here would affect unrelated code.

## Self-review

- Protected student HTTP routes share one credential resolver and guard.
- A supplied Authorization header cannot fall back to a cookie. Mixed student
  credentials and malformed headers return 400.
- Signature, expiry, revocation and current account version are checked. The
  credential is checked again after asynchronous account lookup to prevent a
  revoked or expired token finishing authorization.
- Cookie renewal still works; bearer requests do not receive renewed cookies.
- Student access tokens cannot replace cookie sessions or edge credentials.
- Revocation uses a separate durable file and existing bounded revocation logic.
- Login rate limits and human verification are shared with browser login.
- Token responses and protected API responses prohibit caching. Authorization
  participates in Vary. Tokens and credentials are excluded from activity logs.
- The small Windows persistence fix skips unsupported directory fsync only on
  Windows, preserving file fsync, atomic replacement, and POSIX directory fsync.
- File-account changes require a web restart under the existing JSON repository;
  PostgreSQL account reads are asynchronous and performed per request.

Scoped correctness, security, architecture, and test self-review: PASS.
This is a self-review, not an independent agent QA verdict or a production audit.

## Verification

Passed:

```text
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.console.json --noEmit
node web-app/node_modules/typescript/bin/tsc --noEmit -p web-app/tsconfig.json
node --test --test-concurrency=1 dist/test/student-bearer-auth.test.js dist/test/student-auth-activity.test.js dist/test/student-usage-activity.test.js dist/test/web.test.js
git diff --check
```

The selected regression run passed 56 tests with zero failures or skips.
The new tests cover issuance, supported API access, cache headers, cookie
compatibility and renewal, mixed/malformed credentials, token expiry, restart
revocation, account versions, secret rotation, human checks, shared rate limits,
safe storage errors, and revocation during an asynchronous lookup.

Broader checks attempted but incomplete:

- `dist/test/algoauth.test.js`: nine existing runtime-based cases fail during
  edge startup on Windows directory fsync in `src/edge/replay.ts`; four pass.
- Algo frontend typecheck: installed dependencies lack CodeMirror, Lezer and
  xterm packages referenced by unchanged editor/terminal code.
- Real PostgreSQL integration and browser UI E2E were not run. The feature uses
  the existing account repository contract, and HTTP tests cover browser-cookie
  compatibility without modifying UI behavior.

No deployment, commit, or push was performed.

## References

- [Integration guide](student-token-auth.md)
- [OpenAPI contract](student-token-auth.openapi.yaml)
- [Bearer transport specification](https://www.rfc-editor.org/rfc/rfc6750.html)

## Change history

- 2026-10-09: Added initial student HTTP bearer access, integration documentation,
  regression coverage, and scoped review evidence.
