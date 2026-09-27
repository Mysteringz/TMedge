# Direct-to-cloud nodes: rollout, migration and recovery

Companion to `DIRECT_NODE_PROTOCOL.md`. **Nothing here is deployed yet.** Every
step marked *(approval)* is a production change that waits for the owner's
explicit go-ahead, one step at a time; the TMedge release itself goes only
through `deploy/pipeline.md`'s required-reviewer workflow. No credential
values appear in this file, and none may be added.

## Compatibility

| Component | Version with direct cloud | Compatible with | Notes |
|---|---|---|---|
| TMedge | this branch (`direct-cloud-transport`) | TMsense ≤ 1.3 over UDP/TMGW unchanged; TMsense 1.4 over UDP, TMGW or WSS | listener off unless `NODE_PORT` is set |
| TMsense | `tmsense-1.4` | any TMedge over UDP; WSS needs a TMedge with the listener | new NVS keys `transport`, `cloud_url`; old NVS boots as `udp` |
| TMflash | this branch | TMsense ≤ 1.3 (UDP only, new commands never sent); 1.4 (UDP or WSS) | refuses WSS on old firmware before writing anything |
| TMWAccess | unchanged (`b844aa2` / `75a82b9`) | all of the above | still carries UDP nodes; optional for WSS nodes |

A pre-migration TMedge cannot serve a WSS node. Keep that in mind for edge
rollbacks (below).

## 1. Cloudflare (proposal — *approval*)

The existing, remotely managed tunnel gets one more public hostname. Nothing
else in the tunnel changes, and no second connector is started.

| Setting | Value |
|---|---|
| Public hostname | `sense.hkumyseat.com` (covered by the existing `*.hkumyseat.com` edge certificate) |
| Service | `http://localhost:5211` |
| Path | leave empty, or `^/(tmnode|fw/[0-9a-f]{16}\.bin|healthz)$` if path routing is wanted — the listener 404s everything else anyway |
| WebSockets | on (zone setting, already on for `gw.`) |

Before enabling it, check in the dashboard (read-only) and write down:

1. **Access**: no Access application may match `sense.hkumyseat.com` — a
   wildcard `*.hkumyseat.com` app would answer the node with a login redirect
   (the node reports `upgrade refused (302)` or `(403)`). If one exists, add a
   *Bypass* policy scoped to exactly this hostname; leave every other
   admin/student/gateway policy as it is. Nodes authenticate to TMedge
   themselves; they never hold Access service tokens, `TMGW_TOKEN` or tunnel
   credentials.
2. **WAF / bot protection**: Bot Fight Mode, Super Bot Fight Mode or a managed
   challenge would stop a non-browser client. Add a WAF *skip* rule for
   `http.host eq "sense.hkumyseat.com"` (bot and challenge products only), and
   nothing broader.
3. **Cache**: `.bin` is a default-cached extension. The listener sends
   `Cache-Control: no-store, private` (Cloudflare honours it), and a Cache Rule
   *bypass* for `sense.hkumyseat.com` makes it independent of that.

Rollback: remove this hostname (or restore the recorded settings). Never stop
the sole connector or touch the `hkumyseat.com`, `console.`, `algo.` or `gw.`
mappings.

## 2. TMedge release (*approval*, via the pipeline)

1. Merge the TMedge PR after CI (`check` + `container`), with
   `ci/tmsense.ref` pointing at the merged TMsense commit.
2. Deploy the main artifact through the production workflow as usual. With
   `NODE_PORT` unset the listener stays off and the release behaves exactly
   like the previous one.
3. *(approval)* Add to `/opt/tmedge-shared/.env` — without printing the file —
   `NODE_PORT=5211` (and nothing else; `NODE_HOST` defaults to loopback).
   Restart `tmedge-edge`. `journalctl -u tmedge-edge` shows
   `direct nodes: ws://127.0.0.1:5211/tmnode`; a bind failure stops the unit.
   From then on every deploy's health check also requires
   `127.0.0.1:5211/healthz` = 200.
4. *(approval)* Add the Cloudflare hostname (§1).
5. From outside, confirm:
   - `https://sense.hkumyseat.com/healthz` → 200 `ok`
   - `https://sense.hkumyseat.com/` and `/api/state` → 404
   - a WebSocket without `tmnode.v1` → 400; with it, a bad `auth` → close 4401
   - `/fw/<id>.bin` without a grant → 401

## 3. Pilot (one node — *approval*)

Use a powered, physically reachable node with USB access, on ordinary NAT
Wi-Fi. Before touching it, record (no secrets): uid, node id, firmware,
`edges`, and the known-good firmware build id.

1. Flash `tmsense-1.4` with TMflash, **Local gateway** selected: the node
   must come back on UDP exactly as before (settings, boot counter and
   `last_cmd` kept). *(Done on 30:ed:a0:cb:f5:f8 on 2026-09-27 — see §7.)*
