# tmnode.v1 — direct node protocol

Status: **implemented, not deployed.** Edge: `src/edge/nodelink.ts`. Node:
`TMsense/src/tm_cloud_session.cpp` (+ `tm_ws.cpp`, `tm_cloud_proto.cpp`,
`tm_cloud.cpp`). Both ends are checked against each other by
`npm run crosscheck`, which runs the firmware's own session code against this
edge's listener.

A TMsense node with `transport wss` reaches TMedge itself — one outbound TLS
WebSocket, no gateway machine at the site. This is a **transport**, not a new
packet format: every REPORT, RAW, STATUS, OTA_STATUS, COMMAND and OTA keeps its
`tm_protocol.h` bytes and HMAC and travels as one binary WebSocket message.
What this document adds is the session around them.

```text
TMsense ──WSS :443──► sense.<domain> (Cloudflare) ──tunnel──► cloudflared ──► 127.0.0.1:NODE_PORT
                                                                              /tmnode   WebSocket
                                                                              /fw/<id>.bin  HTTPS download (grant only)
                                                                              /healthz  "ok"
```

## 1. Transport

| Item | Rule |
|---|---|
| URL | `wss://<host>[:443]/<path>` provisioned as `cloud_url` (proposed production: `wss://sense.hkumyseat.com/tmnode`) |
| TLS | Terminated by Cloudflare; final hop is loopback HTTP inside the tunnel. The node verifies chain, host name and validity dates (see §6) |
| Subprotocol | `Sec-WebSocket-Protocol: tmnode.v1`, required. Anything else: HTTP 400 before upgrade |
| Path | exactly `/tmnode`, no query. Anything else: HTTP 404 |
| Compression | never offered by the node, never negotiated by the edge (`perMessageDeflate: false`); a response that negotiates it is refused by the node |
| Frames | the node masks, the server does not. Continuation frames are reassembled into a bounded buffer on both sides |
| Text messages | control, UTF-8 JSON, ≤ **512 bytes** either way |
| Binary messages | exactly one packet, ≤ **806 bytes** (`TM_PACKET_MAX_SIZE`, a RAW). Larger: close 1009 |

## 2. Handshake

```text
node                                     edge
 │ ── HTTP Upgrade, tmnode.v1 ─────────► │
 │ ◄──────── 101 Switching Protocols ─── │
 │ ◄─ {"type":"challenge","v":1,"nonce":"<64 hex>"}
 │ ─► {"type":"auth","v":1,"uid":"aa:bb:cc:dd:ee:ff","nonce":"<same>","mac":"<64 hex>"}
 │ ◄─ {"type":"ready","v":1,"uid":"…","session":"<opaque>","heartbeatMs":15000}
 │ ─► STATUS (fresh), REPORT, …
```

- **nonce**: 32 bytes from a CSPRNG, lowercase hex, bound to this socket,
  single use, dead after `HANDSHAKE_MS` (10 s) — close 4408.
- **mac** = `HMAC-SHA256(key, "tmnode1|" + uid + "|" + nonce)`, full 32 bytes
  as lowercase hex, `key` = the site key the node already signs packets with
  (`TM_KEY`, or `TM_KEY_PREVIOUS` during a rotation). Fixed vectors:
  `TMsense/test/host/fixtures/tmnode_auth_vectors.json`.
- `auth` must have exactly the five fields, `uid` lowercase colon-separated.
  The edge checks the nonce and the mac in constant time and the uid against
  `nodes.json`. **Every** failure — wrong nonce, bad mac, unregistered node — is
  the same close, 4401 "authentication failed"; the edge's log says which.
- Direct mode **always** requires a key; `ALLOW_UNSIGNED` never applies, and
  `NODE_PORT` without `TM_KEY` refuses to start.
- The edge records which configured key authenticated the session. That
  session's packets must verify with that key alone, and every downlink to it
  is signed with it — so a node still on the previous key gets commands it can
  verify.
- Anything before `auth` other than one text message, or a binary message
  before `ready`: close 4400.

A site-wide key means any holder of it can pose as any registered node. This
protocol does not claim per-device isolation; per-node keys would be a
separate migration.

## 3. Packets, routes and acknowledgements

- Uplink: REPORT, RAW, STATUS, OTA_STATUS only, with the session's uid.
  Everything goes through `Ingest.handle` — the same signature, replay
  `(boot, seq)` and occupancy path as UDP and TMGW. A packet with another uid:
  rejected `uid does not match the session`.
- Replay cursors are per node, shared by every transport, and never reset by
  a connection opening or closing. A reconnect in the same boot continues the
  sequence; a packet already heard over UDP is a replay over WSS and vice versa.
