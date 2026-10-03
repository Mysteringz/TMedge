# PostgreSQL release and recovery rehearsal

This rehearsal uses only `docker-compose.postgres-test.yml`, bound to
`127.0.0.1:55432`. It never selects a production hostname or AWS account. The
script creates a uniquely named restore database on the disposable test server,
verifies it, drops that restore database, and removes only its own source rows.
The custom-format dump and logs remain in a temporary directory for review.

## Run it

Start the disposable service if it is not already running, then run:

```sh
docker compose -f docker-compose.postgres-test.yml up -d postgres-test
deploy/rehearse-postgres-release.sh
```

The script applies migrations with the explicit migrator account, seeds unique
synthetic registration, job, rollout, command, audit and history rows, exports
registrations, and runs import in dry-run mode. It then backs up the source
database, restores into another database, grants the local runtime role access,
compares retained row counts, reloads and exports the restored registry through
the application repository, and runs a second non-mutating import preview.
It also inserts 10,000 synthetic minute-history rows and writes a 10,000-line
synthetic recording sample for local resource/storage observations.

The script also simulates a file-backed release acknowledging a registration
after its recovery export: it appends that synthetic node to a copy of the
export, proves dry-run reports one insert without changing PostgreSQL, applies
the reviewed export, and verifies the acknowledged node is present before
backup. This exercises reconciliation mechanics with synthetic local data; it
does not execute a prior release binary or prove compatibility of one.

To retain evidence at a chosen location:

```sh
ARTIFACT_DIR=/private/tmp/tmedge-db-release-rehearsal deploy/rehearse-postgres-release.sh
```

The script is repeatable. It applies only unapplied timestamp-ordered migrations
inside TypeORM's configured all-migrations transaction. TypeORM's migration
runner does not take a PostgreSQL advisory lock; production operation must
serialize migration commands through the release/deployment lock and permit
only one migrator at a time. Runtime credentials remain separate from
migrator credentials, `synchronize` and automatic migrations remain disabled.

## Cutover gate and rollback boundary

1. Make a verified PostgreSQL backup and a mode-0600 registration JSON export
   before changing `PERSISTENCE_MODE`.
2. Validate the JSON export with `npm run db:registry:import -- <path>`; this is
   dry-run by default. Resolve duplicate identities, missing floor/table
   references and coverage errors before using `--apply`.
3. Reconcile writes made after the export before switching authority. Do not
   run file and PostgreSQL writers together. At cutover, set
   `PERSISTENCE_MODE=postgres` only after import counts and registry validation
   match the approved source.
4. Application rollback changes release code only. Do not run `db:revert` as
   part of rollback and do not drop newly committed rows. Restore the prior
   database backup or forward-fix data separately. A code release may be
   selected for rollback only if it can read the PostgreSQL authority; a
   JSON-only release cannot safely resume authority after cutover.
5. Keep schema changes expand/contract: add tables/nullable fields first,
   deploy code compatible with both shapes, retain the expanded schema for the
   rollback window, then remove obsolete structures in a later reviewed
   migration. Never reverse a migration that can delete committed operational
   data as an application rollback action.

The current branch has no committed PostgreSQL-compatible release before the
uncommitted Task 4.5 cutover wiring. The rehearsal verifies that the expanded
schema and committed data survive a separate restore and that the earlier
registration repository contract reads the restored registry. It does not
claim to have executed a prior PostgreSQL-aware application binary. Before a
real cutover, land and identify a DB-compatible rollback release and run that
binary against the expanded schema.

## Capacity and isolation notes

The documented EC2 host is a `t3.micro` with 913 MiB RAM plus 2 GiB swap, an
8 GiB root disk, and a separate 22 GiB data volume. The local test host has
7.75 GiB available to Docker and cannot establish production capacity. Record
the PostgreSQL container's sampled RSS, history insert duration, compressed
backup size, and synthetic recording size together; compare worker limits and
observed usage separately.

The isolated worker container is read-only except bounded tmpfs workspaces,
runs as UID 10001 without Linux capabilities, and is capped at 1 CPU, 768 MiB
RAM and 1.5 GiB RAM+swap by default. The edge process owns PostgreSQL and
artifact promotion; uploaded firmware source and image bytes stay on the edge's
persistent file volume. Do not enable worker builds on the documented host
until representative compilation and recording pressure are measured together.

The runbook and local measurements are rehearsal evidence only. They are not a
production cutover approval or an EC2 sizing recommendation.