2. Provision with TMflash, **Direct to cloud**,
   `wss://sense.hkumyseat.com/tmnode`. TMflash reports "TMedge accepted its
   reports" only after an ACK — joining Wi-Fi is not success.
3. Console → node detail → `uplink` shows the direct session, ACKs and no
   refusals; the table stays known.
4. Test independence by taking only the pilot's legacy path away (its UDP
   destination), not by stopping the shared gateway.
5. Soak ≥ 24 h: RAW commissioning for a while, then `raw_every 0`. Record
   heap (`STATUS` free/min heap), `show` → `uplink` task stack free,
   reconnects (`connects`), and any watchdog reset.
6. Faults, each with "reports resume within 90 s of the network coming back,
   no manual reset, no burst of old occupancy":
   Wi-Fi off/on · internet cut at the router · DNS failure · SNTP blocked
   (node must wait in `waiting-for-time`, never connect unverified) · edge
   restart · tunnel/WebSocket forced closed · stalled socket (ACK deadline).
7. Commands: identify, a parameter write confirmed in STATUS, the algo
   dashboard's temporary change and its automatic revert, save, reboot.
   Target: confirmation within 5 s.
8. OTA: a rollout to the pilot alone → `confirmed`. Then a deliberately bad
   case: roll out while the cloud route is unreachable after flashing →
   probation fails → `reverted` to the known-good image. Check NVS and
   counters survived both. Record untested cases (power loss mid-write, a
   crashing image that never reaches the probation loop) as untested — the
   application rollback is **not** proven crash recovery.

## 4. Batch migration

Only after the pilot passes. In batches of ≤ 10 with TMflash, per site.
Keep an inventory (a spreadsheet, not this repo):

| uid | node id | old transport / edges | new firmware | first ACK seen | OTA proven |
|---|---|---|---|---|---|

`edges` stays set on every migrated node; it is what a USB rollback uses.

## 5. Retiring a site's TMWAccess

Only when the inventory shows **no** node at that site still on UDP, and the
recovery procedure below has been tried once. Stop only that site's service;
leave the Pi rig, tailnet and simulator paths alone. After retirement a node
that cannot reach the cloud can only be recovered over USB (or by another
deliberately provisioned route): dormant UDP code is not failover.

## 6. Rollback and recovery

- **A node fails to reach the cloud** (compatible firmware): over USB,
  `set transport udp`, check `edges`, `save`, `reboot`. Needs its old UDP
  route to still exist.
- **OTA to a direct-capable image fails**: the old image may know only UDP;
  its saved settings and the gateway must still be there for partition
  rollback to restore a working uplink. Keep the gateway until migration is
  finished.
- **Edge rollback**: a pre-migration release cannot serve WSS nodes. Move the
  nodes back to UDP first, or roll back only to a release that already has the
  listener.
- **Cloudflare**: remove or restore only the `sense.` hostname.
- Never: rsync into `/opt/tmedge`, select the quarantined release, start a
  second origin with the cloned tunnel identity, or turn the dev Mac's VPN off
  to make a test pass.

## 7. Evidence so far (2026-09-27)

Hardware: the M3 node (`30:ed:a0:cb:f5:f8`, Heltec V3, MLX90640).

| Claim | Result |
|---|---|
| tmsense-1.4 release image flashed over 1.3 keeps NVS: node id, Wi-Fi, key, `edges`, `last_cmd`; boot counter 21 → 22 | **passed on hardware** |
| Without new settings it stays `transport udp` and rejoins with UDP commands open | **passed on hardware** |
| Production build, production roots, real Cloudflare edge (`wss://hkumyseat.com/tmnode`): waits for SNTP, completes a verified TLS handshake, reads the HTTP answer (502 — no listener there), backs off 3 s → 4 s → 7 s → 8 s | **passed on hardware** |
| Expired, wrong-host, self-signed and untrusted-root certificates (badssl.com) are all refused | **passed on hardware** |
| Cloudflare's response headers exceed 512 bytes: the upgrade buffer was raised to 2 kB after the node reported "upgrade response too long" | **found and fixed on hardware** |
| Full session on hardware (auth, ACK, command, OTA, probation, rollback) against a TMedge listener | **pending** — the dev Mac's VPN blocks LAN traffic, so a bench listener was unreachable from the node; needs the deployed hostname or another reachable test listener |
| The firmware's own session code against the real edge listener (host build) | **passed** — `npm run crosscheck` |
| Certificate *date* check isolated (a trusted chain with an expired leaf) | **pending on hardware** (the badssl expired chain is also untrusted, so it did not isolate the date check) |
| Heap/stack under TLS: tm_cloud task stack high-water 9 964 B free of 12 288 after TLS attempts; static RAM 96.7 kB (29.5 %); image 959 kB of a 3.3 MB slot | measured; full-session and OTA figures pending |
