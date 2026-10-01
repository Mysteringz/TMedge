# Task 4.2 — Registration, Provisioning, and Audit Schema QA

**QA verdict: PASS**

**Owner:** Contributor B
**Tester review:** PASS (independent read-only review; final re-review confirmed exact floor/table ID readbacks)

## Scope reviewed

- Reversible PostgreSQL migration for registered identities, node placement, table ownership, provisioning requests, and audit events.
- Real PostgreSQL 17 integration coverage for relational constraints, lifecycle fields, preserved identifiers, and migration up/down.
- Application-side validation against the static site layout.
- No runtime wiring or automatic migration execution.

## Findings

- `registered_nodes.uid` is the unchanged public MAC identifier and a primary key. Identity-only registration is valid because placement is stored separately.
- Placement references a registered node; table ownership references a placement and has a primary key on `table_id`. Duplicate identities, unplaced ownership, and duplicate table owners are rejected.
- Provisioning requests have one pending request per UID, one approval per registered UID, an expiry after request creation, resolution fields consistent with state, and an expired-state deadline check. Terminal history permits a later pending request.
- Audit actor kinds use the current contract enum, audit subject IDs remain unchanged, and audit events do not cascade with operational rows.
- Floor/table IDs remain text in PostgreSQL. The integration test reads back `iw-maker-a` and `M3` unchanged. `buildRegistry` rejects an unknown floor in application code; existing tests also cover unknown tables and duplicate ownership.
- Migration `up` and `down` pass through TypeORM with transaction mode `all`. Runtime schema changes remain denied by the runtime role.

## Verification

See [verification summary](artifacts/verification-summary.md) for commands and complete results.

- `npm run typecheck`: PASS.
- Focused PostgreSQL integration test on the disposable local PostgreSQL 17 service: PASS, including up/down and SQLSTATE checks for unique (`23505`), foreign-key (`23503`), check (`23514`), and enum (`22P02`) violations.
- `npm run build`: PASS.
- Full `npm test`: 142 passed, 3 failed, 4 skipped. The failures are outside Task 4.2: two pre-existing timing assertions reproduce when run alone; one test requires the unavailable sibling `../TMsense` checkout. Task 4.2's focused database test and registry behavior test pass.

## Required MCP references

- Playwright MCP: N/A; this is a server-side schema task.
- Chrome DevTools MCP: N/A; no browser or UI changes.
- Context7: unavailable during implementation. Official primary references consulted: [TypeORM migration creation and reversible `up`/`down`](https://typeorm.io/docs/migrations/creating/), [TypeORM migration setup and transaction mode](https://typeorm.io/docs/migrations/setup/), [PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html), and [PostgreSQL partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html).

## Tester review

The tester found no blocking SQL or scope issue. Its initial non-blocking request for explicit floor/table ID readback was resolved by adding PostgreSQL assertions for exact `iw-maker-a` and `M3` values; the focused database test was rerun and passed. Final tester verdict: **PASS**.
