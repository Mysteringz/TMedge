# ML data

The console top bar groups **ML job** (the existing `/train` page) and **ML data**
(`/ml-data`) under **ML**. Both are also discoverable from Home and its search.
ML data belongs exclusively to the authenticated algo console. Nothing is
mounted on the student web tier.

The SQL console accepts a single SELECT or WITH query through a PostgreSQL
read-only cursor and extended protocol. It previews at most 200 rows, 100
columns, 4 KiB per cell and 1 MiB of results, with a ten-second database
statement limit and a bounded overall fetch loop. Values are bounded in SQL
before reaching Node. Binary values become byte-count labels; SQL functions
can still explicitly derive other representations from data. Preview values
are text. Errors never disclose the connection URL, credentials or database
diagnostics. Querying and schema inspection require `training.read` (all
current access roles). Preparing an export requires `training.write`
(Operator, Engineer, Admin); team labels grant nothing.

## Connection and deployment

Use the already provisioned SELECT-only `crowdaware_reader` in
`crowdaware_training` through the private SSH/Tailscale PostgreSQL forward.
Do not reuse the writer worker's environment or the application's registry
migration credentials. The edge accepts either `ML_DATABASE_URL` or
`ML_DATABASE_URL_FILE`, never both. A file must have no group/world access,
be readable by the service, and contain only the connection URL. URL options
are refused so connection settings cannot undo the read-only defaults.

Provision a 0600 reader URL file owned by the edge service **outside the
release**, then set `ML_DATABASE_URL_FILE` in its shared environment. The
connection is deliberately optional: an unconfigured or unavailable database
shows its status and cannot look like an empty dataset. Install a native
`pg_dump` matching PostgreSQL 18 or newer on the edge and set `ML_PG_DUMP` if
it is not on PATH. Native deployments need this prerequisite; Docker users
must supply a compatible client in their runtime image. No table migration is required. Apply the SELECT-only sequence grant in
`deploy/training/ml-data-reader.sql` as the existing training schema owner.
pg_dump needs sequence values for identity columns such as annotation IDs;
SELECT on sequences grants no nextval/setval authority. The provisioning
script includes this grant for new installs. Do not rerun initial credential
provisioning on a host that lacks the original credential file.

Live inspection on 2026-10-11 found LXC 105 on **proxmox1**, PostgreSQL 18,
with `frames`, `pairs`, `annotations`, `thermal_background`, `fov_mask`, and
`ml_samples` (a view). The database was about 8.6 GiB; do not assume a full
export compresses to a fixed fraction of that. JPEG payloads already contain
compressed data. HBA still permits the previous Proxmox tunnel hop rather
than proxmox1's source address. Keep that established hop until a separately
reviewed network change; this feature does not broaden HBA.

From the Mac, keep NordVPN on and use the secondary userspace Tailscale
client described in TRAINING_POSTGRES.md. Confirm host names with that client's
status before using an address from older notes. The VM now lives on proxmox1;
the previous allowed tunnel hop can still reach it. Credentials remain private.

## ZIP exports

1. `POST /api/ml-data/exports`, JSON `{ "tables": ["training.frames"] }`,
   with `x-tm-algo: 1`, returns **202** and an ID before any database connection
   or child process begins.
2. A background worker validates selected names against the live catalog,
   rejecting views and tables outside `training`. It runs `pg_dump` without
   a shell and passes credentials privately through the child's environment,
   never argv. One dump supplies a consistent snapshot for the selection.
3. SQL goes directly into a streaming, deflated ZIP64 archive, with
   `dataset.sql` and `manifest.json`. No uncompressed dump touches disk. `yazl`
   is the one new runtime dependency: it supports streams, deflate and ZIP64
   for datasets whose uncompressed SQL exceeds 4 GiB. With the remote worker
   configured, Python's standard-library ZIP64 compressor runs on Proxmox
   instead; no dump or ZIP is staged on the edge.
4. The page polls `GET /api/ml-data/exports` every five seconds. The individual
   status URL is `GET /api/ml-data/exports/:id`.
5. `GET /api/ml-data/exports/:id/download` streams the completed file. It
   supports byte ranges/resumption, Content-Disposition, and private no-store
   headers for browser and CDN. The browser navigates to the download URL;
   it never loads the entire archive into a JavaScript blob.

