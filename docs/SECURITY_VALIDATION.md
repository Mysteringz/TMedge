# Security remediation validation — 2026-10-04

Source-level acceptance for the coordinated `fix/security-audit-encrypted-telemetry`
branches in TMedge, TMsense and TMWAccess. Findings, fixes and release gates are
in [SECURITY_BUG_SPEC.md](SECURITY_BUG_SPEC.md); key provisioning and wire details
are in [ENCRYPTED_NODE_PROTOCOL.md](ENCRYPTED_NODE_PROTOCOL.md).

## Executed local checks

| Repository / command | Result |
|---|---|
| TMedge `npm test` | 207 passed, 0 failed/skipped |
| TMedge `npm run typecheck` and `npm run build` | Server, console and both UIs passed |
| TMedge `npm run crosscheck` | 27 real firmware/edge/direct-session checks |
| TMWAccess `npm test`, compilation and `npm run crosscheck` | 24 tests; 14 real relay/edge/firmware checks |
| TMsense `bash test/host/build_secure_host.sh` | 79 native mbedTLS checks, including AES-GCM known-answer, tampering, ACK and downgrade |
| TMsense `test/host/build_cloud_host.sh && build/cloud_test && build/display_test` | 124 cloud and 27 display checks |
| TMsense `bash test/host/build_safety_host.sh && build/safety_test` | 44 NVS/OTA/I2C fault checks under UBSan |
| TMsense `python3 test/host/detector_test.py` | 23 scenarios passed; warm-laptop limit remains documented |
| TMsense `python3 test/host/listen_test.py` | 5 tests passed; repeated with pinned cryptography 50.0.2 |
| TMsense PlatformIO 6.1.18 `run -e tmflash -e tmsense_testcloud` | Both ESP32-S3 variants passed; test variant never released |
| TMedge complete uploaded release project through `FirmwareStore.build` | Real bubblewrap isolated compile succeeded; private-include refusal is also in regression suite |
| TMedge `python3 deploy/test-release.py` / `deploy/test-receiver.py` | 3 / 6 tests passed |
| TMedge `python3 deploy/training/test-offline.py` | 8 tests passed |
| TMedge real `deploy/training/test-postgres.py` | 20 checks each on disposable UTF8 PostgreSQL 14 and 16 databases with psycopg 3.3.6, no production access |
| TMedge `deploy/test-deploy.sh` | 14 local deploy/rollback/locking/pruning checks; no server contacted |
| Docker builds for TMedge and TMWAccess | Both documented Dockerfiles built successfully |
| Git whitespace, host build shell syntax and Python compilation | Passed |

Final isolated image: `tmsense-1.7`, **970,224 bytes**, SHA-256
`3f69dafad09bc9f96ff71e4481506427c8cf6093bd23470afeac89f263f2e425`.
This local image is evidence of successful isolated compilation, not a published
release or an image approved for fleet deployment. Service compiler isolation
binds only system tools, a dedicated installation, read-only preinstalled SDKs
and uploaded source; it exposes no server data or network.

The relay crosscheck consumes actual C++-built encrypted REPORT bytes and parses
its ACK/COMMAND with the actual firmware parser, for loopback TCP and WebSocket
gateway transports. Duplicates and altered tags produce neither events nor ACKs.
The direct crosscheck runs the firmware's actual session code against NodeServer.
Host control faults refuse plaintext, tag alteration, replay and wrong-session
ACKs. Encrypted wire size tests cover the 219-byte REPORT and 834-byte RAW limit.

PostgreSQL acceptance creates an empty disposable database and refuses an
existing training schema. It verifies fresh/idempotent/legacy upgrades, exact
deduplication, matching modalities, nonfinite calibration/hash rejection,
conflicting/missing/cross-sensor source retention, successful delayed retry, and
failed dirty-legacy migration followed by explicit repair. The same tests pass
against the pinned PostgreSQL 16 container used by CI. Hosted CI still requires
publication of the branches.

Dependency advisory checks found zero known vulnerabilities for root/server
production, student, engineer and gateway lockfiles at PR preparation; a zero result reflects the
registry at check time, not a guarantee against future advisories.

## Read-only live prerequisite inspection

EC2 remains on `20261004T100403Z-4ff2098f872c`; edge and web services are active.
The shared environment file is mode 0600 owned by tmedge. `/var/lib/tmedge` is
writable by the service; services use `User=tmedge`, `ProtectHome=yes`,
`NoNewPrivileges=yes`, `RestrictNamespaces=no`. **bubblewrap is absent**, so
new isolated builds would correctly fail closed until it is installed and
exercised under the real service UID. No connected USB/ACM serial device was
found. The live environment was not changed and no credential values were
included in output or this report.

No new M3 physical encrypted telemetry capture, key provisioning, OTA cycle,
power-loss test or rollback-slot compatibility check ran. The earlier successful
live 1.5 OTA is documented separately in [OTA_TEST_REPORT.md](OTA_TEST_REPORT.md).
It does not validate this release. Both OTA slots must run compatible firmware
before enrollment, and a version label alone cannot prove trusted firmware.

## Release acceptance still required

- Publish/review all three PRs and their cross-repository commit pins; run hosted
  CI, including PostgreSQL 16 and macOS gateway checks. GitHub authentication was
  unavailable during local preparation.
- Back up persistent replay/HELLO/parameter/revocation journals, accounts,
  configuration and private keys. Install/test the compiler prerequisites under
  the live service policy, then deploy through the checked release pipeline.
- Rehearse the production training schema against its snapshot and review any
  invalid legacy rows. No production training migration was performed.
- Provision one physical pilot with compatible active/fallback images, unique
  credentials and explicit no-downgrade policy. Capture encrypted UDP/WSS traffic;
  confirm fresh REPORT ACKs, commands, disconnect/reconnect and a complete OTA.
- Exercise cold boots, entropy, sensor stalls, reset/pre-init failure, interrupted
  NVS writes, power loss, storage pressure and rollback. Measure CPU/RAM/frame
  throughput and expected fleet fsync/disk/backpressure capacity; set alerts.
- Decide verified university enrollment and distributed account storage if those
  policies are needed. Secure boot/flash encryption/eFuse provisioning requires
  a reviewed physical device plan; none was performed by this audit.

Only after the pilot proves the new image, sensor and accepted REPORTs should
the remaining fleet be touched. No claim of complete vulnerability elimination
or hardware validation follows from source tests alone.
