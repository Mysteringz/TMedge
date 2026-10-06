# Backend integration QA handoff

**Status: open; Task 6.3 remains pending.** The local branch contains the merge of `origin/main` at `cc219ca` and the Google/PostgreSQL availability gate. It has not been pushed or opened as a pull request. See the [QA report and evidence index](backend-integration-qa/qa-report.md).

Google sign-in remains unavailable in PostgreSQL mode: the button is hidden and both OAuth routes return 404 even when Google credentials are configured. This follows the requested product decision. The Google identity migration and repository support remain present for later integration; they do not enable OAuth in PostgreSQL mode.

This integration pass also fixed the test harnesses to compose `EdgeRuntime` with its required services, preserved the registration detector setting through import/export and PostgreSQL persistence with a new additive migration, accepted OTA progress from a node already dispatched when its rollout is cancelled, aligned gateway race coverage with the delivery sequence, and corrected the firmware test's upload/build setup.

The TypeScript checks, production build, focused no-network regression tests, and whitespace check pass. The full test run is not a pass: 120 tests fail at loopback bind with `listen EPERM`, and one sibling-repository assertion fails because TMsense is absent. PostgreSQL integration, the pinned TMsense/TMWAccess crosschecks, Linux worker isolation and shutdown checks, and task 6.2 restore/rollback evidence remain unverified. Do not mark Task 6.3 complete until the missing gates have evidence.

No production deployment was performed.
