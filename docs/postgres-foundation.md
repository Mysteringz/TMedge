# PostgreSQL foundation

This foundation adds a PostgreSQL driver and explicit TypeORM migration entry points. The current edge and web processes continue to use their existing JSON and in-memory stores; adding the database does not change authority or make live frame handling depend on PostgreSQL.

## Disposable local database

The test database is separate from the production `docker-compose.yml` stack and binds to loopback on port 55432. Its default passwords are disposable local test values only.

### Start and connect with pgAdmin

Each developer runs a separate copy on their own machine; this setup is not a shared database for remote teammates. Install and open Docker Desktop, then run these commands from the TMedge repository root:

```sh
docker compose -f docker-compose.postgres-test.yml up -d --wait
docker compose -f docker-compose.postgres-test.yml ps
```

In pgAdmin, register a server (for example, **TMedge Local Test DB**) and enter:

| Field | Value |
| --- | --- |
| Host name/address | `127.0.0.1` |
| Port | `55432` |
| Maintenance database | `tmedge_test` |
| Username | `tmedge_runtime` |
| Password | `local-test-runtime-only` |

Use the runtime account to browse and run queries. It can use tables but cannot create or alter schema objects. The database has no application tables until a migration creates them. To apply a reviewed migration, use the migration role from a terminal:

```sh
PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=tmedge_test \
  PG_MIGRATION_USER=tmedge_migrator PG_MIGRATION_PASSWORD=local-test-migrator-only \
  npm run db:migrate
```

Stop the database while keeping its data with `docker compose -f docker-compose.postgres-test.yml down`. To delete this disposable database and its data, use `docker compose -f docker-compose.postgres-test.yml down -v`.

To run the PostgreSQL integration tests against it:

```sh
PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=tmedge_test \
  PG_MIGRATION_USER=tmedge_migrator PG_MIGRATION_PASSWORD=local-test-migrator-only \
  PG_RUNTIME_USER=tmedge_runtime PG_RUNTIME_PASSWORD=local-test-runtime-only \
  PG_INTEGRATION_TEST=1 npm test
```

CI uses its own ephemeral PostgreSQL service and provisions the same two roles before running the existing Node test runner.

## Credentials and migration control

For migration commands, set `PGHOST`, `PGPORT`, `PGDATABASE`, `PG_MIGRATION_USER`, and `PG_MIGRATION_PASSWORD`. The runtime service can be configured independently with `PG_RUNTIME_USER` and `PG_RUNTIME_PASSWORD`; the complete two-role config validates that both usernames and passwords differ. The application role has schema usage and row-level DML grants but no schema creation privilege.

Apply and reverse one reviewed migration explicitly:

```sh
npm run db:migrate
npm run db:revert
```

Both commands compile the project first. Migrations run in a transaction and are never applied during DataSource initialization. TypeORM schema synchronization is disabled in every DataSource. A failed connection or migration prints a generic failure without logging driver connection details or credentials.

Add production schema changes under `src/infrastructure/postgres/migrations/` as reviewed TypeORM migrations. No business tables are created by this foundation; the first domain schema belongs to Task 4.2.
