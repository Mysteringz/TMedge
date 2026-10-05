# Encrypted TMsense protocol and migration

Implemented jointly in TMsense 1.7, TMedge and TMWAccess. This is source-level
validation, not a production or physical M3 acceptance certificate. Follow the
[security specsheet](SECURITY_BUG_SPEC.md) and checked release pipeline before
enabling it on a pilot.

## Wire contract

All integers are little endian. Wire version 2 retains the v1 message payloads,
but replaces the header and legacy HMAC with AES-256-GCM ciphertext and a full
16-byte authentication tag. Firmware uses the ESP32 SDK's mbedTLS GCM; edge uses
Node's crypto API. No plaintext is delivered before tag verification.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 2 | ASCII `TM` |
| 2 | 1 | Version `2` |
| 3 | 1 | Type: REPORT 1, RAW 2, STATUS 3, OTA_STATUS 4, COMMAND 16, OTA 17, ACK 18, CONTROL 19 |
| 4 | 6 | Factory MAC / UID |
| 10 | 4 | Persistent boot counter |
| 14 | 4 | Sequence |
| 18 | 4 | Uptime milliseconds |
| 22 | 2 | Plaintext/ciphertext payload length |
| 24 | 2 | Nonzero key ID |
| 26 | 16 | Fresh random key epoch |
| 42 | variable | Ciphertext |
| 42 + length | 16 | GCM tag |

The entire 42-byte header is authenticated as AAD. Maximum payload is 776
bytes, maximum datagram 834. REPORT truncates at 21 detections and remains
219 bytes, within the 222-byte transport budget. RAW is 834 bytes. Gateways
validate shape/size and relay bytes unchanged; they hold no sensor master keys.
UID, type, boot/sequence, key ID, lengths and timing remain visible routing
metadata. Encryption does not hide traffic analysis or compromised endpoints.

## Key schedule, nonce and replay

Provision a distinct cryptographically random 32-byte master for each UID.
HKDF-SHA256 derives 32 bytes using that master as IKM. `info` is ASCII
`tmsense2/<role>` followed by NUL, the six UID bytes and the two-byte LE key ID.
Salt is the 16-byte packet epoch for packet roles, or 32 zero bytes for `auth`.
Roles `uplink`, `downlink`, `ack` and `auth` separate directions and purposes.
The GCM nonce is four zero bytes, boot LE32 and sequence LE32.

Firmware generates a fresh 128-bit epoch with `esp_fill_random` after Wi-Fi
radio initialization on each loaded packet context. Edge generates a fresh
epoch with `crypto.randomBytes` for every downlink, ACK and control message.
New epoch-derived keys protect nonce uniqueness even if a counter backup is
restored; replay protection separately refuses old counters. This relies on
ESP32 radio-backed entropy and the operating system CSPRNG, and needs hardware
acceptance. A replay cursor must never be deliberately reset for a retained key.

Firmware commits boot32 before enabling networking; factory reset preserves
boot32, command high-water, encryption policy and key. Enrollment uses a required
policy flag followed by one atomic key blob with readback. Interrupted writes
fail closed. Packet sequence or boot exhaustion disables transmission instead
of wrapping. Legacy v1 stops at its 16-bit boot limit. Received COMMAND/OTA
sequence must match the authenticated header and persist before effects.

Edge verifies, reserves and fsyncs replay state before setting routes, emitting
events or acknowledging packets. Old/out-of-order packets fail the same strict
`(boot, seq)` rule. Damaged journals and failed fsync latch admission closed.
ACK payload is the acknowledged REPORT/STATUS type byte; its header identifies
the original boot/sequence. Firmware also matches a recently sent packet, so a
captured ACK cannot prove another report. Only accepted REPORT ACKs prove OTA
probation health for enrolled UDP nodes.

## Direct WSS controls

The WebSocket subprotocol stays `tmnode.v1` for routing compatibility. Challenge
and auth JSON remain plaintext inside TLS; auth uses the derived per-device
`auth` key. They disclose no master or sensor payload. Enrolled READY, ACK and
OTA grant messages use binary v2 CONTROL packets. First derive `control` from
the master with the server's full fresh 32-byte challenge as salt, then derive
`control-message` from that root with the packet epoch. CONTROL boot is zero
and sequence increases from 1 for the session. UID, key ID, tag, sequence and
challenge binding are checked before control effects. After challenge, plaintext
controls are refused. Commands/OTA datagrams use the independent `downlink` role.

Keep WSS certificate, hostname and date validation. Cloudflare can see routing,
challenge/proof metadata, timing, lengths, and the separately scoped bearer on
the subsequent HTTPS firmware download; it cannot decrypt v2 sensor payloads or
encrypted socket grants without the sensor key. Firmware bytes are authenticated
by the encrypted OTA request's SHA-256. This protocol provides neither forward
secrecy after master-key compromise nor firmware signing against a compromised
trusted edge. Secure boot/flash encryption require a separate provisioning plan.

## Private identity files

Store these outside release directories, owned by the service, mode 0600,
parent directory 0700. Files are bounded to 2 MiB and 5,000 identities. Generate
secrets directly into private files using a trusted provisioning tool and OS
CSPRNG; never put them in uploaded sources, logs, PRs, nodes.json or a shared
site secret. The following strings are schema placeholders, not working keys.

`DEVICE_KEYS_FILE`:

```json
{"version":2,"nodes":{"01:02:03:04:05:06":{"current":{"id":7,"secret":"<64 lowercase hex digits>"}}},"legacy":["11:12:13:14:15:16"]}
```