- **Route**: `Ingest` keeps an explicit route per node (`udp`, `gateway`,
  `direct`), taken from its last *accepted* packet. A rejected packet cannot
  move it. A direct session becomes the node's route only with its first
  accepted packet; at that moment an older direct session is closed with 4409.
  A late close of the replaced session cannot remove the replacement (session
  id check). When the node's current direct session closes its route becomes
  *none*: commands fail with "direct session has closed" — never a fallback to
  UDP or DNS.
- **ACK**: after an accepted REPORT or STATUS, and only then:
  `{"type":"ack","v":1,"session":"…","boot":B,"seq":S}`. Rejected, duplicate,
  late or malformed packets get none. ACK means *verified and accepted in
  memory*, not recorded to disk.
- The node counts an ACK only if it names a REPORT/STATUS it sent in this
  boot and this session (`TmAckTracker`, 16 slots). An ACK for S also writes
  off anything it sent before S: the edge acknowledges in order, so those were
  refused.
- Downlink: COMMAND and OTA packets, signed with the session key. Writing one
  to the socket means *dispatched*; the node's next STATUS (`last_cmd`,
  params) is still what proves it applied.

## 4. Freshness

Uptime is the node's clock since boot, not wall time, so the edge measures
*added* delay. Per node and boot it keeps `offset = receive_mono − uptime`,
the smallest seen:

- a packet whose offset is more than **2 000 ms** above it is rejected
  (`delayed N ms beyond this boot's fastest delivery`) before occupancy sees it;
- a smaller offset replaces the baseline at once (a faster path);
- a larger one moves it up by at most **200 ppm** of elapsed time, so a slow
  node crystal is followed (a day at 100 ppm is accepted — tested) while a
  backlog cannot drag the baseline with it;
- 32-bit uptime wrap (49.7 days) is unwrapped; a new boot starts a new baseline.

The baseline is per boot, not per session, so a reconnect cannot launder a
stale backlog; an edge restart forgets it (the first packet after sets it).

The node keeps no history: its uplink queue is 4 static slots, observations
older than 2 s are dropped rather than sent, RAW is dropped first under
pressure, order is always build order (a STATUS never overtakes a REPORT into
a replay), and everything queued is discarded when a session ends or begins.
After `ready` it builds a fresh STATUS rather than resending anything.

## 5. Liveness and limits

| Item | Value | Where |
|---|---|---|
| Server ping / dead | every 15 s; terminated after 45 s with nothing heard | `HEARTBEAT_MS`, `DEAD_MS` |
| Node silence | reconnect after 45 s with no byte from the edge | `TM_CLOUD_SILENCE_MS` |
| Node ACK deadline | reconnect if a REPORT is unacknowledged for 5 s, however open the socket looks | `TM_CLOUD_ACK_DEADLINE_MS` |
| Reconnect | exponential from 1 s, cap 60 s, half random; reset only by an ACKed REPORT, never by TCP connect | `tm_backoff_ms` |
| Sessions | `NODE_MAX_SESSIONS` 256 | config |
| Handshakes | `NODE_MAX_PENDING` 64 total, `NODE_MAX_PENDING_PER_SOURCE` 8, `NODE_UPGRADES_PER_MIN` 60 per source (CF-Connecting-IP, trusted only from loopback) | config |
| Per node | `NODE_MSGS_PER_SEC` 40, `NODE_BYTES_PER_SEC` 32 768, two seconds of burst; over it a message is dropped, 100 drops in 10 s closes 4429 | config |
| Server output | 64 KiB buffered per socket; beyond it the session is failed (4508), not grown | `MAX_BUFFERED` |

The per-node rate covers the firmware's fastest setting (refresh 5 ≈ 8 fps)
with RAW every frame: ≈ 17 messages and 8 kB a second.

Close codes: 4400 bad message · 4401 authentication failed · 4408 handshake
timeout · 4409 replaced by a newer session · 4429 rate limited · 4504 no
response · 4508 slow reader · 1001 edge shutting down · 1009 too big.

Cloudflare may close long-lived WebSockets during its own updates; reconnect
is normal operation, and nothing above depends on a socket living long.

## 6. TLS on the node

- WiFiClientSecure (ESP32 Arduino core 2.0.17, mbedTLS 2.28) with
  `setCACert(TM_CA_ROOTS)` — never `setInsecure()`. Roots: ISRG X1/X2, GTS
  R1–R4, SSL.com RSA/ECC (`include/tm_ca_roots.h`, regenerated by
  `tools/update_ca_roots.sh` with SHA-256 fingerprints). Rotation: add a new
  root while the old is valid, ship firmware, then drop the old.
- The core's mbedTLS has no `MBEDTLS_HAVE_TIME_DATE`: it checks the chain and
  the host name but **not dates**. `tm_cloud.cpp` checks `valid_from`/`valid_to`
  of every presented certificate against SNTP time itself.
- No plausible clock (before 2026-01-01): the session waits in
  `waiting-for-time` and never connects. A time failure is visible, never a
  reason to skip verification.
