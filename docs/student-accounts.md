# Student accounts and retained usage activity

The student web tier can use PostgreSQL for accounts, signup/login/logout activity, and explicit seat-search/app interactions. Its `STUDENT_PERSISTENCE_MODE` is independent of the edge's `PERSISTENCE_MODE`. Default file mode retains the existing `users.json` adapter; PostgreSQL mode is the sole student account authority and never falls back to JSON. Existing scrypt password hashes remain compatible. New sessions bind to the account's stable ID and credential version; logout revocations are stored in a private file so a copied cookie remains invalid after restart.

## Fresh local setup (PowerShell or any shell)

Run from `TMedge/` with Docker Desktop running:

```sh
npm run students:local:config
docker compose -f docker-compose.postgres-local.yml up -d --wait
npm run db:migrate
npm run web
```

The config command creates `.env` with generated, distinct local credentials, chooses an available loopback web port from 8080..8089 and uses PostgreSQL on loopback 55433. It prints the selected web port and refuses to replace an existing `.env`. Visit `http://127.0.0.1:<WEB_PORT>/signup/` to register with an allowed university email or Portal UID and a password of at least 10 characters. Account storage does not verify ownership of the email; that authentication enhancement remains deferred.

The database uses a persistent named volume. `docker compose -f docker-compose.postgres-local.yml stop` pauses it; `start` resumes it. Do not delete its volume when keeping accounts. Initial credentials are consumed only when the volume is first initialized; changing `.env` later does not rotate existing database role passwords. The local admin role is a database maintenance credential, not an application admin account.

For an existing installation, configure `STUDENT_PERSISTENCE_MODE=postgres`, PostgreSQL runtime credentials and `SESSION_SECRET` in the existing environment. Keep the existing `SESSION_SECRET` during a compatible rollout; sessions are reissued with account binding after sign-in. Apply reviewed migrations with separate migration credentials before starting the web process. Containerized web deployments need a reachable PostgreSQL hostname; `127.0.0.1` refers to the web container itself.

## Google sign-in

Google sign-in is optional. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` together; the redirect URI must end in `/auth/google/callback`. A Google identity is keyed by the verified OpenID Connect subject (`sub`), not by email. If that subject already has an account, a changed Google email does not create a second user or silently rename the account. If a new subject presents an email already owned by another account, sign-in is refused; accounts are never linked using email alone. Google-only accounts have no password credential. They can be created only while `SIGNUP_OPEN=1`.

In PostgreSQL mode, apply the additive `AddGoogleStudentIdentity1791504000000` migration after the account and activity migrations. It adds a nullable unique subject and permits empty password fields only for Google identities. Its down migration refuses to run while Google-only accounts remain, so an operator must preserve or migrate those accounts before rollback. Existing migrations are immutable.

Optional Turnstile protection requires `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_HOSTNAMES` together. Sign-in and sign-up tokens are checked against the matching action and configured hostnames; Google OAuth uses Google's own authentication flow.

## Import existing accounts

Stop all file-mode student writers, back up the original `users.json`, and apply migrations. The import validates the entire file and defaults to preview:

```sh
npm run db:students -- import data/users.json
npm run db:students -- import data/users.json --apply
```

Preview reports total, unchanged and insertable counts and makes no writes. Apply runs transactionally, rejects conflicting accounts, preserves existing salts/hashes/creation times, assigns UUIDs to legacy accounts and keeps existing IDs on repeat imports. An empty installation can start directly in PostgreSQL mode without an import. After a successful final import set `STUDENT_PERSISTENCE_MODE=postgres` and start the web tier. Do not run JSON and PostgreSQL writers concurrently.

Account management follows the selected student mode:

```sh
npm run user -- list
```

The existing `npm run user -- add <email> <name> <password>` command also supports PostgreSQL; the signup form avoids placing a password in shell history.

## Activity and retention

`student_activity_events` stores server-generated event/request UUIDs, an optional stable student user ID, action, outcome (`succeeded`, `failed`, `rate-limited`), timestamp, and bounded `details` JSON. Authentication actions are `signup`, `login`, and `logout`. Explicit app actions are `seat-search`, `space-view`, `table-select`, and `directions-view`. Unknown-account attempts have no user ID or attempted email. No passwords, hashes, salts, cookies, IP addresses, raw bodies, arbitrary page URLs, or location traces are logged. Signup and login failures are recorded; database account outages return a controlled unavailable response. Logout clears the cookie even if the account database is unavailable. Stateless cookie revocation is unchanged.

Usage details contain only seats (integer 1..30), recognized campus floor/venue/table IDs (safe characters, at most 100 characters), capped server result count (integer 0..20), and `liveData` (boolean); storage rejects other keys and payloads above 2048 JSONB bytes. `liveData` describes usable sensor information, not a student's attendance. Search counts represent explicit Search clicks or authenticated search API requests; they do not prove reservations, arrival, or seat occupancy. Floor views count entering a space, table selections count choosing a table, and directions views count opening directions. Occupancy polling, WebSocket updates, React effect replay, and checking a session do not add usage events. Reloading or leaving and returning to a floor is a new space view. Searches before this feature was enabled cannot be reconstructed from the old authentication-only logs.

The authenticated browser posts allowlisted interactions to `/api/activity` with same-origin/custom-header protections and a 2 KiB request limit. The server supplies identity, request/event IDs, outcome, time, and search result count. Requests are limited to 120 per minute per authenticated student. Usage writes remain best-effort; telemetry failures do not block navigation or successful searches. File mode does not implicitly acquire database activity persistence.

Writes are best-effort through a queue capped at 1000 pending/in-flight operations. Failed or overloaded writes are dropped with counters and restricted operational logs. `/healthz` retains its liveness response; `/readyz` reports account database availability and activity queue/drop/failure counters. Activity failure alone does not invalidate successful authentication. Shutdown drains for at most 5 seconds. Both authentication and usage activity are retained for 90 days by default; `STUDENT_ACTIVITY_RETENTION_DAYS` accepts 1..3650 and pruning runs at startup and daily.

Inspect recent activity or preview/apply retention manually using runtime database credentials:

```sh
npm run db:students -- activity --limit 100
npm run db:students -- activity --user-id <student-uuid> --limit 100
npm run db:students -- summary --limit 100
npm run db:students -- prune --days 90
npm run db:students -- prune --days 90 --apply
```

These are operator CLI commands, not student-facing endpoints. Foreign keys retain events with a null user ID if an account is deleted; no account deletion endpoint is added here.

In pgAdmin, refresh the schema to see `Views → student_activity_summary`, or run:

```sql
SELECT email, search_count, no_result_search_count, space_view_count,
       table_select_count, directions_view_count, last_search_at
