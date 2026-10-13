# Full-site failover

The live deployment is still the website-only standby described in
`deploy/backup/README.md`. The work in this document is preparation: it must
not be enabled on either live origin until an independent managed PostgreSQL
service has been selected, seeded, backed up and rehearsed.

## Safety model

Cloudflare routing is not a writer lock. A monitor can be stale, separate
hostnames can make decisions at different times, and a network partition can
leave both application machines running. TMedge therefore uses PostgreSQL as
the independent witness for one site-wide leader.

`public.site_leadership` holds one renewable lease for the whole site. The
database clock decides expiry. Each new holder advances a `generation`, which
is the fencing epoch. With failover enabled:

- the edge process acquires the lease before binding UDP ingest, gateway TCP,
  direct-node WSS, console HTTP/WebSocket or starting periodic work;
- it renews well before expiry and has a local deadline earlier than the
  database deadline;
- loss of renewal closes every stateful listener before another origin may
  become leader;
- the student tier checks the same row for `/readyz`, ordinary HTTP traffic
  and new WebSocket upgrades, returning 503 when its origin is not leader;
- Cloudflare health checks can therefore route every public hostname to the
  origin that the database has authorized. The gateway listener exposes
  `/healthz`, and the direct-node listener already exposes `/healthz`; because
  neither listener binds before lease acquisition, only the active input
  origin can answer successfully.
- node replay cursors and the global command sequence commit in PostgreSQL
  before an ACK or downlink; their statements lock and verify the same lease
  row, so an expired generation cannot finish a late write after takeover.
- gateway HELLO nonces commit through that same fence before WELCOME, so a
  proof accepted by one origin cannot be replayed through the other.

The default lease is 15 seconds and renews every 5 seconds. Host clocks do not
participate. A graceful stop releases immediately; a crashed or partitioned
origin is eligible for takeover only after database expiry.

## Configuration

Failover is deliberately opt-in and requires PostgreSQL mode:

```dotenv
PERSISTENCE_MODE=postgres
STUDENT_PERSISTENCE_MODE=postgres
FAILOVER_SITE_ID=hkumyseat
FAILOVER_ORIGIN_ID=aws
FAILOVER_LEASE_TTL_MS=15000
FAILOVER_LEASE_RENEW_MS=5000
```

The backup uses a different origin ID. Both processes on one machine use the
same site and origin IDs; only the edge process owns the lease. The web process
observes it. Omitting both IDs preserves the existing single-origin behaviour.
A half-configured identity or file-mode failover refuses to start.

Apply reviewed migrations with the migrator role, then exercise the runtime
role against a non-production database:

```sh
npm run db:migrate
npm run failover:rehearse
```

The rehearsal creates a uniquely named temporary row, proves that a live
primary fences a competitor, simulates abrupt loss of the primary database
path, waits for expiry, proves generation-2 takeover, and removes the row. It
does not touch registrations, accounts, occupancy or training data.

At cutover, stop the legacy edge first and keep it stopped while importing its
last durable replay files with migrator credentials:

```sh
npm run failover:import-replay -- /path/to/replay.jsonl /path/to/gateway-hellos.json
```

The reader validates without rewriting either source file. The transaction
refuses an active site owner, locks out a concurrent lease acquisition, never
lowers an existing node or command high-water mark, and imports only gateway
nonces that remain live according to the database clock. Use the explicit
`--no-gateway-journal` second argument only when no gateway journal exists.
Keep the source files and import receipt until failback testing is complete.

## State still to migrate before rollout

The lease prevents split brain, but it does not make host-local files appear
on the successor. Full-function rollout remains blocked until each item below
has an independent durable home and a tested restore path.

| State | Current durable home | Required failover home |
| --- | --- | --- |
| Student accounts/activity | PostgreSQL | Seed into shared managed PostgreSQL |
| Registrations, provisioning, build/rollout metadata, command outcomes, occupancy history | PostgreSQL in postgres mode | Seed into shared managed PostgreSQL |
| Algo users, revocations, account settings, mail, board, email ledger | Private JSON on one origin | Transactional PostgreSQL repositories |
| Node replay and command high-water marks | Fenced PostgreSQL in failover mode | Implemented with monotonic legacy import |
| Gateway HELLO high-water/nonces | Fenced PostgreSQL in failover mode | Implemented with live-window import |
| Pending parameter reverts and their audit | Memory/JSONL on one origin | Durable PostgreSQL workflow with the same 15-minute revert rule |
| Firmware artifact bytes and uploads | Private origin disk | Immutable object storage; PostgreSQL metadata remains authoritative |
| Long-horizon detector backgrounds | Private origin disk | Versioned object snapshots; failover stays unknown while missing/warming |
| ML/HPC job records, project uploads and sealed local credentials | Private origin disk | Shared records/objects; credentials remain encrypted and scoped |
| Training spool, recordings and analytics files | Private origin disk | Object/archive storage with explicit retention |

An HPC shell or VPN session cannot move between machines. After failover the
feature must be available, but an operator will authenticate again (including
OTP); credentials and live terminal state must not be copied between origins.

## Cloud database gate

Before production rollout, choose a managed PostgreSQL service with PostgreSQL
17 or newer, automatic failover independent of both application origins,
point-in-time recovery, TLS certificate verification, separate migrator and
runtime roles, connection limits suitable for both origins, and a region close
to Hong Kong. Restore tests and measured failover time are release gates.

Cloudflare Load Balancing and Tunnels continue to route HTTP/WSS/TCP endpoints;
they do not host or elect the PostgreSQL writer. All student, console, gateway
and direct-node hostnames must share the same ordered origin policy and health
must include lease ownership. Do not enable one hostname at a time: that can
split sensors, console writes and the student view across different origins.

## Production acceptance

Rollout is complete only after a controlled primary power-loss rehearsal shows:

1. the old origin stops accepting stateful work before the standby acquires;
2. sensors and gateways reconnect and live occupancy becomes current without
   ever showing silence as empty;
3. existing student and console sessions obey shared revocation state;
4. provisioning, parameter changes/reverts, firmware pilot/rollout, workspace,
   email and ML/HPC records are available and write exactly once;
5. firmware/model objects are byte-verified before use;
6. database backup restore and application failback preserve writes made while
   the backup was active;
7. every Cloudflare hostname selects the same authorized origin, and recovery
   does not automatically discard or overwrite backup-era writes.
