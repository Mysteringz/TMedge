# Integrated backend QA report

**Run date:** 2026-10-06  
**Branch:** `feat/edge-persistence`  
**Base integrated locally:** `origin/main` at `cc219ca`  
**Verdict:** **Pending — Task 6.3 is not complete.**

## Findings and fixes in this pass

- Tests that directly constructed `EdgeRuntime` now use `createEdgeRuntime`, matching the production composition root.
- Registration import/export and the PostgreSQL registry adapter now preserve `detector`. Migration `1791590400000-AddRegistrationDetector` adds a checked column defaulting existing registrations to `node`.
- Cancelled rollouts accept status from a node whose OTA had already been dispatched. Queued or skipped nodes remain ineligible because they have no active dispatch state.
- Gateway dispatch tests now wait for image delivery before simulating node progress.
- The firmware no-`platformio.ini` test now checks the upload allowlist and workspace validation without attempting a build that requires an isolated worker.
- The algo-server test now configures and uses an account session, consistent with current authentication.
- PostgreSQL-mode Google sign-in stays hidden and both OAuth endpoints return 404, per the product decision.

## Evidence index

| Evidence | Command or artifact | Result |
| --- | --- | --- |
| Type checks | `npm run typecheck` | Pass |
| Production build | `npm run build` | Pass, including web and algo bundles |
| Focused regressions | `npx tsc -p tsconfig.json && node --test dist/test/registration-import-export.test.js dist/test/rollout-dispatch-races.test.js dist/test/rollout.test.js dist/test/edgedetect.test.js` | Pass: 54 tests |
| Full suite | `npm test` | 347 tests: 220 pass, 121 fail, 6 skip. Of the failures, 120 stop at `listen EPERM` on `127.0.0.1`; the remaining failure requires the sibling TMsense checkout. The EPERM tests do not reach their HTTP/WebSocket assertions. |
| Protocol crosscheck | `npm run crosscheck` | Not run to completion: `ENOENT` for `../TMsense/test/host/build_packet_host.sh`; sibling checkout is absent. |
| Diff whitespace | `git diff --check` | Pass |
| Disposable PostgreSQL | `docker ps`; local port check | Unavailable: Docker daemon socket permission denied; nothing listening on `127.0.0.1:5432`. PostgreSQL integration and the new migration are not verified against a live server. |
| Sibling repository pins | `ci/tmsense.ref`, `ci/tmwaccess.ref` | Required refs are `3bd42d1612a7e0f15a532b2e831fb340736d6766` and `5b6ed6ce8e8cfc7fa731f567ee10182671685d83`; both sibling checkouts are absent. |

## Required gates still open

- Run the complete HTTP/WebSocket suite in an environment that permits loopback binds. This includes the Google-mode regression verifying PostgreSQL mode hides the button and returns 404 from both OAuth routes.
- Run the PostgreSQL integration suite with `PG_INTEGRATION_TEST=1` against the disposable test service. Verify the new registration detector migration and import/export round trip, along with existing recovery and privilege checks.
- Check out TMsense and TMWAccess at the recorded CI pins, then run the protocol, training, and cross-repository checks.
- Verify Linux worker isolation, graceful shutdown, recorder overload behavior, and firmware failure recovery in CI or another supported Linux environment.
- Review task 6.2 backup restore and rollback evidence. The handoff references private artifacts that are not present in this checkout; the `[x]` status in `task.md` alone is not evidence.
- Obtain tester review, retain the final CI evidence, then push and open the PR against `main`.

## Release and status notes

Google OAuth is intentionally unavailable in PostgreSQL mode until its persistence, account identity, and recovery paths are reviewed and verified. No production deployment or migration was performed. Keep Task 6.3 pending until the open gates above have evidence and the PR is opened.
