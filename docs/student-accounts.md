# Student accounts and authentication activity

The student web tier can use PostgreSQL for accounts and signup/login/logout activity. Its `STUDENT_PERSISTENCE_MODE` is independent of the edge's `PERSISTENCE_MODE`. Default file mode retains the existing `users.json` adapter; PostgreSQL mode is the sole student account authority and never falls back to JSON. Existing scrypt password hashes and signed cookies remain compatible.

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

For an existing installation, configure `STUDENT_PERSISTENCE_MODE=postgres`, PostgreSQL runtime credentials and `SESSION_SECRET` in the existing environment. Keep the existing `SESSION_SECRET` to preserve cookies. Apply reviewed migrations with separate migration credentials before starting the web process. Containerized web deployments need a reachable PostgreSQL hostname; `127.0.0.1` refers to the web container itself.

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

`student_activity_events` stores server-generated event/request UUIDs, an optional stable student user ID, action (`signup`, `login`, `logout`), outcome (`succeeded`, `failed`, `rate-limited`) and timestamp. Unknown-account attempts have no user ID or attempted email. No passwords, hashes, salts, cookies, IP addresses, raw bodies or browsing/location history are logged. Signup and login failures are recorded; database account outages return a controlled unavailable response. Logout clears the cookie even if the account database is unavailable. Stateless cookie revocation is unchanged.

Writes are best-effort through a queue capped at1000 pending/in-flight operations. Failed or overloaded writes are dropped with counters and restricted operational logs. `/healthz` retains its liveness response; `/readyz` reports account database availability and activity queue/drop/failure counters. Activity failure alone does not invalidate successful authentication. Shutdown drains for at most5 seconds. Activity is retained for90 days by default; `STUDENT_ACTIVITY_RETENTION_DAYS` accepts1..3650 and pruning runs at startup and daily.

Inspect recent activity or preview/apply retention manually using runtime database credentials:

```sh
npm run db:students -- activity --limit 100
npm run db:students -- prune --days 90
npm run db:students -- prune --days 90 --apply
```

These are operator CLI commands, not student-facing endpoints. Foreign keys retain events with a null user ID if an account is deleted; no account deletion endpoint is added here.

## Recovery

Create a new private recovery file; export refuses to overwrite an existing path:

```sh
npm run db:students -- export data/student-accounts-recovery.json
```

Exports contain password hashes and salts and must remain private. The command requests mode0600; on Windows also use the directory's ACLs. Use PostgreSQL backups to retain both accounts and activity. Before returning to file mode, stop PostgreSQL-mode writers and export/reconcile all later accounts into the authoritative `USERS_FILE`. Retain the database and activity history. Rolling back application code must not automatically run a destructive down migration.

## Deferred later MVP

Named admin accounts, individual admin attribution, admin permissions, SSO, email verification, account changes, browsing analytics and per-session revocation remain deferred. Existing shared `ADMIN_PASSWORD` behavior is unchanged.