FROM public.student_activity_summary
ORDER BY search_count DESC, email;

-- Detailed events for a student's stable ID, newest first:
SELECT action, outcome, details, occurred_at
FROM public.student_activity_events
WHERE user_id = '<student-uuid>'::uuid
ORDER BY occurred_at DESC
LIMIT 100;
```

`student_activity_summary` is an operator view with one row per current student, including students with zero activity. It exposes email/name/UUID, successful search, space-view, table-select and directions-view counts, searches returning zero calculated suggestions, successful logins, attributed failed logins, and first/last activity and last successful search timestamps. Unknown-user attempts are excluded from per-student counts. The existing login limiter records anonymous events before account lookup, so those rate-limited requests are excluded too. Search result counts are capped server seat-search suggestions, not the number of floor cards displayed in the browser. The CLI returns these fields as camelCase JSON with millisecond timestamps or null. Counts cover retained history, not lifetime activity; pruning lowers them. Dropped best-effort events can also make counts incomplete. Limits default to 100 and accept 1..1000.

Apply `ExtendStudentUsageActivity1791417600000` and `AddGoogleStudentIdentity1791504000000` before running the combined usage and Google-enabled code. The usage migration preserves existing account IDs, password hashes, and authentication rows, replaces the action enum transactionally, and gives old events empty details. Runtime SELECT on the view follows the existing migrator's default table privileges; an installation with different role grants must grant runtime SELECT on `public.student_activity_summary`. The usage down migration removes only usage-action rows and the details column/view, restores the original authentication enum, and preserves accounts/authentication rows. Export or back up usage history before an intentional down migration; those usage events cannot be recovered from rollback alone.

## Recovery

Create a new private recovery file; export refuses to overwrite an existing path:

```sh
npm run db:students -- export data/student-accounts-recovery.json
```

Exports contain password hashes and salts and must remain private. The command requests mode0600; on Windows also use the directory's ACLs. Use PostgreSQL backups to retain both accounts and activity. Before returning to file mode, stop PostgreSQL-mode writers and export/reconcile all later accounts into the authoritative `USERS_FILE`. Retain the database and activity history. Rolling back application code must not automatically run a destructive down migration.

## Deferred later MVP

Named admin accounts, individual admin attribution, admin permissions, university SSO, email verification, account changes, and arbitrary browsing/location analytics remain deferred. Google sign-in is a separate optional provider. Existing shared `ADMIN_PASSWORD` behavior is unchanged.
