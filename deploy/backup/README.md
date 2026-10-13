# AWS primary and Proxmox website standby

VM 104 on proxmox3 runs the same approved TMedge runtime as AWS. A separate
Cloudflare Tunnel makes it a distinct origin. The student hostname uses
`steering_policy=off`, ordered pools `[AWS, Proxmox]`, Proxmox as the fallback,
and no session affinity. AWS receives all traffic while healthy. The console,
gateway and direct-node hostnames remain on AWS.

## Installed state

- Both hosts: release `20261013T060654Z-830554a2669c`, commit `830554a2669cb1761d3a3abfb259b2dee7a1721a`.
- VM: Debian 13, Node 22, PostgreSQL 17, current cloudflared and Tailscale;
  compiler, openconnect and ocproxy installed. VM snapshot
  `before-backup-20261013` preserves the September install. Its recordings
  also remain under `/opt/tmedge-shared/data`; no recording was deleted.
- Code follows the normal immutable releases, manifest verification,
  readiness and automatic rollback path. The old install was migrated with
  `deploy/remote.sh migrate`; it is too old for today's registry and must not
  be activated with the new environment. Restore the whole VM snapshot to
  restore that old configuration, never only the old code symlink.
- The simulator is disabled on the standby. Its local edge binds ingest to
  loopback and publishes to no website. Only AWS's authorized occupancy
  snapshots reach the standby student site. It cannot invent pilot counts.
- AWS retains its local snapshot URL and adds the VM's private web address.
  Image planes do not cross this link.

## Database and accounts

`tmedge-postgresql` on the VM is a physical hot standby of the AWS database.
`tmedge-backup-db-tunnel` forwards only a loopback listener to AWS PostgreSQL
through a dedicated SSH key/account. AWS listens on loopback; no database
port was opened publicly. The replication role has LOGIN and REPLICATION,
not application administrator rights. No replication slot was created;
`wal_keep_size=128MB` limits the retained WAL budget on the small AWS disk.
If a long disconnect exhausts retained WAL, re-seed the standby with a new
base backup rather than promoting it or weakening authentication.

Existing-account lookup, credential verification and signed sessions work
against the replica. Sign-up is closed on the standby. Student activity
writes are best effort and fail on the read-only replica; its anonymous
JSONL usage meter still works. The replica is never automatically promoted.
This prevents two account writers and allows automatic return to AWS.
It is website availability, not independent sensor ingestion or an automatic
database-primary election.

## Private state and release refresh

`primary.py` is root-owned on AWS under `/opt/tmedge-backup-primary`. The
standby key can request only `status`, `state`, `release` and
`replication-credential`; SSH forwarding permits only `127.0.0.1:5432`.
The state allow-list contains the private environment, device registry and
account/session files. It exports no raw recordings, personal SSH identity,
AWS tunnel token or Tailscale identity. Credentials travel over encrypted
SSH and are not written to the developer workstation or logged.

`standby.py`, root-owned under `/opt/tmedge-backup`, refreshes that state and
the approved primary release every minute via `tmedge-backup-sync.timer`.
It accepts only allow-listed regular JSON/environment files and atomically
replaces changed files. It restarts only affected running application units.
Environment overrides disable local publishing, sign-up and the AWS-only
email sender. Replica data and per-host analytics are never overwritten.
Runtime releases use the normal receiver: bounded extraction, exact file
manifest, clean release identity, health checks and rollback. If the primary
changes during transfer, retry next minute. Receiver-tool changes still need
reviewed administrator installation on the standby as in `pipeline.md`.

The private training reader tunnel and restricted ML-export credentials are
installed for the standby's local console; training writers are not started.
Public console writes continue to go to AWS. Training recordings, the large
AWS recording archive and historical export ZIPs are not mirrored to the VM's
16 GB disk. That archive needs its own storage backup.

## Health and routing

The Cloudflare HTTPS monitor requests `/readyz`, requires HTTP 200 and
`"ready":true`, and uses the student hostname as the Host header. It runs
every 60 seconds, requires two successive failures/recoveries, retries once
and has a five-second timeout. Detection is normally about one to two
minutes plus probe time; it is not instantaneous.

When AWS's edge stops, both sites lose new snapshots. After 30 seconds,
the standard stale handling makes tables unknown and excludes them from
recommendations. Account storage remains readable on the replica, so the
standby can serve existing students during an AWS outage. Once AWS recovers,
Cloudflare returns traffic to the first healthy pool.

Check application and replication health privately:

```sh
systemctl is-active tmedge-edge tmedge-web tmedge-postgresql cloudflared tmedge-backup-db-tunnel
systemctl status tmedge-backup-sync.timer
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8080/healthz
sudo -u postgres psql -d tmedge -c 'SELECT pg_is_in_recovery(); SELECT status FROM pg_stat_wal_receiver;'
```

Compare primary and standby replay LSNs when both are online. A matching
LSN, account count and release manifest verifies the seeded state without
printing accounts or secrets. Check both Cloudflare pools' monitored health
before enabling the load balancer. Test backup routing with an isolated
probe hostname, never by deliberately stopping the live AWS services.

The October deployment passed typecheck, 659 application tests (651 passed,
8 environment/build skips), 14 assistant tests after updating its knowledge,
and `python3 deploy/backup/test-backup.py`. The artifact SHA and both runtime
manifests matched. Cloudflare marked both pools healthy; an isolated probe
load balancer served the standby login page and readiness endpoint and was
then removed. A one-minute existing-account session issued on the primary
read current occupancy on the standby. Primary and replica account counts
and WAL replay LSN matched. Live AWS was not deliberately failed.

Ask AI uses the supported `AI_KNOWLEDGE_FILE` override to read the updated
private shared knowledge file on both machines. This keeps its deployment
knowledge current while preserving each immutable release's exact manifest.

To remove standby routing, disable the load balancer: the retained DNS CNAME
still points to the AWS tunnel. Then stop the VM's separate connector and
sync/replication timers. Never start the September connector: its token is
for the same tunnel as AWS and would split users between different stores.

## Full-site failover preparation

`docs/FAILOVER.md` describes the separate, not-yet-live full-site design. Its
first implemented control is a PostgreSQL-backed site lease: one origin may
bind sensor/console listeners and serve student traffic, while a database
generation fences the other. The lease passed an isolated two-origin expiry
and takeover rehearsal on the Proxmox PostgreSQL service.

Do not add the failover environment variables to these live units yet. The
current local-file state and read-only physical replica are not sufficient for
safe writable failover; the remaining state table in that document and the
managed cloud database gate must be completed first.
