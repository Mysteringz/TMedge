# Task 4.2 Verification Evidence

Date: 2026-10-01 (Asia/Hong_Kong)

## Successful checks

- Type check: `npm run typecheck` — PASS (root, console, web app, and algo app).
- Focused real-database test: compile with `npx tsc -p tsconfig.json`, then run `node --test dist/test/postgres-integration.test.js` with `PG_INTEGRATION_TEST=1` against the repository's loopback-only PostgreSQL 17 test service — PASS (1 test).
- Build: `npm run build` — PASS (TypeScript, web app, and algo app builds).
- Diff whitespace check: `git diff --check` — PASS.

The PostgreSQL test applies both the foundation probe and schema migration, exercises constraint successes/failures with SQLSTATE assertions, rolls back test rows, and successfully reverts both migrations. It verifies unchanged MAC UID, floor ID, table ID, and audit subject text; identity-only nodes; unique keys and foreign keys; request expiry and state consistency; audit actor enum; runtime DDL denial; and repeatable runtime-pool close.

## Full repository test suite

Command: `npm test` with `PG_INTEGRATION_TEST=1` and the documented local test-database credentials — 149 tests total: 142 passed, 3 failed, 4 skipped.

Failures, confirmed outside Task 4.2:

1. `algo debugger preserves authenticated APIs and owns its WebSocket lifecycle` — expected 3 messages, got 1; reproduces when run alone.
2. `nobody has vendored a second copy of the detector into this repo` — required sibling `../TMsense` checkout is unavailable.
3. `edge shutdown closes live console sockets, stops a build, and flushes recording` — expected 3 messages, got 2; reproduces when run alone.

The full suite's four skips are environment-gated tests (firmware detector/worker requirements). The Task 4.2 PostgreSQL integration test passes in the same full-suite run.