Files and atomic receipts live in `DATA_DIR/algo/ml-exports` (private directory,
0600 files), survive release swaps and belong to their requesting account
and its identity epoch. Another account, including an Admin, cannot inspect
or download them. Recreated/reset accounts do not inherit them. Session or
permission revocation also ends an active download on the next five-second
check. In remote mode only the receipts live here; the ZIP and working file
stay on Proxmox. A failed pg_dump, disk/quota failure or shutdown never publishes a
partial archive. On startup, unfinished jobs become failed and their partial
files are removed. Completed jobs survive restarts. No dump is resumed blindly.

Cleanup runs at startup, hourly and when listing/starting jobs. Completed ZIPs
expire 24 hours after completion; failed receipts expire after 24 hours.
Active downloads are leased while streaming. At most 32 receipts are retained
and one export is prepared globally at a time. A two-hour timeout kills stuck
dumps. `ML_EXPORT_MAX_BYTES` defaults to 8 GiB compressed locally, or 16 GiB
with the private remote worker, and
`ML_EXPORT_RESERVE_BYTES` to 1 GiB free; the actual job quota is the smaller of
the configured cap and available space minus the reserve. It rechecks space
while writing. Other services can also write to this filesystem, so monitor
disk use and size these limits for the host.

The database's table size is not a ZIP-size estimate. An 8.4-GiB table cannot
be assumed to fit into a nearly full edge volume, even with streaming
compression. Raising the size limit or lowering the reserve does not add
physical capacity. Use the Proxmox worker when the edge cannot hold a large
dataset archive.

## Private Proxmox export worker

Configure `ML_EXPORT_SSH_HOST`, `ML_EXPORT_SSH_KEY` and
`ML_EXPORT_SSH_KNOWN_HOSTS` together; `ML_EXPORT_SSH_PORT` defaults to 2223.
The edge uses an absolute 0600 private key and an explicitly pinned host key,
with no agent or port forwarding. These settings select remote generation for
new exports; there is no automatic fallback to edge storage on an SSH error.
Previously completed local exports keep their original local download path.
The existing private reader URL remains necessary for live schema/SQL queries.

