# Backend integration QA handoff

## Status

**Open. Phase 6.3 is not complete.** The feature branch has been merged with `origin/main` (`cc219ca`) and the merge is committed locally. The branch has not been pushed or opened as a pull request.

## Changes and checks completed in this integration pass

- Google sign-in is deliberately disabled in PostgreSQL mode for now. Its button is hidden, and both OAuth endpoints return 404 regardless of configured Google credentials.
- The additive Google identity migration and repository path remain in source for future work; the migration does not turn on OAuth. PostgreSQL-backed Google sign-in must stay disabled until its integration and recovery paths are verified.
- Bound student sessions to an account credential fingerprint and persisted logout revocations.
- Bound occupancy WebSocket clients to the authenticated account session and close them on logout.
- Added a disposal path for the console feed hosted by the algo server. It removes runtime listeners, clears its timer, terminates feed sockets, and closes its WebSocket server.
- `npm run typecheck` — passed.
- `npm run build` — passed, including both web and algo client builds.
- Targeted account, private-store, and PostgreSQL foundation tests — 21 passed.
- Targeted web navigation/configuration tests — 2 passed.
- Google/PostgreSQL availability gate: added a regression test requiring a hidden button and 404 responses from both OAuth endpoints in PostgreSQL mode. Typecheck and production build pass; the route test requires loopback and could not run in this sandbox.
- After that gate change, the isolated Google configuration test passed.
- `git diff --check` — passed.
- Latest full `npm test` — 347 tests: 213 passed, 128 failed, 6 skipped. Of the failures, 104 report `listen EPERM` on `127.0.0.1`; these fail at bind time and do not verify the associated HTTP/WebSocket behavior.

## Required evidence still missing

- Run the full test suite, including Google OAuth HTTP and console WebSocket integration tests. In this sandbox those tests fail at server startup with `listen EPERM` on `127.0.0.1`; an escalated rerun was denied by automatic review, so no route-level result is available.
- Triage the other 24 full-suite failures: 18 tests fail before their assertions because their harnesses construct `EdgeRuntime` without its required services; one algo-server test omits the required `SESSION_SECRET`; one detector crosscheck lacks sibling TMsense; registration import/export loses the `edge` detector setting; rollout dispatch eligibility and post-cancel OTA progress assertions fail; and a firmware test submits a Markdown file rejected by the upload allowlist.
- Run the PostgreSQL integration suite against a disposable PostgreSQL instance for the supported account and activity paths. Google sign-in remains disabled; verify its migration and recovery path before any later enablement.
- Obtain the sibling TMsense and TMWAccess repositories at the references recorded under `ci/` and run the cross-repository checks. Those checkouts are absent in this workspace.
- Verify Linux worker isolation and SIGTERM handling, then rehearse backup restore and rollback.
- After those checks, push the branch and open the review request required by the handoff.

## Gate

Do not mark 6.3 complete until the outstanding full-suite failures are triaged, the required integration evidence is recorded, and the review request is opened. The merge is committed locally but has not been pushed. No production deployment was performed.