Each device may have `previous: {id, secret, expiresAt}` during a maximum 30-day
overlap, with a different ID and secret. `expiresAt` is an absolute Unix time in
milliseconds. `revoked: true` refuses both keys. Duplicate secrets are refused.
When this policy is configured, only explicitly listed legacy UIDs can use v1;
unknown, revoked and encrypted UIDs cannot downgrade. Restart the service after
replacing its key file; current/previous expiry is checked during traffic.

`TMGW_KEYS_FILE` uses each gateway's own credential, as 64-hex **text** matching
its `TMGW_TOKEN` value, not decoded sensor key bytes:

```json
{"version":1,"gateways":{"site-gw-1":{"current":"<64 lowercase hex digits>","previous":{"secret":"<different 64-hex text>","expiresAt":1790000000000}}}}
```

Gateway revocation and expiry apply to established sessions. No shared-token
fallback exists when this file is set. HELLO nonces persist in
`DATA_DIR/gateway-hellos.json`; replay after restart and backward clock jumps
fail closed. Public routes use WSS. Raw TCP defaults off; explicitly enabled
raw TCP accepts only loopback/Tailscale peers and requires an authenticated
encrypted network. TMWAccess's `TCP_ENCRYPTED=1` declares that requirement; it
does not itself implement TLS. Edge-approved downlinks protect a known route
from eviction by eight spoofed LAN candidates. Restrict the sensor subnet to
prevent identity floods and radio/network denial of service.

`WEB_EDGE_KEYS_FILE` on the student web service binds its publisher bearer to
an edge ID and exclusive floor IDs:

```json
{"version":1,"edges":{"edge-1":{"token":"<64 lowercase hex digits>","floors":["floor-1"],"revoked":false}}}
```

Each edge sets its own `WEB_PUSH_TOKEN` to its entry's token. Unknown identity,
wrong token, revoked publishers and foreign floors fail closed; no shared-token
fallback exists with this file. Coordinate floor ownership changes and restart
the web service after credential changes.

## Pilot provisioning, rotation and recovery

1. Publish the coordinated firmware/gateway branches and use their commit pins
   in the edge CI. Back up persistent journals, accounts/config and private keys
   securely. Install compiler isolation prerequisites and exercise it under the
   real service UID before the checked deployment. Keep old legacy UIDs listed
   explicitly during a controlled migration.
2. On one physical pilot, install and confirm 1.7-compatible firmware in **both
   OTA partitions before enrollment**. An older rollback image does not know
   `secure_req` and could emit plaintext. Verify partitions/bootloader behavior;
   do not enroll a device whose fallback is incompatible. The edge's version
   guard refuses accidental OTA to versions below 1.7 or unknown versions for
   encrypted targets; a version label is not a cryptographic code guarantee.
3. Provision the UID's key into the private edge file; remove that UID from
   `legacy`. With trusted local serial provisioning and logging disabled, send
   `set secure <id>:<64hex>`. The command persists, verifies and reboots without
   printing the secret. Do not use a shared terminal log/history for this value.
   `show` reports only required/legacy and key ID. No remote key enrollment or
   insecure recovery command is provided.
4. Confirm STATUS/RAW/REPORT, fresh accepted REPORT ACKs, commands, WSS reconnect,
   UDP routing, disk-restart replay protection and one OTA cycle. Capture both
   transports and verify the gateway sees ciphertext. Measure CPU/RAM/frame
   rate; test power loss, corruption, sensor stall and rollback before fleet use.
5. To rotate: generate a new distinct master and unused key ID, put old current
   under `previous` with a short bounded expiry, install new current on edge and
   restart; provision the pilot locally; verify its new ID and fresh reports;
   then repeat per sensor. Remove previous after overlap. Never reset counters
   or add an enrolled UID to the legacy list as a recovery shortcut.
6. To revoke: set `revoked`, atomically replace the 0600 policy and restart.
   Replace compromised hardware/keys. Lost or interrupted enrollment needs
   trusted physical reprovisioning that retains boot/command high-water and the
   required flag. Factory reset does not erase that policy. Keep compatible
   recovery images; irreversible eFuses require explicit hardware planning.

Account and revocation files now serialize short commits using a private
exclusive lock and durable atomic writes. If a process crashes holding a lock,
confirm that its writer has stopped before removing the stale `.lock` file.
Do not share these files over a filesystem without local lock/rename/fsync
semantics; distributed scaling needs a transactional account/session database.
Credential-bound cookies invalidate old student sessions and password resets;
previously Google-linked accounts cannot use an unverified legacy password.

## Reproducible checks

- Firmware: native mbedTLS known-answer/tamper tests; NVS/OTA/I2C fault suite;
  encrypted WSS control downgrade/replay/session tests; packet and listener
  vectors; both ESP32 build environments.
- Edge: all-byte header/ciphertext/tag mutations, UID/key/direction isolation,
  rotation/revocation/downgrade, delayed/failing fsync and persisted replay;
  real C++ packet/parser and direct-session crosschecks.
- Gateway: real firmware REPORT -> gateway -> durable edge -> encrypted ACK,
  encrypted COMMAND -> real firmware parser, replay/tamper refusal, for TCP on
  loopback and WebSocket relay; approved-route flood regression.
- Accounts/publishers: actual concurrent Node writers, stale-lock/corruption
  refusal, merged revocations, linked-password/cookie invalidation, real HTTP
  per-edge identity/floor ACL, persisted gateway HELLO replay.
- PostgreSQL: fresh/idempotent/legacy schema upgrade, real worker retry,
  conflict/source retention, FK/calibration/hash constraints. CI uses an empty
  disposable database and never production credentials.

See the specsheet's final acceptance record for executed results and remaining
physical, deployment and load acceptance. Passing these checks does not establish
that every possible vulnerability has been found.