On Proxmox, install PostgreSQL **18 or newer** `pg_dump` from the official
[PostgreSQL Debian packages](https://www.postgresql.org/download/linux/debian/).
The client must match the training server; psql 17 alone is not sufficient
for dumping PostgreSQL 18. Create a dedicated `crowdaware-ml-export` system
account. Install root-owned `remote-exports.py` at
`/opt/crowdaware-ml-exports/`, a separate 0600 reader URL owned by that account
at `/etc/crowdaware-ml-exports/reader.url`, and a private output directory at
`/var/lib/crowdaware-ml-exports` (0700, owned by the account).

The private 0600 `/etc/crowdaware-ml-exports/config.json` is owned by the
worker account and has these fields:

```json
{
  "root": "/var/lib/crowdaware-ml-exports",
  "reader_url_file": "/etc/crowdaware-ml-exports/reader.url",
  "pg_dump": "/opt/crowdaware-ml-exports/pg_dump",
  "max_bytes": 17179869184,
  "reserve_bytes": 8589934592
}
```

The worker enforces the smaller client/server archive cap and larger
client/server free-space reserve on **Proxmox's** filesystem. The example
keeps 8 GiB free for the host; the built-in minimum default is 2 GiB.
The worker uses the established server-side PostgreSQL tunnel. It never
needs a Mac tunnel, writer credentials or PostgreSQL superuser access.

Install `ml-export-sshd.conf.example` as
`/etc/crowdaware-ml-exports/sshd.conf`, replacing its ListenAddress with the
Proxmox tailnet address. Validate with `sshd -t`. Install the edge's public
key for this account with `restrict` and a forced command pointing to
`remote-exports.py`. Enable `crowdaware-ml-exports.service` and
`crowdaware-ml-exports-cleanup.timer`. This separate private listener accepts
only the worker account, rejects shells/PTYs/forwarding, and permits only
generation of named training tables or a bounded byte range from a completed
archive UUID. Interactive host SSH and the SchemaSpy report channel are unchanged.
The hourly cleanup skips archives leased by active streams and removes ZIPs,
partial files and receipts once they expire. Generation uses a single global
lock, a two-hour timeout and private child credentials; progress is bounded
JSON, never SQL or database diagnostics.

The existing authenticated download URL stays unchanged. The edge forwards
only the requested bytes from Proxmox to the browser with backpressure,
Content-Length, byte ranges, private no-store headers and account/permission
revocation checks. It verifies the stream length and SSH completion so a
truncated transfer fails. This removes AWS **disk staging**; transfer traffic
still passes through the edge and its Cloudflare Tunnel. Docker includes
`openssh-client`; mount the private key/pinned hosts read-only and make the
key readable only by the container's unprivileged service user.

A ZIP contains **selected tables**, not a whole-database backup. A training
schema preamble is included, but dependencies outside the selection are not.
Select related tables together (pairs/annotations require frames) and restore
only into a separate database with matching dependencies. Large-object
payloads are normal bytea data in the SQL dump. Original payload bytes and
metadata are preserved. This does not apply retention to source recordings.

## Cloudflare

Before production use, configure a **Bypass cache** Cache Rule for the algo
host where the URI path starts with `/api/ml-data/`. Keep Cloudflare Access
and the console's account sign-in on these paths. This is a cache exemption,
not an authentication bypass. Check an authenticated download's headers and
complete a transfer through the real tunnel after deployment.

Background generation avoids waiting for a dump in the trigger request.
Delivery begins immediately from an existing file; streams remain subject
to network and proxy read/inactivity limits. Streaming does not guarantee
an indefinitely stalled connection will survive. Byte-range support allows
resumption of interrupted transfers. Cloudflare's current documented default
proxy read timeout is 125 seconds, rather than the old 100-second assumption.
See [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
and [cache eligibility](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

## SchemaSpy runs on Proxmox

Java/Graphviz and the SchemaSpy job run on **proxmox1**, never on the Mac or
in the edge HTTP process. The edge serves the generated static snapshot;
its separate table/column browser always queries the live PostgreSQL catalog.
Views are documented but are not table-export choices. No expensive row
count is needed for this report (`norows`); table counts in the browser are
explicitly PostgreSQL estimates.

`deploy/training/generate-schemaspy.py` needs a private reader URL file,
SchemaSpy 7.0.2, PostgreSQL JDBC 42.7.8, Java and Graphviz on Proxmox. Download
jars from their official releases, verify the SchemaSpy release's SHA-512,
and use absolute paths. The supplied change-watching systemd service/timer templates
use a dedicated `crowdaware-schemaspy` system user; install its tools into
`/opt/crowdaware-schemaspy`, credential into `/etc/crowdaware-schemaspy/reader.url`
and create `/var/lib/crowdaware-schemaspy` owned by that user and group (0750).
Point the URL at a **server-side** private PostgreSQL forward with pinned SSH
host keys and the existing permitted tunnel hop. The job's connection must
not depend on a tunnel running on the Mac.

```sh
python3 /opt/crowdaware-schemaspy/watch-schemaspy.py \
  --reader-url-file /etc/crowdaware-schemaspy/reader.url \
  --schemaspy-jar /opt/crowdaware-schemaspy/schemaspy-app.jar \
  --jdbc-jar /opt/crowdaware-schemaspy/postgresql.jar \
  --output /var/lib/crowdaware-schemaspy/report
```

The watcher uses native `psql` to fingerprint the training catalog, including
columns, constraints, indexes and views, and PostgreSQL's insert/update/delete
counters. It never scans recording payloads or counts rows. The timer checks
30 seconds after the previous run finishes; a burst of writes produces one
snapshot rather than overlapping Java processes. PostgreSQL statistics can
lag the writes briefly. `--schema-only` disables row-change monitoring where
only structural changes should regenerate a diagram. See the official
[cumulative statistics documentation](https://www.postgresql.org/docs/18/monitoring-stats.html).
Row-change monitoring requires PostgreSQL `track_counts=on`; the watcher
fails explicitly if it is disabled.

Install `crowdaware-schemaspy-tunnel.service`, with a dedicated private SSH
key and pinned `known_hosts` under `/etc/crowdaware-schemaspy`. Its
`tunnel.env` sets `SCHEMASPY_DATABASE_HOP` to the established, permitted
`training-tunnel` hop. That account's key allows only the PostgreSQL forward,
with no shell; preserve existing keys and HBA. Enable the tunnel and
`crowdaware-schemaspy.timer`. The job and tunnel run entirely on Proxmox.

The generator locks concurrent runs, uses a private temporary properties file
(no password in argv), caps runtime to 15 minutes, scans generated output for
the credential, and replaces the previous report only after success. Failed
Java diagnostics are redacted into a 0600 `schemaspy-error.log` alongside the
report; they are never returned to browsers. The watcher bundles only the
**report directory** into `report.tar.gz` and publishes a SHA-256/size receipt.
A separate report-only SSH account can read these two files through the
forced `serve-schemaspy.py` command (`status` or `report`). Configure its
authorized key with `restrict` and the forced command; give it read access
to the report archive and receipt, never the reader URL or tunnel key.

Where Tailscale SSH requires an interactive check on port 22, use the separate
report-only listener on port 2222. Install `report-sshd.conf.example` as
`/etc/crowdaware-schemaspy/report-sshd.conf`, replace its ListenAddress with
the Proxmox tailnet address, validate it with `sshd -t`, and enable
`crowdaware-schemaspy-report.service`. It accepts only the report account's
public key, forces the two report commands, refuses forwarding and PTYs,
and never binds a public address. Pin this listener's host key as
`[<tailnet address>]:2222` on the edge. Interactive host SSH is unchanged.

Install `sync-schemaspy.py` on the edge at `/opt/tmedge-schemaspy` and the
`tmedge-schemaspy-sync.service`/timer. The private
`/etc/tmedge-schemaspy-sync.env` supplies `SCHEMASPY_REPORT_HOST`,
`SCHEMASPY_REPORT_KEY`, `SCHEMASPY_KNOWN_HOSTS` and `ML_SCHEMA_DIR`.
The service's report key is 0600 and the host key must be pinned through
the trusted admin connection. It polls every 30 seconds between runs,
skips unchanged hashes, bounds compressed/unpacked size, refuses archive
links and unsafe paths, verifies SHA-256, and stages a complete report before
replacing the prior snapshot. Failed generation or transfer keeps the last
published snapshot. No database credentials, jar or diagnostic log cross
this report channel. These data artifacts and job tools live outside
`/opt/tmedge` and are independent of the application release pipeline.
The sync client's `--port` defaults to 2222.

The ML data page displays the Graphviz image on the right (below the tools on
narrow screens). Authenticated `GET /api/ml-data/schema/diagram` supplies
the snapshot timestamp and content revision; `/schema/diagram/image` under
the same API prefix serves the fixed PNG with private no-store headers.
The page checks the revision every 15 seconds and reloads changed images;
selecting the image opens its full size. An unavailable diagram is explicit,
and a failed metadata refresh keeps the prior image and its timestamp.

The report is available at `/api/ml-data/schema/report/` only after sign-in,
inside an opaque sandboxed frame. Its navigation bridge only asks the parent
to load URLs inside the report directory, so SameSite sessions continue to
work without giving report scripts access to the console's DOM. SchemaSpy's inline resources get their own CSP;
the main console retains its existing CSP. Database diagrams and report-specific
scripts/styles are embedded in authenticated HTML, because Chromium blocks
opaque-frame subresource cookies. Only SchemaSpy's generic bundled vendor
libraries/fonts are public at `/ml-schema-assets/`, like the console's login
bundle; no database metadata is served there. The opaque report alone permits
inline/evaluated library scripts, without access to the parent console DOM. Missing output is stated explicitly,
with live definitions still usable. SchemaSpy reports are snapshots refreshed
by the Proxmox watcher. Official [SchemaSpy documentation](https://schemaspy.readthedocs.io/en/master/)
and [release](https://github.com/schemaspy/schemaspy/releases/tag/v7.0.2).

## Validation

`test/ml-data.test.ts` covers real child/ZIP generation, persistence, SHA-256,
owner epochs, restart recovery, failure cleanup, quota, auth/CSRF, asynchronous
202 responses, range downloads and account changes during queries.
`test/ml-data-postgres.test.ts` uses a disposable PostgreSQL database with a
real SELECT-only role, SQL write/multi-statement rejection, bounded binary/text
previews, duplicate result columns, native pg_dump and real psql restore.
CI runs that integration on PostgreSQL 17; local verification used PostgreSQL
16. Live PostgreSQL 18 reader schema/query probes and the Proxmox-generated
SchemaSpy snapshot are checked separately. No full live database backup is
performed during development.

`python3 deploy/training/test-schemaspy.py` checks change detection, failed
generation recovery, the report-only channel, safe extraction, hash-verified
private synchronization and retry after transfer failure. It mocks generation;
Java/Graphviz never run on the Mac. The actual watcher and reader fingerprint
are verified separately on Proxmox.

`test/ml-data-remote.test.ts` covers remote progress/receipts, an 8.4-GiB
selection without any local dump or ZIP, restart persistence, owner isolation,
HEAD/ranges/resumption, truncation, account revocation and SSH configuration.
`python3 deploy/training/test-remote-exports.py` verifies actual ZIP64 output,
checksum/CRC, native-process failure cleanup, quota, safe fixed commands,
concurrent-job rejection and retention of leased downloads.

Browser tests exercise the ML dropdown, query results, schema, table selection
and async ZIP preparation in Chromium and WebKit, with both themes at phone
width and all console modules from 320px to 1440px. Production rollout still
requires the protected pipeline, the private connection/client/report setup,
and the Cloudflare cache rule above.
