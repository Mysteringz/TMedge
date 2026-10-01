# Task 4.2 execution ledger

Plan: `docs/superpowers/plans/2026-10-01-registration-provisioning-audit-schema.md` (local only; ignored by Git)
Base branch: `feat/edge-persistence`

## Plan alignment

- Task 4.2 subtask 1 maps to explicit PostgreSQL indexes, foreign keys, uniqueness, and checks, including pending/terminal provisioning request expiry and state consistency; the integration test will prove these constraints against real PostgreSQL.
- Task 4.2 subtask 2 maps to existing `buildRegistry` application validation plus an unknown-floor regression assertion; floor/table geometry remains static JSON and is not incorrectly represented by database geometry constraints.
- Definition of Done includes unplaced identities, duplicate/ownership rejection, exact identifier preservation, real-database migration and constraint tests, behavior tests, developer review, tester QA PASS, and indexed QA evidence.
- Ruling: the plan needed explicit expiry/state-transition coverage and a mandatory tester QA report before commit. Added both to the local-only plan before implementation.

## Work items

- [x] Add unknown static-layout floor regression assertion.
- [x] Add real-PostgreSQL schema and expiry/state tests; observe expected RED (the missing migration prevented the second migration from running).
- [x] Implement reversible registration/provisioning/audit migration.
- [x] Run focused PostgreSQL, typecheck, full test suite, and build checks.
- [x] Write evidence and receive tester QA PASS.
- [x] Update task trackers; commit Task 4.2 product/test/evidence changes separately and never include `docs/superpowers/`.

## Results

- `npm run typecheck`: PASS.
- Focused PostgreSQL 17 integration: PASS; migration up/down verified and constraint failures matched expected SQLSTATEs. Exact UID, `iw-maker-a` floor ID, `M3` table ID, and audit subject ID all read back unchanged.
- `npm run build`: PASS.
- Full `npm test`: 142 passed, 3 failed, 4 skipped. Failures: `algo debugger preserves authenticated APIs and owns its WebSocket lifecycle` (expected 3, got 1); `nobody has vendored a second copy of the detector into this repo` (missing sibling `../TMsense`); `edge shutdown closes live console sockets, stops a build, and flushes recording` (expected 3, got 2). Both timing failures reproduce when isolated; the Task 4.2 integration test passes in the full run.
- Tester QA: PASS after reviewing the exact floor/table readback assertions.
- Official docs were consulted because Context7 was unavailable; links are recorded in `qa-report.md`.
