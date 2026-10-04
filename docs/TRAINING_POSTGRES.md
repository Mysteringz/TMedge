# PostgreSQL training recordings

Production storage is `crowdaware_training` on PostgreSQL 18 in Proxmox LXC
105 (`postgresql`, 192.168.3.180), managed through root@100.68.138.39. Its disk
was expanded from 4 GB to 32 GB. No model training runs on the edge or guest.

`TRAINING_STORAGE=postgres` selects the private disk outbox in
`/var/lib/tmedge/training`. The existing Record switch controls collection and
persists across releases. Every accepted RAW from a real node and every RGB
frame from an eligible rig is retained while recording is enabled, including
unmatched frames. The legacy 2-second/empty-frame sampling and 400 MB corpus
budget do not apply to this backend. No public HTTP/WS schema changes.

`tmedge-training.service` transfers the outbox every 10 seconds using an
isolated Python venv with `psycopg[binary]==3.2.13`. It also imports legacy pairs.
Transactions, stable IDs, original-record fingerprints and database-checked
SHA-256 hashes make retries idempotent. Sources are removed only after commit
and verification. Errors retain the outbox. Corrupt files require inspection;
do not prune the outbox. The console's Prune button refuses deletion in this
backend. There is no automatic database retention policy.

The worker connects to 127.0.0.1:55432 via `tmedge-training-tunnel.service`, an
SSH tunnel over Tailscale to the Proxmox host, forwarding only to the guest's
PostgreSQL port. Its dedicated key permits that destination and no shell.
Credentials are generated on the host, never committed or printed, and
transferred privately to `/opt/tmedge-training/database.env` (mode 600).
The database HBA admits its roles only from the Proxmox host LAN address.
`crowdaware_ingest` can SELECT/INSERT frames and pairs; `crowdaware_reader`
can only SELECT. Neither has superuser, database creation or role creation.
An annotation writer should receive a separately reviewed grant when needed.

## Data model

`training.frames`: sensor UID, modality, frame number, capture/receipt/reference
UTC timestamps, timestamp basis, dimensions, original byte payload, SHA-256,
thermal t_min/t_step, observed detections, original metadata and ingestion time.
Thermal payloads are row-major 24x32 quantized uint8 levels exactly as received;
temperature in Celsius is `t_min + level * t_step`. These are the raw values
the telemetry transmits, not the pre-quantization sensor floats. RGB payloads
are the original JPEGs, not lossless uncompressed camera buffers. No upstream
quantization or JPEG compression is reversible.

`training.pairs`: thermal/RGB foreign keys, absolute skew <=400 ms, orientation
and provenance. Missing or distant thermal frames do not discard the RGB frame.
`training.annotations`: versioned labels with source and timestamp, deliberately
separate from device observations. Device detections are not ground truth.
`training.ml_samples`: one joined sample per pair, original bytes, timestamps,
calibration and `temperatures_c` as a 768-element real array; reshape to (24,32).
Split training/evaluation by session or time interval to avoid adjacent-frame
leakage. Empty observations and unavailable observations are different.

Legacy pairs have an RGB camera timestamp (recorded after JPEG encoding), frame
number and absolute skew, but no signed skew or thermal receive timestamp.
Their thermal `captured_at`/`received_at` are NULL and their `reference_at` is
the RGB timestamp, explicitly marked `legacy_pair_reference`. No historical
thermal timestamp is fabricated. New thermal timestamps are edge receipt time,
not sensor exposure time; RGB capture time is the bridge's clock after encoding.
Skew compares those two clocks. Hardware synchronization and exposure-time
measurements would require a separate rig/protocol change.

## Access and export

Keep NordVPN on. From this Mac, use the secondary userspace tunnel:

```sh
ssh -N -o 'ProxyCommand=/opt/homebrew/bin/tailscale --socket=/Users/netitornk/.tmedge-tailscale/tailscaled.sock nc %h %p' \
  -i /Users/netitornk/.ssh/tmedge_ed25519 \
  -L 127.0.0.1:55433:192.168.3.180:5432 root@100.68.138.39
```

Retrieve the reader password privately from
`/root/crowdaware-training-credentials.json` on Proxmox and supply it through
your database client's secret store. Host=127.0.0.1, port=55433,
database=crowdaware_training, user=crowdaware_reader. Do not paste it into logs.

```sql
SELECT sensor_uid, modality, count(*), min(reference_at), max(reference_at)
FROM training.frames GROUP BY sensor_uid, modality;
SELECT sample_id, sensor_uid, sample_at, temperatures_c, rgb_jpeg
FROM training.ml_samples WHERE sample_at >= '2026-09-26T00:00:00Z'
ORDER BY sample_at;
```

`tools/export_training_postgres.py --out <empty-directory> --sensor <uid>
--start <ISO-UTC> --end <ISO-UTC>` uses `TRAINING_DATABASE_URL` and produces
JSON/JPEG pairs accepted by `tools/train_human_location.py`. It streams the
chosen interval with a server cursor. Install psycopg in an isolated venv on
the training machine. NumPy/OpenCV remain offline-trainer dependencies only.

## Operations and rollback

On EC2 inspect `systemctl status tmedge-training tmedge-training-tunnel`,
the worker journal, queue file count and `training/status.json`. Check guest
disk capacity with `pct exec 105 -- df -h /`. Collection at full frame rate
uses more storage than legacy sampling; provision retention/backups before
long collection runs. The guest uses the existing Proxmox `proxpool` volume.

The original 7,052-pair corpus is recoverable from the private archive
`/var/lib/tmedge/training-backups/pre-postgres-20261004.tar.gz` on EC2.
After migration PostgreSQL is authoritative and verified legacy files are
removed; that single archive is retained as a recovery copy. It is not a
backup of subsequent database recordings. Configure Proxmox guest backups to
a separate destination for long-term protection.

Application changes use `deploy/deploy.sh` and release manifests as usual;
the independently managed tunnel/worker live in `/opt/tmedge-training`.
To revert collection, turn recording off, drain the outbox, set
`TRAINING_STORAGE=files` in the shared environment and restart the edge (or
activate the previous release). This does not delete PostgreSQL data. Use the
exporter if an older disk-only trainer needs the corpus. Restoring the initial
archive must target an empty staging directory first, not overwrite live files.

## Verification on 2026-10-04

Live application release: `20261004T093911Z-7c24131550f1`, based on the latest
`bc59544` deployment-tooling update. Source is committed locally on
`feat/training-postgres` in `.training-postgres/`; it has not been pushed.

All 7,052 historical pairs were migrated and verified: 7,052 thermal payloads
and 7,052 JPEGs (184,070,916 payload bytes). A bounded live test then committed
24 thermal and 49 RGB frames, yielding 22 additional pairs. Totals: 7,076
thermal frames, 7,101 RGB frames and 7,074 matched samples. The queue drained
and the original recording-off switch was restored. Both transfer services
are enabled and running. Edge, web and node-listener health checks passed.

Verification: typecheck; 140 passing application tests, one pre-existing
NumPy/OpenCV-dependent trainer test skipped; 19 firmware crosschecks;
archive tests; 13 deployment rehearsal checks; real-database deduplication,
source removal after commit, conflicting-record retention, hash rejection,
768-temperature array checks and a one-pair trainer-compatible export.
Reader SELECT is allowed, reader INSERT and ingestion DELETE are denied.

The requested private training database changes the old edge-only storage
boundary: training imagery now leaves the edge over the private Tailscale SSH
tunnel to this database. Student-facing APIs still contain no imagery.
