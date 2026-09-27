# TMedge — notes for AI coding sessions

Edge processing + student web app for TMnode thermal sensors. Firmware lives
in `../TMsense` (the thermal node, formerly TMnode).

## Map

```
src/edge/protocol.ts     wire format reader — mirrors TMsense/include/tm_protocol.h
src/edge/ingest.ts       every transport's packets: HMAC, replay by (boot, seq), routes, commands
src/edge/nodelink.ts     direct TMsense nodes over WSS (tmnode.v1): auth, ACKs, freshness, OTA grants
                         -- contract in docs/DIRECT_NODE_PROTOCOL.md, rollout in docs/DIRECT_NODE_RUNBOOK.md
src/edge/registry.ts     site/nodes config + strict validation, coverage per table
src/edge/occupancy.ts    projection -> authority per table -> seats -> smoothing
src/edge/runtime.ts      wires ingest/occupancy/recorder/publisher; node & edge health
src/edge/console.ts      admin console HTTP/WS (raw frames live here only)
src/edge/recorder.ts     daily JSONL logs = Phase 3 calibration data
src/shared/geometry.ts   110° f-theta pixel <-> floor, height-aware
src/shared/seats.ts      seat layout + "N seats together" (server and client share it)
src/web/                 student web tier (auth, snapshot store, API, WS)
web-app/                 student UI: React + Vite, builds into public-web/app/
src/algo/                algo debugger: node-graph over the real pipeline (docs/ALGO_DASHBOARD.md)
algo-app/                its editor: React + React Flow, builds into public-algo/
src/console-client/      admin console UI
src/tools/simulator.ts   virtual nodes sending real signed packets; --truth for accuracy
```

## Commands

```bash
npm run build && npm test && npm run typecheck
npm run crosscheck           # needs ../TMsense and g++
npm run edge | web | simulate
deploy/deploy.sh             # the only way to production; see deploy/pipeline.md
deploy/test-deploy.sh        # rehearses deploy/rollback locally; CI runs it
```

CI (`.github/workflows/ci.yml`) runs all of the above on Linux + Node 22 for
every PR. The Mac runs a newer Node and CommonCrypto, so "passes here" alone
has hidden Linux failures before.

## Invariants

- **Silence is never emptiness.** Unknown tables have `occupied: null`, are left
  out of free totals and are never suggested. A stale edge turns its whole floor
  unknown in the web tier.
- **Each person is counted once.** One authority node per table (owner →
  fallback → unknown). Tests prove the overlap and fallback cases.
- **A table never reports more than its seats; the zone counts everyone.**
- **Counts are smoothed**, both seat hysteresis and median zone counts. Never
  use the latest frame.
- **Blob heat is compared after normalising by pixel floor area.** Raw heat
  varies ~2× across a 110° view and produced phantom seats (86% → 98%
  accuracy when fixed).
- **Privacy boundary:** only `OccupancySnapshot` leaves the edge. Raw frames
  reach a browser only in the authenticated admin console on the edge.
- **Students can't write.** The only write on the web tier is the edge's
  bearer-token push.
- **An update is never a broadcast.** One node is flashed first and must
  report the new image, a working sensor and an accepted packet before any
  other node is touched; a failed pilot stops the rollout. See rollout.ts.
- **The node trusts the hash, not the carrier.** The OTA request is signed and
  carries the SHA-256; gateways only hold and serve bytes.
- **The debugger never re-implements the detector.** Its preview runs
  `../TMsense/src/tm_detector.cpp` compiled for the host. A copy of that file
  in this repo is a test failure, because a debugger that drifts from the
  firmware lies about the thing it is debugging.
- **A live parameter change is temporary.** The algo dashboard's writes revert
  after 15 minutes unless committed, flash writes are a separate act, and
  every change is in `data/algo/audit.jsonl` with its old value.
- **Config is strict.** Add validation for any new field.
- **Wire format changes touch both repos** and `npm run crosscheck`.
- **One path for every transport.** UDP, TMGW and direct WSS all go through
  `Ingest.handle`; no transport skips the signature, replay rule or
  occupancy. Only an accepted packet may set a node's route or earn an ACK,
  and a direct node's closed session is "no route", never a UDP fallback.
- **The node listener is not a web surface.** `/tmnode`, `/fw/<id>.bin` (grant
  only) and `/healthz`; nothing a person could read. It binds to loopback.

## Conventions

TypeScript `strict` + `noUncheckedIndexedAccess`; the server's runtime deps
are only `express` and `ws` (the student UI's React lives in `web-app/` and
ships as static files). `hkumyseat.com` is a gateway: `/` redirects to
`/login/` or `/dashboard/`, every screen behind it is under `/dashboard/`, and
no page or redirect that depends on the session cookie may be cached. Comments explain *why*. Plan units are cm, origin top-left.
Tests read as claims about behaviour. Add one that fails without your change.
On the dev Mac, NordVPN may block LAN traffic; bind to `en0` if packets stop.