- A bare IP address is refused as a host (no name to verify). Only the
  never-released `env:tmsense_testcloud` build accepts `ws://`, other ports,
  IP hosts and an extra git-ignored `include/tm_test_ca.h`.

## 7. OTA over the direct connection

The OTA packet layout is unchanged; its download semantics depend on the
transport it arrived on (documented in `tm_protocol.h`).

1. The rollout allocates one command sequence (`Ingest.allocateCommandSeq`).
2. The edge sends `{"type":"ota_grant","v":1,"seq":S,"build":"<16 hex>","token":"<64 hex>","expiresInMs":600000}`
   on the session, then the signed OTA packet with the same `S`, `port 443`,
   `path /fw/<build>.bin`. A direct node is never sent the console port or a
   gateway push; the edge refuses to build one.
3. The node requires: path `/fw/<16 hex>.bin`, port = its `cloud_url` port,
   a grant with that exact `seq` and `build`, unexpired. The grant never
   authorizes flashing or supplies the hash — the signed packet does.
4. It fetches `https://<cloud_url host><path>` with
   `Authorization: Bearer <token>` — the token only in that header, never in a
   URL or a log. It refuses any status but 200, any `Location`, chunked
   encoding, or a `Content-Length` other than the signed size, reads exactly
   `size` bytes, checks SHA-256, writes the spare partition, reboots.
5. The edge serves `/fw/<id>.bin` only for a valid, unexpired grant whose
   build matches **and** while the rollout still wants that node's download
   (`Rollouts.wantsDownload`: state sending/downloading). Cancelling, the node
   moving on, or expiry ends it; grants are stored by token hash, survive a
   socket closing (the node may close it for heap), and die with an edge
   restart — the rollout then times out visibly. `Cache-Control: no-store`.
   Nothing else is served: no listing, upload, console, RAW or admin route.
6. Heap: the node keeps the WebSocket open during the download if the largest
   free block is ≥ 60 000 bytes, else closes it first and reopens it after.
   Either way the loop is blocked, so no REPORT is made and the node goes stale
   normally; progress is OTA_STATUS.
7. **Probation** of the new image (3 minutes, unchanged): confirmed only with
   the cloud session ready, the sensor reading, and a *new* ACK for a REPORT
   this boot generated. A socket write, `ready`, a ping or an old ACK does not
   count. Otherwise the previous partition is restored and the node reboots.
   (UDP keeps its older send-based heuristic; UDP has no acknowledgement.)

## 8. Node settings (serial console)

```text
set cloud_url wss://sense.hkumyseat.com/tmnode    128 ASCII bytes max, validated, never truncated
set transport wss                                  requires mode wifi and a valid cloud_url
set transport udp                                  back to `edges` (kept all along for this)
```

Nodes provisioned before this firmware have no `transport` in NVS and stay
`udp`; flashing never migrates a node. `show` adds, before `boot`:
`transport`, `cloud_url`, `caps : wss1,ota-https1`, `uplink` (state and last
error) and `report_ack` (age of the last acknowledged REPORT). A console line
of 160+ bytes is discarded whole, through its newline.

## 9. Edge configuration

| Variable | Default | Meaning |
|---|---|---|
| `NODE_PORT` | 0 (off) | listener port; production proposal 5211 |
| `NODE_HOST` | 127.0.0.1 | bind address; loopback so only cloudflared reaches it |
| `NODE_MAX_SESSIONS` … `NODE_GRANT_MS` | §5 | validated integers; a bad value refuses to start |
| `NODE_TLS_CERT` / `NODE_TLS_KEY` | — | **test only**: terminate TLS in the edge for a local fixture |

A configured listener that cannot bind stops the edge (exit 1), and the
deploy health check (`deploy/remote.sh`) requires `/healthz` = 200 whenever
`.env` sets `NODE_PORT`.

## 10. Tests

- `test/nodelink.test.ts` — 22 claims: handshake refusals, replayed auth,
  previous-key downlinks, per-session key and uid, one replay rule across
  transports, route activation and late close, backlog rejection, 100 ppm
  drift, STATUS alone never keeps a table live, identical occupancy over UDP
  and WSS, size and rate bounds, OTA grant/download/expiry/scope, listener
  surface, config.
- `test/rollout.test.ts` — direct nodes get 443 and no gateway push; download
  window; a closed session is not a target.
- `TMsense/test/host/cloud_test.cpp` — 104 checks on the firmware's framing,
  URL rules, control parser, auth vectors, ACK tracker, queue, backoff, HTTP
  head parser and session state machine.
- `npm run crosscheck` — the firmware session (`cloud_host`) against this
  edge: upgrade, auth, byte-identical packets, ACKs, replay refusal, a command
  and an OTA grant + request verified by the firmware.
