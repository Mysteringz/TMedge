# Backend integration QA handoff

## Status

**Open. Phase 6.3 is not complete.** The feature branch has been merged into the working tree with `origin/main` (`cc219ca`), but Git still reports 21 unresolved index entries. The merge has not been committed, pushed, or opened as a pull request.

## Changes and checks completed in this integration pass

- Preserved the stable Google OpenID Connect subject (`sub`) as the account identity. Existing subjects resolve to the same account after an email change; a matching email alone never links an account.
- Added an additive PostgreSQL migration for the nullable Google subject and passwordless Google accounts. The down migration refuses rollback while Google identities remain.
- Bound student sessions to an account credential fingerprint and persisted logout revocations.
- Bound occupancy WebSocket clients to the authenticated account session and close them on logout.
- Added a disposal path for the console feed hosted by the algo server. It removes runtime listeners, clears its timer, terminates feed sockets, and closes its WebSocket server.
- `npm run typecheck` — passed.
- `npm run build` — passed, including both web and algo client builds.
- Targeted account, private-store, and PostgreSQL foundation tests — 21 passed.
- Targeted web navigation/configuration tests — 2 passed.
- `git diff --check` — passed.
- Full `npm test` — 346 tests: 213 passed, 127 failed, 6 skipped. Of the failures, 103 report `listen EPERM` on `127.0.0.1`.

## Required evidence still missing

- Resolve and stage all 21 merge conflicts, then review the complete merge diff.
- Run the full test suite, including Google OAuth HTTP and console WebSocket integration tests. In this sandbox those tests fail at server startup with `listen EPERM` on `127.0.0.1`; an escalated rerun was denied by automatic review, so no route-level result is available.
- Triage the remaining full-suite failures that are not explained by loopback restrictions: an algo test that does not configure the now-required session secret; the missing TMsense detector checkout; registry import/export losing the `edge` detector setting; rollout dispatch/cancellation state assertions; and a firmware upload test whose fixture uses a disallowed Markdown file.
- Run the PostgreSQL integration suite against a disposable PostgreSQL instance, including applying and reverting the Google migration.
- Obtain the sibling TMsense and TMWAccess repositories at the references recorded under `ci/` and run the cross-repository checks. Those checkouts are absent in this workspace.
- Verify Linux worker isolation and SIGTERM handling, then rehearse backup restore and rollback.
- After those checks, commit, push, and open the review request required by the handoff.

## Gate

Do not mark 6.3 complete until the outstanding full-suite failures are triaged, the required integration evidence is recorded, and the review request is opened. The merge is committed locally but has not been pushed. No production deployment was performed.
