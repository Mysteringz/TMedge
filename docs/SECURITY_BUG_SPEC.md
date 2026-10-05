# TMedge / TMsense / TMWAccess security and bug specsheet

Date: 2026-10-04. Status: source fixes and encrypted wire v2 implemented and locally validated; coordinated PRs opened on 2026-10-05; production and physical acceptance remain open. No audit patch has been deployed to EC2 or flashed onto M3.

This document records confirmed defects, their fixes, validation, and remaining work. It is not a claim that a source review can find every possible vulnerability. The review covers repository-owned source, firmware headers/driver acquisition and calibration paths, browser code, configuration, deployment/CI, training tools, and tests in all three repositories. Dependency directories and generated binaries/bundles are excluded from line-by-line review; build and dependency advisory checks cover those separately. Generated fonts, logos, trust-root data and minified third-party browser libraries have narrower review coverage. See [source inventory](AUDIT_SOURCE_INVENTORY.md).

Existing user changes, including Google sign-in work, were preserved and reviewed. Secrets are excluded from this report. Base revisions and the complete path inventory are in the inventory file. Every finding marked patched below refers to the review branches, not the live server. Published PRs: [TMedge #42](https://github.com/Mysteringz/TMedge/pull/42), [TMsense #8](https://github.com/Mysteringz/TMsense/pull/8), [TMWAccess #8](https://github.com/Mysteringz/TMWAccess/pull/8).

## Architecture and boundaries

- TMsense acquires thermal frames and detects blobs. Enrolled v2 devices encrypt/authenticate telemetry, commands and OTA requests with unique device keys; WSS and enrolled UDP require accepted REPORT ACKs. Legacy UDP remains migration-only.
- TMWAccess relays byte-identical sensor packets, routes downlinks, caches firmware by SHA-256 and serves images to the sensor subnet. It intentionally has no node signing keys.
- TMedge verifies telemetry and replay cursors, resolves table authority/occupancy, records private data, builds firmware and coordinates a pilot-first rollout. The algo console can view imagery and change parameters.
- The student web tier receives only validated public occupancy snapshots and offers read-only occupancy/search APIs. Its account/session handling is separate from engineer accounts.

## TMedge edge, algo, build and deployment findings

All items in this table are patched locally. Severity describes the reachable trigger and impact; an authenticated administrator's ability to change firmware is intentional, but reading unrelated service credentials through a build is not.

| ID | Severity | Defect / trigger and impact | Applied fix / files | Validation |
|---|---|---|---|---|
| EDGE-01 | High | Signed uplink replay cursors and command sequences existed only in RAM. Restarting the edge made previously accepted captured packets eligible again; clock rollback could reuse downlink counters. | Durable write-ahead node/command cursors, checked before admission; command high-water incorporates STATUS; damaged/torn journals fail closed. `src/edge/replay.ts`, `ingest.ts`, `runtime.ts`. | Restart/replay/reset regression and command monotonicity tests. |
| EDGE-02 | High availability | Naive per-packet synchronous fsync would block the single event loop under normal fleet traffic. Asynchronous acceptance could alternatively ACK before durability or admit concurrent duplicates. | Bounded per-UID admission ordering; grouped asynchronous fsync; routes, occupancy events and WSS ACK only after durable completion; failure latch and shutdown draining. Production UDP, gateway and WSS use `handleDurable`. | Delayed-sync regression proves no events/routes before durability, shared batching, concurrent duplicate refusal and failure closure; protocol crosschecks. |
| EDGE-03 | Medium | Rejection/rate diagnostic arrays could grow with packet floods; arbitrary reason strings enlarged maps. Global trimming could unnecessarily revisit every node per packet. | Explicit sample/table/reason bounds and per-link trimming; durable packet queue bounded by both messages and bytes. `ingest.ts`, `nodelink.ts`. | Malformed/admission tests; bounded paths inspected. A production fleet load test remains required. |
| EDGE-04 | High | An invalid rollout target kind fell through to selecting every node. Delayed/unrequested/mismatched OTA status could change a pilot decision or affect a later rollout. | Strict target/build identity validation; only started, nonterminal nodes for the active matching image can transition; asynchronous callbacks capture the active rollout. `rollout.ts`. | Invalid-target and stale/late/mismatched status regressions. |
| EDGE-05 | High | Uploaded PlatformIO ini/hooks could execute Python in the service context. Even a C++-only upload can read private files through absolute includes or assembler `.incbin`. | Trusted pinned Heltec V3 release recipe, source/header allowlist, excluded provisioning files, sanitized environment, mandatory Linux bubblewrap filesystem/process/network isolation exposing only system tools, dedicated compiler install, read-only SDKs and source. `firmware.ts`. | Private fixture include fails without revealing contents; a complete isolated TMsense 1.7 build succeeded with the same production FirmwareStore path. |
| EDGE-06 | Medium | Upload sessions were unbounded, mutable during compilation, and failed builds could retain a permanent building lock. Newline-free compiler output could consume memory; oversized images could be loaded whole. | Eight-upload cap, build locking with finally cleanup, no active-build discard, bounded log lines/tail and 2 MiB image limit. `firmware.ts`, `console.ts`. | Upload capacity/forbidden files and failed-build correction/retry regressions. |
| EDGE-07 | Medium | Ordinary folder uploads included hooks/secrets/docs and the old client silently skipped any rejected source file, potentially building an incomplete project. Uploaded version strings were interpolated into HTML. | Client matches the release source filter, aborts source upload errors, escapes build version/identity. `src/console-client/firmware.ts`. | Browser/server compilation and isolated real folder build. |
| EDGE-08 | High | Malformed direct-server request targets could throw out of HTTP/WS callbacks; browser cross-origin feed upgrades lacked consistent checking. Unhandled WS errors or unbounded feed payload/backpressure could terminate or overwhelm services. | Safe request-target parsing, Origin validation, payload/client/upgrade caps, error handlers, output-aware fanout. `src/shared/http.ts`, `fanout.ts`, `nodelink.ts`, `console.ts`, `src/algo/server.ts`. | Malformed URL regression, WS protocol tests, fanout tests and gateway tests. |
| EDGE-09 | Medium | Signed-in callers could submit malformed graph shapes/duplicate IDs/NaN or out-of-range parameters and cause exceptions or meaningless detector execution. | Runtime graph shape/size/ID/parameter validation before traversal and saved graph loading; run endpoint requires mutation header. `src/algo/graph.ts`, `server.ts`. | Malformed graph and API tests. |
| EDGE-10 | Medium | A model with reordered/missing feature names, wrong weight stride or non-finite weights could pass validation and produce incorrect occupancy/debug inference. | Require the exact trained feature order, finite weights, valid threshold and area. `src/algo/model.ts`. | Reordered-feature/NaN/area regressions and Python/TS feature crosscheck. |
| EDGE-11 | Medium | Unknown frame queries allocated rings; per-node retention multiplied without a global memory limit. Reboot frame numbers could match old detections/cache results. | Nonallocating reads, bounded rings/global frames, boot-separated histories and cache keys tied to received frame time. `src/algo/frames.ts`, `runtime.ts`, `server.ts`. | Unknown-query/reboot regression; existing frame pairing and detector tests. |
| EDGE-12 | Medium | Preview subprocess work and stdout/stderr were insufficiently bounded; closed child stdin could throw; header-only detector changes did not rebuild the host preview. | Two concurrent runs, 360-frame input, output/time bounds, child error handling, header mtime dependency check. `src/algo/detector.ts`. | Host detector/preview tests and builds. |
| EDGE-13 | High reliability | Temporary device changes were lost across edge restart; expired changes were removed even when recovery delivery failed. A UDP send callback was treated as proof of restoration. Repeated writes from different UIDs to a global edge parameter remembered the wrong baseline. | Persist recovery intent before dispatch, replay recovery after restart, retain/retry until matching command/value STATUS, serialize overlapping operations, shared key for global occupancy parameters. Durable atomic journal removal preserves intent on disk failure. `src/algo/params.ts`. | Offline/restart/dispatch-without-ACK/STATUS recovery tests; live parameter tests. |
| EDGE-14 | Medium | Occupancy tuning accepted NaN and invalid coupled window/min values; shrinking the window left old samples accumulated. | Finite/range/coupled validation and trim sample windows on resize. `src/edge/occupancy.ts`. | Occupancy suite and parameter tests. |
| EDGE-15 | Medium | Saved background parsing could crash on null entries or trust duplicated/invalid/future buckets; ready backgrounds could remain trusted after all history expired offline. | Bounded validated saved history, unique buckets/sample bounds and age-based recomputation even during silence. `staticbg.ts`. | Corrupt/duplicate/expired history tests plus day-long background scenarios. |
| EDGE-16 | Medium | Recorder disk/stream errors could be uncaught; a slow disk grew queues; a failed stream never retried until another day. | Stream error handling, bounded queue, safe close and throttled retry. `recorder.ts`. | Runtime/recorder usage exercised by full suite; physical disk-full recovery is not separately injected. |
| EDGE-17 | Medium | Training outbox had no aggregate disk/file/free-space budget and could fill the service disk. | Aggregate 512 MiB / 10,000 record budget and free-space reserve; retain already queued sources while pausing new capture; remove failed temp writes. `src/algo/training-spool.ts`. | Existing spool regressions, typecheck and review of capacity paths. |
| EDGE-18 | Medium | Without an admin password, explicit non-loopback CONSOLE_HOST could expose private imagery. Push URLs allowed unintended schemes/credentials; redirects could forward bearer credentials; response error logging was unbounded. | Require loopback when unauthenticated; http/https URL validation with no inline credentials; refuse push redirects and cancel bodies. `config.ts`, `publisher.ts`. | Configuration/publisher/full server suite. |
| EDGE-19 | Low | Unplaced nodes bypassed type validation for flags/owns arrays. | Validate boolean flags and ownership fields before placement branch. `registry.ts`. | Registry/provisioning suite. |
| EDGE-20 | High availability | Privileged archive receiver called tar metadata parsing before effective expanded-input/member limits, enabling decompression/PAX allocation abuse. | Bound compressed and decompressed reads, metadata read sizes, streaming member count/size and full prevalidation before file creation. `deploy/release.py`. | 3 archive boundary tests and 6 receiver tests. |

## Student web, engineer auth and browser findings

Summary of confirmed fixes; the complete subsystem notes follow below. Summary IDs use WEB-S to distinguish them from detailed WEB finding IDs.

| ID | Severity | Defect / impact | Applied fix / principal files | Validation |
|---|---|---|---|---|
| WEB-S01 | High availability | Non-text credentials and rejected async auth work could escape Express 4 handlers; malformed percent-encoded cookies could crash upgrade callbacks. | Strict credential types/lengths, async catch/status paths, safe cookie parsing and duplicate handling. `src/web/main.ts`, `auth.ts`, `src/algo/auth.ts`. | Malformed credential/cookie/async outage regressions. |
| WEB-S02 | Medium | Browser backslash/normalization redirects could leave the site or loop through login endpoints. | Canonical same-origin destination validation for student, Google and engineer login. `navigation.ts`, `google.ts`, `src/algo/auth.ts`. | Redirect matrix tests. |
| WEB-S03 | High account integrity | Unverified password email could be auto-linked to a Google subject, letting a pre-registered password retain access to another person's Google identity. | No automatic linking by unverified email; known Google subjects remain stable identities; conflicting email claims are refused. `UserStore.google`, `GoogleLogin`. | Google pre-hijack/conflict/token claim tests. |
| WEB-S04 | Medium | JSON account corruption was treated as an empty store and could be overwritten. Async hashing allowed overlapping registrations to overwrite one another. | Validated account schemas, fail-closed corruption handling, recheck after hash, atomic disk-first commit. Engineer store also validates and refreshes safely. `auth.ts` in both tiers. | Corruption/concurrent registration/password reset tests. |
| WEB-S05 | Medium | Scrypt work could queue without a global cap; address spraying could erase all per-IP rate limits. Proxy trust could permit spoofed forwarded identities. | Shared eight-hash concurrency cap, fail-busy response, bounded limiter preserving existing entries; TRUST_PROXY=1 means loopback only. | Rate-limit spray, auth and proxy tests. |
| WEB-S06 | High privacy/integrity | Snapshot validation checked only top-level shape. Private fields and impossible counts could reach student APIs; migrated floors could be counted twice; edge identities accumulated indefinitely. | Exact public nested schema/geometry/count consistency, bounded identities and one owner per floor. `src/web/store.ts`. | Private-data/impossible-count/duplicate ownership/cap tests. |
| WEB-S07 | Medium | Copied cookies remained valid after logout; established feeds ignored logout/expiry/account changes. Engineer password reset did not revoke previous sessions. | Persisted session revocation; session/account checks for HTTP and live feeds; logout closes feeds; engineer cookies include account password fingerprint. Web/engineer WS credentials bind to live sessions. | Copied-cookie/restart/WS logout/password reset/token-only tests. |
| WEB-S08 | Medium | Browser/WS protocol errors, oversized incoming messages and slow clients could crash or grow memory. | Explicit WS Origin/auth validation, caps, lifecycle/error handlers and backpressure. | Web and engineer feed tests. |
| WEB-S09 | High correctness | UI kept suggesting cached free seats after disconnect or a silent feed. | Immediately make cached occupancy unknown on disconnect; silence timeout clears live state. `web-app/src/data.ts`, `live.ts`, `pages/Spaces.tsx`. | Disconnected allocation regression and UI build. |
| WEB-S10 | Medium | Signed sensor STATUS firmware strings and config parameter/table strings were placed unescaped into console HTML. | Escape text/attributes, finite numeric rendering and safe selected paths. `src/console-client/app.ts`, `firmware.ts`. | Console builds; source sink review. |
| WEB-S11 | Low | Admission form default submission closed the dialog while the async approval was pending, leaving failed requests awkward to retry. | Prevent default close, disable pending buttons and keep errors/request visible. `src/console-client/app.ts`. | Typecheck and UI build; interactive failure flow not manually exercised. |
| WEB-S12 | Medium | Personalized API/redirect shell responses could be cached; viewer asset stamps did not cover dependency content and absolute imports defeated versioned paths. | No-store/Vary session responses; content-derived stamp including dependencies; relative viewer imports. `src/web/main.ts`, `public-web/vendor/floor-viewer.js`. | Cache/redirect tests and UI build. |
| WEB-S13 | Low | Floor updates retained replaced GPU textures/materials; URL/version cache issues served old floor-viewer code after deployment. | Dispose replaced markers/textures; use versioned module graph. `floor-viewer.js`, `web-app/src/FloorViewer.tsx`. | Browser bundle/typecheck; no long-duration GPU profile performed. |
| WEB-S14 | Medium identity policy | Password signup trusted a university email suffix without verifying mailbox ownership, and the form wording suggested real HKU Portal credentials. | Signup closed by default unless SIGNUP_OPEN=1; clarify separate application credentials. Actual email verification/SSO remains follow-up. | Default config/signup tests and UI build. |
| WEB-S15 | Low | Algo reconnect work could outlive an unmounted screen, and failed writes/logout could show misleading success. Persisted pane sizes and malformed feed planes were unguarded. | Cancel reconnect timers, ignore late completions, catch and display write failures, check logout HTTP status, clamp stored panes and validate feed planes. Student logout now also preserves the signed-in screen on failure. | Both UI typechecks/builds. |

## Training data findings

| ID | Severity | Defect / impact | Applied fix / principal files | Validation |
|---|---|---|---|---|
| DATA-01 | Medium | Malformed JSON during queue sorting, database constraint errors, or a missing thermal pair could poison an entire batch indefinitely. | Fault-tolerant priority parsing, isolated retry for invalid records, retain incomplete pairs while committing unrelated data. `deploy/training/worker.py`. | Offline fake-DB transaction regressions. |
| DATA-02 | High data integrity | ON CONFLICT pair inserts were not verified before source deletion; wrong existing relationships or cross-sensor pairs could be treated as successfully imported. | Verify stored frame hash/source identity/sensor/modality and exact stored pair relationship before deleting committed sources; reject unavailable/wrong-sensor references. | Conflict, cross-sensor, missing-reference and commit-failure regressions. |
| DATA-03 | Medium | Database schema did not enforce referenced modalities or finite calibration for existing installations. Malformed observed JSON could break status reporting. | Composite modality foreign keys and upgrade checks; safe observed-array handling. `schema.sql`, `worker.py`. | Offline worker tests. Real PostgreSQL fresh/idempotent/legacy migration, failed-upgrade retention and worker retry passed; production migration still requires backup/review. |
| DATA-04 | Medium | Truncated JPEG headers/segments, malformed calibration/base64/UID and frame metadata reached decoding/DB operations. | Validate JPEG segment boundaries/dimensions and payload/source fields before insertion. | JPEG and malformed record offline regressions. |
| DATA-05 | High filesystem integrity | Database sample IDs were used as export filenames and could traverse outside the export directory. | Require bounded alphanumeric/underscore/hyphen sample IDs before filesystem writes. `tools/export_training_postgres.py`. | Source review and Python compilation. |
| DATA-06 | Medium ML correctness | Trainer mixed different sensor geometries into one camera transform; changing RGB resolution crashed background construction; empty held-out partitions failed opaquely. | Require one UID or explicit selection, fixed dimensions and readable train/validation partitions. `tools/train_human_location.py`. | Offline mixed-sensor/dimension/UID regressions. |
| DATA-07 | Medium ML correctness | Threshold overrides stored metrics for a different threshold; rounding could yield an invalid zero threshold. | Recompute metrics for the exact emitted threshold and reject invalid rounded overrides. | Offline threshold regression; feature crosscheck. Metrics remain internal validation, not independent accuracy certification. |
| DATA-08 | Medium deployment | Re-running DB provisioning failed on existing roles/database before reaching schema migrations; repeated HBA rules accumulated. | Conditional role/database creation, restricted role properties and deduplicated HBA rules; schema can be reapplied. `provision-db.py`. | Python compilation; actual Proxmox/PostgreSQL provisioning was not executed. |
| DATA-09 | Medium secrets | Credential/env temporary files retained an existing permissive mode despite `touch(mode=0600)`; unvalidated credential JSON could form an unsafe URI/SQL literal. | Explicit 0600 before reading/writing existing credentials, env/temp/backup files; bounded hex credential validation. `install-env.py`, `configure-backend.py`, `provision-db.py`. | Python compilation and source review; installers not run live. |

## Completed confidentiality and identity follow-up

These changes complete the source implementation work previously listed as OPEN-02/03/04/05/06/11. Deployment, provisioning and physical acceptance are separate requirements below. Protocol details and migration/recovery instructions are in [ENCRYPTED_NODE_PROTOCOL.md](ENCRYPTED_NODE_PROTOCOL.md).

| ID | Defect / risk | Implemented fix | Acceptance evidence |
|---|---|---|---|
| SEC-01 | HMAC-only UDP exposed thermal/occupancy/status payloads; TLS intermediaries could read direct payloads. | Versioned AES-256-GCM envelope, full authenticated header and tag, HKDF-separated keys by UID/ID/direction/role, fresh 128-bit key epochs. Firmware mbedTLS and edge crypto agree; gateway remains keyless. `tm_secure.*`, `secure.ts`, packet/listener/relay paths. | Native mbedTLS known-answer and every-byte command tampering; edge every-byte tests; real firmware -> edge/relay parser crosschecks. |
| SEC-02 | A site key exposed every node's signing authority; implicit legacy fallback allowed downgrade. | Strict private per-device key registry, unique masters/IDs, bounded rotation, revocation, explicit legacy allowlist; atomic durable enrollment and required flag; factory preserves policy; damaged or zero stored key fails closed. | Rotation/expiry/revocation, wrong UID/key/role, missing/interrupted/zero NVS enrollment and plaintext downgrade tests. |
| SEC-03 | Counter lifetime and restored counter backups could reuse cryptographic nonces. | boot32 migration, write-before-networking, sequence/boot exhaustion refusal; radio-backed fresh per-context epochs and fresh OS-random edge epochs derive new packet keys. Durable replay remains independent. | Wide boot, write failure, exhaustion and epoch/key-separation tests; real ESP32 builds. Entropy/power-loss still needs hardware acceptance. |
| SEC-04 | UDP send was not proof the edge accepted a report; plaintext cloud controls/grants were exposed to intermediaries. | Durable encrypted REPORT/STATUS ACKs across UDP/relay; sent-packet ACK matching; challenge-bound encrypted direct READY/ACK/grants, control sequence and plaintext refusal. | Real gateway ACK -> firmware parser on both transports; direct real C++ crosscheck; host replay/tag/plaintext/wrong-session controls; OTA fault tests. |
| SEC-05 | Shared gateway credential and restart-lost HELLO cache allowed impersonation/replay; unauthenticated LAN candidates evicted a real route. | Per-gateway current/previous/revoked credentials, durable bounded HELLO nonce/high-water journal, established-session expiry, raw TCP off by default and encrypted-network declaration, edge-approved route retention. | Real gateway server identity/restart/shared-fallback/raw rejection tests; candidate flood test and paired relay crosscheck. |
| SEC-06 | Independent account/revocation writers could lose updates; old Google-linked passwords/cookies retained access. | Exclusive short commit locks, fresh recheck, fsynced atomic rename and directory sync; merged revocations; credential-version cookies; linked-account legacy password refusal. | Actual separate Node processes retain all concurrent accounts, stale-lock/corruption tests, independent revocation writers, cookie/password invalidation. |
| SEC-07 | A shared snapshot bearer could publish another edge identity/floor. | Private per-edge unique bearer registry and exclusive floor ACL, strict schema and no shared fallback when enabled. | Real HTTP wrong identity/token/foreign-floor and valid-publisher tests. |
| SEC-08 | Accidental rollback/OTA to older software could disable encryption. | Edge refuses versions below reviewed tmsense-1.7 or unknown versions for encrypted targets before sending images/requests; provisioning runbook requires compatible firmware in both OTA slots. Failed bootloader confirmation preserves first-trial state. | Downgrade rollout regression and real OTA journal/bootloader-failure host tests. Actual slots/bootloader behavior remain a physical prerequisite. |

## Remaining work and deployment requirements

The source implementations are complete where stated; the remaining entries are concrete production/physical acceptance and policy requirements, not unimplemented code claims. Detailed firmware and gateway sections below expand their triggers and migration choices.

| ID | Priority | Requirement / residual risk | Concrete completion criteria |
|---|---|---|---|
| OPEN-01 | High before fleet OTA | SDK app configuration enables bootloader rollback, but actual M3 bootloader/partitions/watchdog/eFuses, signed-image provisioning and secret storage are not established. | Verify both fallback slots are encryption-compatible before enrollment; exercise pre-init crash, reset and power-cut rollback on a pilot. Plan signed-image provisioning/flash encryption and review irreversible eFuses separately. |
| OPEN-02 | High production migration | Per-device, gateway and snapshot credentials are implemented/tested (SEC-02/05/07); existing live devices still use legacy credentials. | Generate unique private credentials; stage bounded rotation, explicit legacy UID allowlist and floor ACL; provision one pilot, then migrate the fleet and retire shared fallback. |
| OPEN-03 | Medium OTA assurance | Enrolled UDP authenticated ACK is implemented/tested (SEC-04); legacy UDP still lacks accepted-report proof. | Enroll the pilot/fleet and prove fresh accepted REPORT ACKs under loss, restart and OTA probation. Do not use legacy send-only proof as fleet acceptance. |
| OPEN-04 | Medium hardware lifetime | Encrypted wire v2 boot32 and nonce epochs are implemented/tested (SEC-03); legacy networking stops at 16-bit exhaustion. | Verify physical NVS writes/entropy across cold boots and power loss; migrate legacy nodes before exhaustion; never restore/reset counters under retained keys. |
| OPEN-05 | High network boundary | Per-gateway identity, durable HELLO replay and approved route retention are implemented (SEC-05). Keyless gateways still cannot stop an allowed LAN identity/radio flood. | Use WSS for public links; raw TCP only over verified Tailscale/authenticated encryption. Restrict the sensor subnet and measure flood/backpressure; do not treat the TCP_ENCRYPTED declaration as TLS. |
| OPEN-06 | Medium account policy/scaling | File-backed accounts/revocations now serialize and durably merge local writers (SEC-06); distributed storage and verified university membership are not provided. | Keep local lock/rename/fsync semantics; recover stale locks only after confirming the writer stopped. Use a transactional shared DB before distributed scaling. Keep signup closed or add verified enrollment/university OIDC if membership is required. |
| OPEN-07 | High release readiness | Complete isolated 1.7 compilation passes locally. Live EC2 still lacks bubblewrap, so new builds would intentionally fail closed. | Install bubblewrap and pinned SDK/dedicated compiler; verify under tmedge UID/systemd policy with no service secrets in compiler/SDK folders. Keep reviewed recovery images. |
| OPEN-08 | High release readiness | No audit patches are installed live. Journals/private policy files require persistent DATA_DIR/shared config. | Publish/review the coordinated branches and commit pins; back up data/private config; deploy through the checked pipeline; apply training schema with reviewed rollback; then prove one M3 pilot before fleet rollout. |
| OPEN-09 | Medium physical acceptance | Real PostgreSQL fresh/legacy/idempotent/invalid-row migration and worker retry now pass. Physical NVS, cross-core scheduling, sensor stalls and disk pressure remain unproven. | Rehearse production migration on its snapshot; retain/repair invalid rows. Run controlled physical power-loss/sensor/network/storage fault tests. |
| OPEN-10 | Medium operations | Bounded queues/caches/journals and flood regressions pass; production fleet CPU/fsync/disk budgets are not measured. | Load-test expected node/frame rate and failure modes; set disk/paused-capture/journal/backpressure alerts before raising capacity. Maintain retention/pruning. |
| OPEN-11 | High confidentiality rollout | End-to-end encrypted telemetry/downlinks/controls are implemented and crosschecked across UDP/WSS/relay (SEC-01..04); no physical encrypted M3 capture or OTA cycle has run. | Complete the physical capture/performance/rollback pilot, including compatible recovery images and key provisioning/rotation, before enabling fleet encryption. |

### OPEN-11 — TMsense-to-TMedge payload encryption

**Status: implemented and locally crosschecked; not deployed or physically accepted.** See SEC-01 through SEC-04 above and the protocol/runbook. The six criteria below remain the release acceptance contract, with software evidence in the final record and physical requirements explicitly pending. The objective is to keep sensor data confidential from network listeners and relay intermediaries, including TMWAccess and Cloudflare, across both UDP and WSS routes. Keep TLS certificate/hostname validation and the existing encrypted gateway uplinks. Encryption does not hide routing identities, packet sizes or timing, and cannot protect plaintext on a compromised sensor or edge.

Implementation requirements:

1. **Authenticated encryption:** use a reviewed AEAD implementation supported by the ESP32 and edge runtime. Encrypt telemetry, thermal frames, status and sensitive downlinks, including commands and OTA grants; authenticate protocol version, device identity, direction, message type, key ID and nonce. Reject authentication failures before updating application state.
2. **Device key isolation:** provision a separate secret for each sensor, available only to that sensor and TMedge. Derive distinct keys for uplink/downlink and encryption/authentication roles; do not reuse the site-wide HMAC key as the encryption key. Define key IDs, bounded rotation overlap and revocation. Keep secrets out of gateways, source uploads, firmware build logs and console responses. Assess device key storage alongside OPEN-01.
3. **Nonce and replay safety:** never repeat a nonce under the same key, including after resets, power loss, counter exhaustion or restoration of older firmware/settings. Design checked persistent allocation or an authenticated fresh-session scheme; do not assume the existing 16-bit boot counter is sufficient. Fail closed on state-persistence failure or exhaustion. Verify the encrypted packet before durable replay admission; ACK only accepted, durably recorded reports.
4. **Protocol migration:** coordinate packet versioning, routing and size limits across TMsense, TMWAccess and TMedge. Gateways forward ciphertext with only the minimum routing metadata and never receive decryption keys. Bound parsing and UDP datagram sizes including encryption overhead. Record whether encryption is required per device; reject plaintext/downgrade attempts for enrolled devices. Define a controlled legacy migration and recovery procedure that preserves that policy.
5. **Acceptance checks:** add shared firmware/edge test vectors and real relay crosschecks for both directions and transports. Cover altered headers/ciphertext/tags, wrong or revoked keys, duplicates, out-of-order traffic, resets, interrupted persistent writes, counter exhaustion, rotation and downgrade attempts. Capture UDP and WSS-route traffic to confirm sensitive payloads are not exposed; verify gateways cannot decrypt them. Measure ESP32 memory/CPU, frame throughput and datagram limits.
6. **Pilot and OTA recovery:** test M3 telemetry, commands, encrypted REPORT ACKs, disconnect/reconnect and an OTA cycle before fleet rollout. Exercise rollback to older firmware and key recovery explicitly; recovery must not silently disable encryption. Document provisioning, replacement and rotation procedures, then update the protocol documentation and deployment pins.

## Validation results

- TMedge: **191/191 tests passed**, complete server/console/both UI typechecks and builds passed.
- Firmware protocol crosscheck: **19/19 checks passed**, including 115 cloud transport checks and OTA grants/requests.
- TMWAccess: **23/23 tests**, typecheck and **8/8 real-edge crosschecks** passed.
- TMsense: **115 cloud**, **27 display**, **32 safety/fault checks under UBSan**, **4 listener tests** and **23 detector scenarios** passed. Both tmflash and testcloud ESP32 builds passed.
- Isolated TMsense 1.6 build succeeded (image `243f6fa9b12f918e`, 966,128 bytes); private fixture includes cannot read host data.
- Archive tests **3/3**, receiver tests **6/6**, training offline tests **8/8** passed. Python compilation, shell syntax and diff whitespace checks passed.
- npm advisory checks for root/student/algo/gateway packages reported **zero known advisories** at audit time.
- Local migration/deploy/automatic/manual rollback/retention rehearsal: **14/14 checks passed**. This test uses scratch services and paths, never EC2.

Logs are local under `/tmp/tmedge-final-*.log`, `/tmp/tmedge-audit-deploy-rehearsal.log`. Physical power-loss, sensor-stall, production load, real PostgreSQL schema integration, installer execution and a patched M3 OTA remain untested.

The earlier live OTA test of the pre-audit image is recorded separately in [ota-test-report.md](OTA_TEST_REPORT.md). It does not validate the new 1.7 firmware or these server patches.


# Detailed firmware findings

## TMsense audit and remediation notes

Audit date: 2026-10-04. Reviewed TMsense firmware, public headers, host harnesses,
Python/shell tooling, build definitions and CI, following `TMsense/CLAUDE.md`.
The Melexis driver review covered acquisition, register verification and the
calibration/math paths. Generated fonts/logo/trust-root assets are data rather
than independently executable services. This is a source audit and regression
validation, not a guarantee that every possible defect has been found.

All changes below are local. No device was flashed, no live service was deployed,
and no live credentials were read. Final firmware version is `tmsense-1.7`; earlier 1.6 checks below are historical and superseded by the final acceptance record.
Packet format, signatures, MAC identity, REPORT size, cloud TLS validation and
serial `show` / `set …` / `save` success replies remain compatible.

### Confirmed findings patched

| ID | Severity | Defect and trigger | Fix and principal locations | Validation |
|---|---|---|---|---|
| FW-01 | High | NVS writes for the boot and command counters were unchecked. A valid command could have effects even though its replay counter was not durable; replaying it after reboot could repeat those effects. A boot-counter save failure reused counter state. | Persist the command sequence before applying effects; disable all networking when the boot counter cannot be persisted. `TMsense/src/tm_settings.cpp:122`, `:161`, `TMsense/src/main.cpp:102`, `:152`, `TMsense/src/tm_transport.cpp:56`. | Fault-injected counter failures in `safety_test`. |
| FW-02 | High | Factory reset erased the entire NVS namespace before rewriting the boot counter. Power loss/write failure between those operations lost replay protection; command replay history was also discarded. RAM defaults changed without refreshing the radio/signing context. | Delete only configuration keys, never either replay counter. Report erase failures, retain both counters, refresh live radio/key/parameters/background after successful reset. `TMsense/src/tm_settings.cpp:167`, `:279`. | Factory reset with boot-key writes deliberately failing; counter preservation and live-refresh action checks. |
| FW-03 | Medium | The 16-bit boot counter silently wrapped after 65,535 boots, contradicting monotonic identity and causing established edges to reject new telemetry. | Refuse networking at exhaustion, preserve the counter, and print an actionable serial diagnostic. `TMsense/src/tm_settings.cpp:123`, `TMsense/src/tm_transport.cpp:57`. | Exhaustion regression. A protocol migration is still required to extend the counter range. |
| FW-04 | High | OTA activated the new boot partition in `Update.end()` before persisting probation. A failed NVS write or reset in that interval could boot an image with no proof requirement. Restarting an unconfirmed image restarted its entire probation window indefinitely. Confirmation NVS writes were unchecked. | Persist checked probation metadata before activation; record the first trial boot and roll back on a second unconfirmed boot. Confirm only after the pending marker is cleared successfully; persistence failures still reach the deadline. Preserve compatibility with older rollback images. `TMsense/src/tm_ota.cpp:63`, `:90`, `:118`, `:210`, `:293`. | Real OTA source compiled against NVS/Update/partition fault-injection shims; first boot, repeated boot, failed activation persistence and failed confirmation persistence exercised. |
| FW-05 | Medium | OTA sensor health used successful initialization, even when no complete thermal frame had ever arrived or frames had stopped. Cloud report-count resets during reconfiguration also complicated proof tracking. | Require at least one complete frame and a frame age under five seconds. Only a changed nonzero cloud REPORT-ACK count supplies new cloud uplink evidence. `TMsense/src/main.cpp:440`. | OTA refuses false sensor health in the host harness; actual main loop compiles in both firmware environments. End-to-end sensor-stall validation remains a hardware check. |
| FW-06 | Low | Rejecting another OTA during probation overwrote the active image ID; later confirmation/revert could be attributed to the rejected image. | Report the rejected image temporarily and restore the active ID. `TMsense/src/tm_ota.cpp:143`, `:163`. | Busy-rejection and final confirmation identity regression. |
| FW-07 | Medium | The OTA stream had an idle timeout but no total deadline. An untrusted gateway/network path could continuously drip bytes and keep the blocking download/sensor suspension alive indefinitely. A valid signed OTA request is required to enter this path. | Bound image streaming to three minutes independently of activity. `TMsense/include/tm_ota.h:36`, `TMsense/src/tm_ota.cpp:244`. | One byte every 14 seconds is aborted within the total deadline, before activation. |
| FW-08 | Medium | Pending cloud configuration, active authentication key and several flags were concurrently accessed by the network task and loop task; `volatile` did not synchronize them. Reconfiguration/stop also left queued evidence and grants accessible briefly. | Synchronize shared state with the mutex; stage the pending key separately from the network task's active key; retain the reconfiguration guard until session initialization finishes; reset queues/info/grants and check task creation. `TMsense/src/tm_cloud.cpp:30`, `:202`, `:242`, `:302`, `:326`. | Both actual ESP32 builds compile; existing cloud session tests pass. No hardware race stress test was performed. |
| FW-09 | Medium | Invalid persisted cloud URLs silently selected UDP, weakening the configured cloud transport and potentially sending to saved edges instead. | Keep an explicitly configured WSS transport; `start_cloud()` refuses the invalid URL and sends nothing. Missing transport settings still select UDP as required for older nodes. `TMsense/src/tm_settings.cpp:103`. | Stored-invalid-URL regression. |
| FW-10 | Medium | `putString(...) >= 0` always evaluated true because the API returns unsigned `size_t`; failed Wi-Fi/key/cloud-setting writes could report `saved`. | Check the reported length and read back each string, including empty strings, while keeping secrets out of output. `TMsense/src/tm_settings.cpp:143`. | Nonempty write failure and successful empty optional settings regressions. Arduino API behavior verified against [Espressif Preferences source](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/Preferences/src/Preferences.cpp). |
| FW-11 | Medium | The 16-entry ACK tracker evicted the oldest unacknowledged REPORT at high refresh rates. Its five-second age could never be reached despite a path sending pings but accepting no reports. | Preserve the oldest outstanding REPORT under queue pressure; a new accepted ACK still retires earlier refused packets. `TMsense/src/tm_cloud_proto.cpp:279`. | Eight reports/second with 64 pending sends preserves an eight-second age; ACK retirement still succeeds. |
| FW-12 | Low | Serial settings silently truncated long passwords/keys/SSIDs and extra edge addresses; numeric parameters accepted trailing junk/extra arguments. | Reject complete invalid inputs without changing settings. `TMsense/src/tm_settings.cpp:340`, `:351`, `:371`. | Invalid numeric arguments, overlong password and third edge regressions; valid commands retained. |
| FW-13 | Medium | Bench `listen.py` checked datagram framing but not type-specific body length/count. A short REPORT/STATUS/RAW raised uncaught `struct.error` and terminated the UDP receiver. | Validate fixed/variable payload size/count/quantization before decoding; report malformed packets as recoverable `ValueError`. Add correct OTA_STATUS decoding. `TMsense/tools/listen.py:45`, `:55`, `:64`. | Four Python tests covering nine malformed bodies and valid packet decoding. |
| FW-14 | Medium | MLX register-write verification ignored a failed read and compared an uninitialized value; frame acquisition wrote the control-register output before checking its read status. | Propagate the I2C error before using output. `TMsense/src/MLX90640_I2C_Driver.cpp:104`, `TMsense/src/MLX90640_API.cpp:101`. | Failed verification-read regression; host sensor driver compiled under UBSan. |
| FW-15 | Low | Valid negative VDD/row/column calibration values were left-shifted, which is undefined C++ behavior. | Use equivalent signed multiplication, keeping vendor changes small. `TMsense/src/MLX90640_API.cpp:572`, `:767`, `:840`. | Negative calibration fixtures pass with UBSan configured to abort on any undefined behavior. |
| FW-16 | Low | HTTP/WS handshake parsing accepted status prefixes, incomplete response heads, substring Connection tokens and duplicate Content-Length values. A one-byte WS close payload was accepted as a missing code. The WS frame builder's capacity addition could overflow for a caller-supplied extreme length. | Require complete bounded heads, valid version/status boundaries, complete tokens and unique content length; reject malformed close payloads; subtract checked header size for capacity comparisons. `TMsense/src/tm_cloud_proto.cpp:395`, `:420`, `TMsense/src/tm_ws.cpp:63`, `:135`, `:225`, `:243`. | New malformed-head, token, close and extreme-length regressions. Network paths remain TLS/authenticated; no unauthenticated remote TLS bypass was demonstrated. |

### Validation and coverage limits

- `python3 test/host/detector_test.py`: 23/23 scenarios passed; detector behavior was not changed.
- `test/host/build_cloud_host.sh && build/cloud_test && build/display_test`: 115 cloud transport checks and 27 display checks passed.
- `bash test/host/build_safety_host.sh && build/safety_test`: 32 checks passed, with UBSan enabled and abort-on-error.
- `python3 test/host/listen_test.py`: four tests passed.
- `PYTHONPATH=/tmp/tmsense-audit-python python3 -m platformio run -e tmflash -e tmsense_testcloud`: both final ESP32 release and fixture builds passed. Release uses 99,404 bytes RAM and 966,057 bytes flash; fixture uses the same RAM and 966,045 bytes flash.
- `git diff --check`: passed.
- CI now executes the new OTA/NVS/I2C and malformed-UDP regressions.

The sensor-driver host compile emits existing vendor type-range comparison
warnings; those comparisons are redundant on the current target, not test
failures. Host fault injection does not establish physical flash power-loss
behavior, TLS heap pressure, cross-core scheduling behavior, or hardware OTA
rollback. Those require a controlled pilot on an actual node before rollout.

### Remaining design/deployment limitations

- Enrolled wire v2 UDP now uses authenticated accepted REPORT ACKs (SEC-04).
  Legacy UDP retains send-only proof and must migrate before fleet acceptance.
- Enrolled v2 boot32 extends lifetime; legacy v1 still stops at 16-bit exhaustion.
  Physical NVS/entropy behavior requires the OPEN-04 pilot.
- A site-wide HMAC key means compromise of one provisioned node can expose
  signing authority for the site. Per-device keys/key IDs and coordinated
  rotation now exist for v2 (SEC-02); retire legacy shared keys during migration.
  No key extraction was attempted.
- NVS confidentiality, ESP32 secure boot, flash encryption, debug-port policy
  and bootloader-enforced signed images are deployment controls not established
  by this repository. Enabling irreversible eFuse policies requires a physical
  device provisioning plan; this audit did not alter them.
- Custom application probation cannot rescue firmware that crashes before
  reaching `tm_ota_init()`. Bootloader rollback/watchdog enforcement should be
  evaluated with the actual bootloader configuration and physical power-cycle
  tests before a fleet rollout. The patch protects repeated failures that reach
  initialization; it does not claim to solve pre-initialization boot crashes.
- LoRa transport is explicitly unimplemented and sends nothing in LoRa mode.
  Implementing the transport is a feature project, not a silently working
  fallback.
- The detector's warm-laptop confusion is a documented physical-resolution
  limitation and is unchanged. It requires downstream temporal/spatial policy
  or stronger sensing, not arbitrary firmware thresholds.
- Settings consist of individually committed NVS keys; a failed multi-setting
  save can be partial and is now reported honestly. An atomic versioned config
  blob/migration would be a separate persistence-format improvement.


# Detailed gateway findings and durable admission review

## TMWAccess and TMedge gateway transport audit

Audited 2026-10-04. Read every tracked TMWAccess source, test, deployment, Docker, CI and configuration file (excluding generated output, package-lock package metadata after dependency audit, and secret `.env` values), both CLAUDE.md files, and TMedge's mirrored gateway protocol/server and gateway tests. Changes are local; no deployment or hardware flashing occurred in this audit.

This is a record of concrete findings and fixes, not a proof that no other vulnerability exists. Severity reflects the trust boundary and likely effect. A malicious gateway still cannot forge a node HMAC; gateways remain keyless relays.

### Findings fixed

| ID | Severity | Location | Trigger and impact | Fix and validation |
|---|---|---|---|---|
| GW-01 | High | `TMedge/src/edge/gwlink.ts:234` | An unauthenticated WebSocket upgrade with an invalid absolute request target throws from `new URL` outside a catch and can terminate the edge process. | Catch malformed upgrade URLs, return 400, close the socket. Regression sends `http://[bad/tmgw`, then proves the server still answers. |
| GW-02 | High, when HELLO traffic is observable | `TMedge/src/edge/gwlink.ts:382` | A captured valid HELLO could be replayed during the 60-second timestamp window; authentication replaced the legitimate gateway connection. | Cache accepted `(gatewayId, nonce)` pairs through the timestamp window, bound/prune the cache, validate nonce/MAC/time types. Regression replays the exact accepted HELLO and confirms the original session survives. See remaining TCP/restart limitations below. |
| GW-03 | Medium | `TMedge/src/edge/gwlink.ts:347` | After denying one frame, the parser continued through coalesced frames and could accept a subsequent valid HELLO on the already rejected stream. | Rejection is terminal for all subsequent frames. Regression sends invalid UPLINK plus valid HELLO in one write and sees only DENY. This did not remove the HMAC requirement, but violated the session's rejection state. |
| GW-04 | Medium | `TMWAccess/src/gateway.ts:157,483` | Any permitted LAN host can invent structurally valid node UIDs without a key. The cache grew indefinitely, and diagnostic STATS eventually exceeded the framing limit or consumed large memory. | Bound the cache to 512 identities, expire routes after five minutes, cap STATS lists to 128 entries, cap configured queue at 10,000. Regression injects 600 identities and proves cache/frame bounds and expiry. |
| GW-05 | Medium | `TMWAccess/src/gateway.ts:161,209` | A forged packet for a real UID from a different permitted LAN address overwrote the gateway's single last address, even though the edge rejected its signature. Commands to the last authenticated edge route were then refused. | Keep up to eight recently heard addresses per UID; relay only to the matching address the signed edge route names. Regression learns a real address, hears a forged address and successfully delivers the edge command to the real one. |
| GW-06 | Medium | `TMedge/src/edge/gwlink.ts:95`; `TMWAccess/src/gwlink.ts:69` | Repeated tiny frame fragments forced repeated concatenation of the entire partially received body, giving quadratic copying under attacker-controlled fragmentation. Outbound framing had no size check. | Allocate once per bounded frame, assemble incrementally, validate outbound frame type/size. Shared code kept identical. Fragmented and oversized-frame regressions pass. |
| GW-07 | Medium | `TMWAccess/src/images.ts:57` | Chunk accounting summed bytes regardless of offset. Repeated/overlapping chunks could be counted twice and spuriously finish/hash-reject a transfer. NaN/fractional offsets could reach buffer-copy coercion. | Require safe integer offsets, exact sequential position, non-empty chunks and bounds. Regression covers overlap, duplicates, emptiness, NaN and fractional offsets, followed by successful completion. Hash verification remains mandatory. |
| GW-08 | Medium | `TMWAccess/src/gateway.ts:124`; `TMWAccess/src/images.ts:129`; `TMedge/src/edge/gwlink.ts:260` | Gateway shutdown left firmware HTTP listening. Edge shutdown waited for unauthenticated/sniffing/HTTP peers because it only destroyed authenticated sessions. | Close the gateway's image server and its HTTP connections; track and destroy all accepted edge sockets. Gateway stop is idempotent. Regressions prove firmware fetch fails after stop and a silent unauthenticated client cannot delay edge close. |
| GW-09 | Medium | `TMedge/src/edge/gwlink.ts:182,203,319,443`; `TMWAccess/src/gateway.ts:367` | Repeated sends to a non-reading gateway or a large offline-queue flush could grow transport buffers. Silent authenticated peers stayed registered indefinitely. | Bound edge output buffers to 16 MiB and active sockets to 512, expire silent gateway sessions after 45 seconds, enforce the existing 2 MiB gateway backpressure limit while flushing. Existing relay and queue/reconnect tests pass; slow-reader limit has been reviewed but not independently stress-tested. |
| GW-10 | Low | `TMedge/src/edge/gwlink.ts:325`; `TMWAccess/src/gateway.ts:313` | TCP segmentation could split `GET `, misclassifying a legitimate WebSocket HTTP request as raw TMGW. A WELCOME followed by firmware frames in the same TCP read lost the later frames while adopting the connection. | Wait for four sniff bytes; preserve frames after WELCOME until adoption. Regressions split the method across writes and coalesce WELCOME plus a full image transfer. |
| GW-11 | Medium | `TMWAccess/src/gateway.ts:386` | Failback intervals could overlap a pending probe. If the old fallback closed during an unsuccessful preferred-route probe, its close callback was ignored and normal reconnect was delayed until the dead-link timer. A completed probe after stop could be adopted. | Serialize probes, remember an old-route close until the probe resolves, reconnect on failed probe, reject late adoption after stop. Existing failover/failback regressions pass; cancellation/failed-probe timing branches were reviewed but not separately injected. |
| GW-12 | Low | `TMedge/src/edge/gwlink.ts:78,278,414`; `TMWAccess/src/config.ts:34,83` | Gateway IP/port envelopes, OTA-ready JSON, route ports, proxy ports and CIDRs accepted invalid values/coercions. Invalid values could affect routing, downloads or startup. URL credentials could reach diagnostic logs. | Validate numeric literal IP addresses, nonzero source ports, OTA-result types/ports/errors and outbound image size/identity; reject embedded URL credentials, invalid route/proxy ports/CIDRs, excessive route length/count. Correct loopback IPv6 WebSocket hostname handling. Regressions exercise malformed addresses, OTA-ready values and configuration. |
| GW-13 | Low | `TMWAccess/src/gateway.ts:117,224,235`; `TMWAccess/src/images.ts:45,81,103` | Firmware failure ACKs always used an empty image ID, so the rollout waited for timeout. IMAGE_PORT=0 still acknowledged an image as ready. Metadata was retained by reference, its ID need not match its hash, and old per-image serve counters accumulated. Any HTTP method could fetch images. | Preserve validated IDs in failure ACKs, explicitly refuse disabled downloads, copy metadata, require hash-prefix identity, evict old serve counters, allow GET/HEAD only. OTA failure/disabled-server and image-method/identity regressions pass. |
| GW-14 | Medium | `TMWAccess/src/socks5.ts:21,29,54`; `TMWAccess/src/transport.ts:46,77,89,104` | SOCKS5 accepted invalid reply versions/address types, left failure timers alive, delayed rejection on early close and could lose coalesced target greetings. WebSocket late-open/timeouts and throwing sends were not handled robustly. | Strict SOCKS5 reply/target validation, single settlement and timer cleanup, early-close rejection, preservation of buffered greetings until consumers attach. Bound binary WebSocket messages and handle late opens/send errors. Regression covers malformed SOCKS5 replies and immediate close; TCP/WSS real-server crosscheck verifies normal transport. |
| GW-15 | Low | `TMWAccess/src/gateway.ts:93,489`; `TMedge/src/edge/gwlink.ts:248` | Bind errors could hang startup promises or cause unhandled errors. Status connections could wait forever without sending data. Long remote denial errors could inflate later STATS frames. | Reject bind failures, give status sockets a five-second timeout and bound stored/remote errors. Regression verifies occupied UDP startup rejects; source inspection covers the other bind handlers. |
| GW-16 | Low, hardening gap | `TMWAccess/.gitignore`, `.dockerignore`, `deploy/install-ubuntu.sh:13`, `docker-compose.yml` | Only `.env` was Git-ignored; related environment/key files could be committed. The Ubuntu installer recursively copied the whole checkout, including unrelated private files. Docker lacked basic privilege/write restrictions. | Ignore environment variants and private-key files, exclude keys from Docker context, install only compiled runtime/package/env artifacts, restrict env permissions, make Docker filesystem read-only, drop capabilities and disallow privilege gain. These are preventative controls; no tracked secret was identified in TMWAccess by this audit. Scripts were syntax-checked, not deployed. |
| GW-17 | Low | `TMWAccess/deploy/install-macos.sh:13`; `deploy/install-ubuntu.sh:8,21` | Unescaped home/repo paths containing XML metacharacters produced invalid launchd plists. Unsupported Node versions were not rejected. `grep active` matched UFW's `inactive` status. | Escape plist text, explicitly check Node >=22 including the service binary, match active firewall status exactly. Shell syntax checks pass; installers were not run on production/macOS. |

### Validation

- TMWAccess `npm run typecheck`: passed.
- TMWAccess `npm test`: **23/23 tests passed**.
- TMedge compilation plus `node --test dist/test/gateway.test.js`: **10/10 tests passed**.
- TMWAccess `npm run crosscheck`: **8/8 checks passed** against the real built TMedge server, covering raw TCP, WebSocket, HELLO authentication, signed uplinks, forged packet rejection and command return routes.
- TMWAccess `npm audit --json`: **0 advisories**, including development packages, at audit time. No runtime npm dependencies exist.
- `sh -n` on both installers and `git diff --check` on owned files: passed.
- No production audit deployment, new hardware test or macOS installer run was performed. The final acceptance record supersedes earlier local build counts.

### Remaining trust boundaries and follow-up

1. **Raw TCP must use an authenticated encrypted network**, such as Tailscale. TMGW authenticates the gateway's HELLO but does not authenticate the edge or protect later frames. A raw-TCP on-path attacker can relay a fresh HELLO, alter frames or deny service regardless of nonce caching. WSS verifies the server TLS identity. Documentation now explicitly states this requirement. Supporting untrusted raw TCP requires TLS or a versioned mutually authenticated protocol.
2. **HELLO replay is now durable (SEC-05).** Production uses a bounded fsynced nonce/high-water journal; tests refuse capture replay after restart and backward clock movement. Corrupt state fails closed. Persist this journal across releases.
3. **LAN flood/resource starvation remains possible within bounds.** Since gateways intentionally possess no node keys, untrusted devices inside NODE_CIDRS can occupy the bounded identity cache or exhaust one UID's eight address candidates. Place nodes on a restricted sensor subnet and constrain access at the network. Encrypted edge ACKs now approve authenticated routes and protect them from candidate eviction; flooding new identities/radio remains a subnet/availability boundary.
4. **Per-gateway identity is implemented (SEC-05).** Configure TMGW_KEYS_FILE to disable shared fallback; provision its unique token into each gateway. Live legacy shared-token deployments remain exposed until migrated.
5. Capacity is now explicit: 512 recent node identities, eight recent addresses per identity, 128 STATS entries, at most 10,000 queued datagrams. Sites above this scale should be segmented or these bounded capacities deliberately redesigned. Existing QUEUE_MAX values above 10,000 now fail startup and require adjustment.
6. Ubuntu installs made by the old recursive copier may retain old extra files under `/opt/tmwaccess`; the revised installer does not automatically delete unrelated legacy files. Review those deployment artifacts during the next site update.
7. Site firewall provisioning still uses the install script's documented `192.168.0.0/16` UDP rule. A site using another NODE_CIDRS or firmware HTTP behind active UFW must supply its matching UDP/HTTP rules; this audit does not infer or mutate the site's network policy.

### Replay durability implementation and independent review follow-through

Root's edge audit identified that accepted node replay cursors and allocated command cursors previously lived only in memory, allowing old signed packets after an edge restart. The final implementation uses `src/edge/replay.ts` and a runtime `data/replay.jsonl` write-ahead journal. Gateway audit independently reviewed the implementation and owned the following follow-up edits:

- **Production admission is asynchronous and durable before effects.** `Ingest.handleDurable` verifies a packet, serializes admission by UID, shares one asynchronous `fsync` across different UIDs in a five-millisecond batch window, then updates routes, emits occupancy/health events and allows WSS ACKs. Runtime UDP, gateway and direct node inputs all use this path. Synchronous `handle` remains compatible for isolated tests/tools.
- **Queues are bounded.** Ingest permits at most 4,096 queued packets or 4 MiB of datagrams; the journal caps its own queue at 10,000 records. Pending first-time UIDs count toward the node-table limit. Overload receives an explicit rejection; it does not emit an event or an ACK.
- **Failed durability latches closed.** A failed journal append/fsync rejects the whole batch and future admission. A direct session that closes during its fsync receives no new route/event/ACK. Shutdown stops new admission and drains work that was already admitted to the bounded queue.
- **The newer replay cursor wins.** A journal write can become durable before a session-close refusal prevents the corresponding link update. Admission compares the higher of the durable and live link cursors. An independent regression proved the former `link ?? durable` selection accepted that persisted packet through the older route; it now rejects it.
- **Command cursors never move backwards.** An authenticated STATUS's observed `lastCmd` reserves high water before an asynchronous packet write. A newer allocated command can be durably appended before an older STATUS observation; journal reload and batch completion use the maximum command cursor so record order cannot roll it back. Rare command/reset persistence remains synchronous. Reset refuses while durable packet admission is pending, avoiding resurrection of queued pre-reset data.
- **Live failure state is rechecked after asynchronous fsync.** A synchronous command-journal failure during an outstanding packet fsync cannot subsequently admit that packet, even if the packet's worker returns success. Journal cleanup cannot throw a second close error out of the background task.

Validation after these changes: compilation and **45/45 targeted tests passed** across `test/hardening.test.ts`, `test/durable-ingest.test.ts`, `test/nodelink.test.ts`, and `test/gateway.test.ts`; the real gateway crosscheck again passed **8/8** checks. The three independent `durable-ingest` regressions cover a closed-session persisted cursor replay, actual fsync-gated WSS ACK/routes, and delayed STATUS versus a newer durable command. Root's hardening tests also cover concurrent duplicate ordering, grouping different nodes into one sync, event-loop responsiveness while sync is delayed, and failed-batch refusal.

Durability limitations: journal creation/load and compaction (at most once per 10,000 records), plus infrequent command/reset writes, still use synchronous fsync. Continuous per-packet durability is off the event loop. A malformed/torn journal tail intentionally refuses startup; restore the journal from a trusted backup or perform a deliberate cursor reset/recovery rather than silently trusting old packets. A power-loss fault-injection test and fleet-scale storage load test have not been performed.

Independent firmware review found and reported four additional issues to the root owner: the new upload whitelist initially conflicted with the browser's whole-folder uploader; failed builds left uploads permanently locked; sanitized compiler environment alone did not prevent absolute `#include`/assembler `.incbin` filesystem reads; and newline-free compiler diagnostics could grow an unbounded buffer. The private-file read was demonstrated only with generated harmless local fixtures. Root subsequently updated the browser filtering and build lifecycle/output handling, and reported a successful sandboxed TMsense 1.6 build and private-file include refusal. Root's combined report owns those final changes and their validation.


# Detailed web/auth/browser findings

## Web, authentication and console UI audit notes

Audit date: 2026-10-04. Scope: TMedge `src/web/`, `web-app/`, the student shell and custom floor viewer, plus a supplemental review of `algo-app/`, `src/console-client/app.ts`, and the session/upgrade sections of `src/algo/auth.ts`, `src/algo/server.ts`, and `src/edge/console.ts`. Existing Google sign-in and student UI work was retained. Changes are local; this audit did not deploy anything or change production account files or environment variables.

The following findings are demonstrated by code paths and targeted regressions where listed. This is an audit inventory, not a claim that every possible vulnerability has been eliminated.

### Findings patched

| ID | Severity | Finding and impact | Fix and validation |
|---|---|---|---|
| WEB-01 | High | Login/signup cast JSON values to strings. Non-string email/password/name values reach `.trim()` or scrypt, and Express 4 does not catch rejected promises from async handlers. An unauthenticated malformed request can cause an unhandled rejection or a hanging request. | Validate object bodies and string lengths before hashing; forward rejected promises to an error handler; return generic errors. Tests send nulls, arrays, objects, malformed JSON and a deliberately rejected authentication promise, then verify health still responds. |
| WEB-02 | High | `parseCookies()` calls `decodeURIComponent()` without a catch. Malformed percent escapes throw, including inside the raw WebSocket upgrade listener where Express cannot handle them. | Ignore malformed values, use a null-prototype dictionary, and preserve the first duplicate cookie. HTTP and WS tests prove malformed cookies receive 401 without crashing. |
| WEB-03 | High | Student `safeNext()` only excluded `//`; a browser treats `/\\attacker.example` as an external destination. Dot-path normalization can also turn an initially single-slash path into `//attacker.example`, or redirect back into auth. | Canonicalize with URL, reject backslashes/control characters, reject normalized double-slash destinations and auth loops. Share the pure helper with the student UI. Applied the corresponding canonicalization to `safeAlgoNext()`. Tests cover both backslash and encoded-dot normalization cases. |
| WEB-04 | High | Google automatically linked an existing local account by matching email while retaining its original password. Local sign-up does not verify email ownership, so an attacker could pre-register a victim's address and retain access after the victim used Google. A historically verified third-party Google email is also insufficient proof of current ownership. | Never auto-link on email. Existing subjects remain bound to their original account; a new subject colliding with an account must use its original login method until an explicit authenticated linking flow exists. Tests cover a pre-existing password account, no session issuance on collision, and subject continuity after email changes. |
| WEB-05 | High | Local sign-up was enabled unless explicitly disabled, allowing anyone to claim an HKU email address; the UI described the password as HKU Portal credentials even though it is a separate local password. | Registration is closed by default and requires `SIGNUP_OPEN=1`. Existing logins continue working. UI now calls it an HKUMySeat account and tells users to create a different password. Test covers the secure default. Email verification/university membership remain policy limitations when registration is intentionally enabled. |
| WEB-06 | High | Snapshot validation only checked top-level identifiers and arrays. Missing totals/building/seat data can crash sorting, search or stale blanking. Unknown metadata is preserved by object spread, so accidental raw/debug fields could cross the student privacy boundary. | Validate the exact public schema, bounded arrays/strings, finite geometry, unique IDs, zone references, seat neighbors, unknown-state nulls, seat counts and totals. Reject all additional fields. Tests post malformed nested objects, impossible totals, duplicate tables and added raw frames and prove no state is admitted. |
| WEB-07 | High | Logout only erased the browser cookie; a copied cookie remained usable. Engineer password replacement retained existing name-only sessions. | Add distinct session tokens and bounded revocation, persisted atomically beside account files in both runtimes. Reload revocations on file change, deny on corrupt data, and bind engineer subjects to an HMAC fingerprint of current password hash/salt. Tests cover copied-cookie replay, process restart, a second sequential reader and password reset. See the single-writer limitation below. |
| WEB-08 | High | Algo and embedded debug WS tokens were not tied to the engineer session. A stolen one-minute token could open a feed without a cookie; an already open feed outlived logout, account removal, password reset and session expiry. | Bind token MACs to the session cookie; require a currently valid account/session at upgrade and while broadcasting; close both feeds on logout. Tests prove token-only upgrades fail, both feeds close on logout and password reset ends a live debug stream without restarting the edge. Standalone Basic-auth console token behavior is preserved. |
| WEB-09 | Medium | Student feeds did not check browser origin or recheck expiration; unhandled WS errors and slow readers could leak resources. | Validate origins against the trusted request protocol/host, catch malformed targets, recheck session/account validity, terminate on protocol errors, bound clients to 1,000 total/10 per user and queued bytes to 2 MiB, ping clients, and clear intervals on server closure. Tests cover foreign/null Origin, oversized WS messages and logout closure. |
| WEB-10 | Medium | The login limiter erased its entire map after an address spray, clearing blocked addresses. Many source IPs could also enqueue unlimited expensive password hashes. | Preserve active limits, prune expired entries, refuse new keys at capacity, cap shared scrypt work at eight concurrent hashes and return 429 under load. Student and engineer password APIs enforce a 1,024-character maximum. Regression proves a >10,000-address spray does not clear an existing block. |
| WEB-11 | High | Student user-file reads swallowed all errors, so corruption was treated as an empty store and the next registration could overwrite every account. Concurrent same-address signups checked uniqueness only before awaiting scrypt. Algo account modifications could similarly overwrite corrupt files or changes made while hashing. | Treat only ENOENT as empty; validate stored account records/duplicates; commit uniquely named 0600 temporary files before replacing in-memory state; recheck student uniqueness after hashing and refresh engineer records before commit. Corrupt account data cannot be replaced through account operations. Student regressions cover corruption and simultaneous registrations. Multi-process transactions still require a database or single writer. |
| WEB-12 | Medium | Personalized API responses lacked explicit no-store headers; `/index.html` bypassed the generated/session-aware shell routes. | Apply `Cache-Control: no-store` and `Vary: Cookie` to protected student APIs; redirect raw shell requests through `/`. Tests cover identity, occupancy, search and raw shell responses. |
| WEB-13 | Medium | A disconnected student browser continued displaying and allocating cached free seats indefinitely. A half-open socket can remain apparently open when the network disappears. | Turn every cached table/zone unknown on disconnect, and use a 30-second missing-message watchdog. An older HTTP prime cannot overwrite a newer WS view. A selected table that is no longer available is no longer shown as picked. Pure state regression proves no seats are allocated from a disconnected view and the source snapshot is preserved. |
| WEB-14 | Low | Group size was read once at component mount; browser navigation/query changes could leave the field and search advice using an earlier value. | Synchronize with React Router location and update URLs through navigation. Student UI typecheck/build pass. |
| WEB-15 | Medium | `/vendor/v<stamp>/floor-viewer.js` imported three.js using absolute `/vendor/three/...` URLs, defeating the intended versioned module tree. The stamp only covered viewer mtime and missed library changes. | Use relative module imports and hash the content of the entire checked-in viewer/library tree. Verified module syntax and student production build. |
| WEB-16 | Medium | Rebuilding 3D markers on every live update leaked geometries, materials and canvas textures; disconnect did not dispose controls or cancel the render loop. Model clones shared mutable materials. | Dispose owned marker/path resources, clone materials per view, preserve cached model geometry/textures, cancel animation/dispose controls on detach, dispose stale async results, and permit model-load retry after failure. Mount the React wrapper once. Syntax/type/build checks passed; GPU/browser soak testing remains outstanding. |
| WEB-17 | Medium | Google redirect configuration allowed non-HTTP protocols on localhost and URL credentials/query/fragment. ID-token checks omitted issue time and an unexpected authorized-party claim for single-audience tokens. | Restrict redirect configuration to HTTPS or localhost HTTP and the exact callback; reject credentials/query/fragment; disallow token-endpoint redirects; bound and validate attempts/JWT claims including iat, sub, aud, azp and email. Google integration tests cover configuration and malformed claims. |
| UI-01 | High | `renderNodes()` inserted node-reported firmware directly into HTML. Table authority IDs and parameter names were also interpolated into HTML/attribute strings. The standalone console has no CSP that guarantees these are harmless. | Escape firmware, authority text, UIDs, background text, parameter names/values and metric text. `tsconfig.console.json` check passes. This was reviewed at the actual HTML sinks; there is no existing browser DOM test harness, so a browser XSS fixture remains desirable. Root also owns corresponding firmware UI escaping. |
| UI-02 | Medium | The provisioning dialog uses `method=dialog`; approve/deny click handlers began an async request and then the default button action closed the dialog, requeued/cleared the request, and could make failures impossible to retry or duplicate prompts. | Prevent the default close, keep the same request open until the server answers, disable both buttons while pending, preserve retryable errors, and ignore delayed close events from an already reopened dialog. Handle command/startup network errors explicitly. Console TypeScript check passes; a browser admission-flow exercise remains outstanding. |

### Supplemental algo UI fixes

The following definite client bugs were patched after the initial review; `npm --prefix algo-app run typecheck` and production build both pass. Browser-only behavior still needs an acceptance exercise.

1. **Medium — socket lifetime:** `App.tsx` reconnect timers and an awaited token fetch could open a socket after unmount. Open now checks the lifetime before and after await; timers are cancelled, obsolete socket messages are ignored, and cleanup closes only its own socket. Delayed scrub work is cancelled too.
2. **Medium — misleading/absent write feedback:** Reset, mode, parameter keep/undo, source frame loading, background reset and paired-data recording now catch API errors and display notices. Live/pause state changes only after an accepted response. Recording displays errors and disables its button while pending.
3. **Medium — false logout success:** Algo `Shell.tsx` now requires an OK response before clearing its user/navigation; a failure displays the existing toast. The student chrome has a similar unconditional logout navigation that was reported to root for its follow-up.
4. **Low — inaccessible panes:** Stored pane sizes are clamped to configured limits at initialization.
5. **Low — corrupt display messages:** WebSocket JSON parsing is guarded. Base64 thermal decoding is bounded and requires exactly 768 bytes; invalid planes display a recoverable message instead of throwing from render.

The React screens use normal text interpolation/canvas drawing and contain no `dangerouslySetInnerHTML`, eval, or dynamic Function use. Provisioning labels rendered with `textContent` are safe at those sinks. No new direct React XSS sink was found during this review.

### Remaining operational/policy requirements

- **Local writers / account DB:** exclusive commit locks, fresh checks and durable atomic writes now preserve concurrent local account/revocation updates (SEC-06). Distributed scaling still requires a transactional shared account/session DB; local filesystem locking is not distributed coordination. Recover crash-held locks only after confirming the writer stopped.
- **Registration and university identity:** local passwords do not verify an HKU email or membership. Closing sign-up by default prevents accidental enrollment but cannot retroactively establish ownership of existing accounts. Google is intentionally open to any Google account when registration is enabled; it is not university SSO. Implement verified email enrollment or university OIDC and an authenticated account-linking flow if membership is required.
- **Previously linked accounts/sessions:** Google-linked accounts now refuse legacy password login, and credential-version binding invalidates old student cookies (SEC-06). Review disputed identities rather than invent ownership. Both student and engineer legacy sessions require sign-in after deployment.
- **Revocation durability/path:** `session-revocations.json` lives beside the configured users file. That directory must be persistent and writable by the relevant service. Retain it across releases. A corrupt file fails authentication closed. Secret rotation remains the reliable global emergency invalidation mechanism.
- **Snapshot provenance:** WEB_EDGE_KEYS_FILE now binds each bearer to one edge and exclusive floors (SEC-07), with real HTTP tests. Migrate the live shared bearer; strict schema alone is not identity authorization.
- **Client/browser checks:** no live Cloudflare, Google, hardware, production deployment, browser GPU soak, or end-to-end provisioning-dialog exercise was performed in this sub-audit. Most browser-only changes were type/syntax/build checked; those behaviors deserve an acceptance exercise before production rollout.

### Validation evidence

- `npx tsc -p tsconfig.json`: passed after coordination with the other audit changes.
- `node --test --test-reporter=spec dist/test/web.test.js dist/test/google.test.js dist/test/portal.test.js`: **47/47 passed**.
- `node --test --test-reporter=spec dist/test/algoauth.test.js dist/test/algoconsole.test.js dist/test/console.test.js`: **22/22 passed** after the supplemental auth changes.
- `npm --prefix web-app run typecheck`: passed.
- `npm --prefix algo-app run typecheck` and `npm --prefix algo-app run build`: passed after supplemental UI changes.
- `npm --prefix web-app run build`: passed; the tracked student shell was regenerated to reference the new bundle while preserving Google/Turnstile meta markers.
- `npx tsc -p tsconfig.console.json --noEmit`: passed after HTML/dialog changes.
- `node --check public-web/vendor/floor-viewer.js`: passed.
- `npm audit --json` in `TMedge/web-app`: **0 advisories**, from the npm registry at the audit date. This is dependency-advisory evidence, not proof that custom code is secure.

Primary external reference used for the Google email ownership issue: [Google: verify an ID token on the server](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token). Google distinguishes authoritative Gmail/Workspace ownership from a third-party email that was verified in the past; this supports refusing automatic email-only linking.


# Detailed training data findings

## Training ingestion/export/model audit notes

Audit date: 2026-10-04. Reviewed `TMedge/deploy/training/*.py`,
`TMedge/deploy/training/schema.sql`, `TMedge/tools/export_training_postgres.py`
and `TMedge/tools/train_human_location.py`, following `TMedge/CLAUDE.md`.
Root-agent changes to JPEG parsing, queue ordering and export filenames are
included below so the combined specsheet covers the complete training path.

All changes are local source changes. No live database was queried or written,
no schema migration was applied, no credentials were read and no training
service was restarted. The schema changes were reviewed as SQL source;
PostgreSQL integration and migration behavior have **not** been validated
against a real database in this task.

### Patched findings

| ID | Severity | Defect and trigger | Fix and principal locations | Verification |
|---|---|---|---|---|
| TR-01 | High | An RGB record whose referenced thermal frame had not arrived raised an exception that rolled back every unrelated frame in the batch. A persistent orphan could prevent healthy recordings from draining and eventually fill the outbox. | Keep the missing/cross-sensor pair's source queued while committing other verified records. Its RGB frame may already be stored; retry is idempotent when the thermal frame arrives. `TMedge/deploy/training/worker.py:108`, `:126`. | Fake-DB regression: unrelated thermal is committed/deleted, pending RGB retained, later thermal arrival completes the pair and cleans up. |
| TR-02 | High | `INSERT ... ON CONFLICT (id) DO NOTHING` for pairs was not followed by verification. An existing pair with the same ID but different references/skew/mirror/source could cause the source files to be deleted even though the requested pair was never stored. | Read back and match thermal ID, RGB ID, skew, mirror and source digest before admitting source deletion. Frame verification additionally checks sensor UID and modality. `TMedge/deploy/training/worker.py:118`, `:141`. | Conflicting pair is retained while an unrelated valid record drains; conflicting frame remains queued. |
| TR-03 | Medium | A single PostgreSQL constraint/data failure aborted a whole pipeline batch; retrying the same batch repeated the blockage. | Preserve the fast batch path; on integrity/data errors, roll back and retry records in isolated transactions. Continue past the invalid record. Connection/commit errors propagate, and cleanup happens only after acknowledgement. `TMedge/deploy/training/worker.py:167`. | One bad DB record does not block a good one. Simulated lost commit acknowledgement retains all affected source files. |
| TR-04 | Medium | Plain frame-ID foreign keys allowed pairs whose `thermal_id` referred to an RGB frame or whose `rgb_id` referred to a thermal frame. The ML view assumed the modalities were correct. | Fixed modality columns plus composite foreign keys enforce each relationship, including writes outside the worker. Idempotent ALTER statements upgrade an existing schema. `TMedge/deploy/training/schema.sql:40`. Worker also rejects cross-sensor pairing. | SQL reviewed; fake-DB worker cross-sensor check passed. Actual PostgreSQL FK enforcement/migration remains untested. |
| TR-05 | Medium | SQL CHECK logic allowed null `t_step` because a null check expression passes; NaN/infinity were also not excluded. Direct DB writes could produce invalid/null temperature arrays. | Require finite non-null thermal calibration in both new-table shape validation and a named migration constraint. `TMedge/deploy/training/schema.sql:23`, `:60`. | Python worker already checks calibration; SQL reviewed, not executed against PostgreSQL. |
| TR-06 | Medium | Non-array `observed` JSON could be inserted into source metadata and make `jsonb_array_length()` fail repeatedly when producing worker status. | Reject malformed observation shapes during file parsing and guard the status aggregate's array operation for existing malformed DB data. `TMedge/deploy/training/worker.py:70`, `:192`. | Malformed observation regression; aggregate SQL reviewed. |
| TR-07 | Medium | The offline trainer combined multiple sensor UIDs into one camera transform/model unless the operator supplied `--uid`, then named the output after the first sensor. | Require an explicit selection for mixed datasets; single-sensor datasets retain the existing behavior. `TMedge/tools/train_human_location.py:95`, `:331`. | Mixed sensors rejected descriptively; explicit UID selects exactly one sensor. |
| TR-08 | High for untrusted offline datasets | A sample UID was copied into the model filename without validating MAC shape. An offline pair JSON with a UID containing path separators could write outside the requested output directory. Normal database-exported UIDs are already constrained, but arbitrary local datasets were not. | Reject noncanonical MAC UIDs before samples enter fitting/output; strictly decode base64 and require finite calibration. `TMedge/tools/train_human_location.py:77`. | Unsafe UID is excluded from the dataset; no output-path construction can use it. |
| TR-09 | Low | Mixed JPEG resolutions made the background `np.stack()` fail with a generic shape exception or silently skipped samples during detection. | Stop with a clear explanation when any readable RGB frame has changed dimensions. `TMedge/tools/train_human_location.py:117`, `:134`. | Six JPEG fixtures with one differing resolution produce the descriptive error. |
| TR-10 | Medium | A threshold override changed deployed predictions but retained precision/recall/F1 from the previously optimized threshold. Rounding could also change the deployed threshold without updating metrics. | Recompute scores at the exact three-decimal threshold exported to the model. Reject NaN/out-of-range overrides and values that round to zero. `TMedge/tools/train_human_location.py:295`, `:329`, `:373`. | Distinct thresholds produce their corresponding scores; CLI `.0001` exits with a descriptive argparse error before creating an invalid model. |
| TR-11 | Low | A chronological training/test partition containing no readable RGB frames reached `np.concatenate([])` and failed without identifying the dataset problem. | Report which class of data is missing before concatenation. `TMedge/tools/train_human_location.py:355`. | Source reviewed/Python compiled; no full synthetic model training run performed. |
| TR-12 | Medium | Malformed/truncated JPEG segments could provide incomplete/zero dimensions; malformed queue JSON could abort sorting before per-record parsing isolated it. | Root-agent patches bound JPEG header reads/dimensions and give unreadable/non-object queue entries a safe low priority, retaining them for inspection. `TMedge/deploy/training/worker.py:24`, `:227`. | Root-agent durable harness/checks; worker source reviewed here. |
| TR-13 | High for attacker-controlled DB identifiers | Export sample IDs were used in filesystem names. An unsafe ID could escape the export directory or cause filename collisions through suffix processing. | Root-agent patch requires a bounded ASCII alphanumeric/underscore/hyphen identifier before creating either file. `TMedge/tools/export_training_postgres.py:33`. | Root-agent tests; exporter source reviewed and Python compiled here. |

### Validation

`python3 TMedge/deploy/training/test-offline.py` passes all **eight** tests.
They execute the actual worker/trainer code with deterministic transaction/
pipeline/readback shims or real NumPy/OpenCV JPEG fixtures. Coverage includes
missing pairs, conflicting pairs/frames, DB constraint isolation, uncertain
commits, sensor identity mismatch, malformed observations, mixed sensors,
unsafe UIDs, differing RGB dimensions, threshold scoring and the rounding CLI
error. The diagnostic warnings in this run are expected injected failures.

`python3 -m py_compile` passed for worker, offline tests, trainer and exporter.
`git diff --check` passed. The existing live `test-worker.py` now expects a
conflicting source to be retained with a zero verified-record count rather
than expecting an exception that blocks unrelated records. That live harness
was **not** run because it requires production samples/database credentials.

### Deployment and remaining limits

- Apply the revised schema with a dedicated migration/admin role, not the
  restricted ingest role. `CREATE TABLE IF NOT EXISTS` alone does not change
  existing tables; the added ALTER/constraint section performs that upgrade.
  Existing invalid modalities/null/nonfinite calibration will make constraint
  validation fail. Inspect and repair those rows with a reviewed data plan;
  do not remove them automatically. Test the migration on a database snapshot
  and exercise the composite foreign keys before applying it to the live DB.
- Composite modality FKs and finite-calibration checks now pass real isolated
  PostgreSQL migration/worker tests, including invalid-legacy-row rollback.
  Production permissions/network/commit ambiguity and snapshot migration still
  require deployment acceptance; no production data was migrated.
- Trainer scores are **validation metrics**, not independent test accuracy.
  Camera geometry/background estimation and threshold selection use data
  associated with the nominal held-out time partition. A future independent
  chronological test split must be excluded from those fits/selections and
  scored once. RGB background subtraction/device observations are weak labels,
  not manually verified human ground truth.
- A mixed UID or resolution now stops fitting; moving a camera without changing
  its UID/resolution is still a dataset-quality issue. Dataset/session metadata
  and explicit train/validation/test provenance would detect that class of
  contamination more reliably.
- Healthy ingestion keeps batching; isolated transactions only activate on
  constraint/data failures. That fallback costs extra database round trips and
  should be monitored when a queue contains many invalid records.
- An absent referenced thermal record is deliberately retained for later retry;
  permanent orphans need a reviewed queue policy/operator repair. No automated
  deletion of unverified source data was introduced.
- Source cleanup of legacy JSON/JPEG files remains two filesystem operations;
  a process crash between them can leave an orphan JPEG. Database durability is
  preserved; periodic reviewed reconciliation can remove verified orphan files.
- Reviewed deployment-script concerns that were not patched by this agent:
  `provision-db.py` unconditionally creates roles/database and cannot be rerun
  as a migration runner when those objects already exist; `install-env.py` and
  credential provisioning use `touch(mode=0600)`, which does not correct an
  already existing permissive file mode. Root has been informed and owns any
  final deployment-script remediation. No credential contents were inspected.

## Root follow-up to training deployment notes

The deployment-script concerns listed in the training notes were subsequently patched by root (DATA-08/09 above): role/database creation is conditional, HBA rules are deduplicated, existing credential/env/backup file modes are explicitly restricted, and credentials are validated. These scripts were compiled/reviewed but not run against production.

## Final acceptance record

Executed locally on 2026-10-04 against the final review branches:

| Check | Result |
|---|---|
| TMedge server/API/auth/ingest/replay/rollout suites | 207/207 passed |
| TMedge server, console, student and engineer typechecks/builds | Passed |
| TMWAccess suites and type compilation | 24/24 passed |
| Firmware/edge packet and real direct-session crosscheck | 27 checks passed; both legacy and encrypted paths |
| Real gateway/edge + real firmware parser | 14 checks passed; encrypted uplink, ACK, command, tamper and replay on both relay transports |
| Native mbedTLS AES-GCM known-answer/tamper/downgrade suite | 79 checks passed |
| Real firmware cloud/session and display host suites | 124 and 27 checks passed |
| NVS/OTA/I2C fault injection (UBSan) | 44 checks passed |
| Real detector scenarios / Python listener | 23 scenarios / 5 tests passed |
| ESP32 release and test-fixture builds | tmflash and tmsense_testcloud passed; test-fixture build never released |
| Complete production FirmwareStore/bubblewrap compile | tmsense-1.7, 970224 bytes; build/hash in SECURITY_VALIDATION.md |
| Training offline regressions | 8 tests passed |
| Disposable real PostgreSQL schema/worker | 20 checks each passed on PostgreSQL 14 and 16: upgrades, retry, source retention and failed dirty-legacy migration |
| Release archive / CI receiver security | Passed |
| Checked deployment/rollback local rehearsal | 14 checks passed; no server contacted |

Detailed commands, container/dependency results and EC2 read-only prerequisites
are recorded in [SECURITY_VALIDATION.md](SECURITY_VALIDATION.md).
CI repeats the cross-repository and real PostgreSQL checks using coordinated
commit pins. The source inventory includes newly added files. No production
audit release or encrypted hardware flash was performed. The earlier live 1.5
M3 OTA pass is historical evidence in [OTA_TEST_REPORT.md](OTA_TEST_REPORT.md)
and does not validate 1.7 encryption or rollback.

Remaining release gates are OPEN-01 through OPEN-11 as applicable. Host fault
injection and successful compilation do not establish physical flash power-loss,
radio entropy/TLS heap pressure, cross-core scheduling, pre-init rollback or
production fleet capacity. Existing vendor type-range comparison warnings are
redundant after signed narrowing on these targets; no test failures are hidden.
No source audit can certify absence of every possible vulnerability.
