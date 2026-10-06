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
src/edge/staticbg.ts     day-long background: heat present ~80% of 24 h is room, the rest may be people
src/edge/edgedetect.ts   detection on RAW frames for nodes with "detector": "edge" (docs/EDGE_DETECTION.md)
src/edge/runtime.ts      wires ingest/occupancy/recorder/publisher; node & edge health
src/edge/console.ts      debug console core: UI router (module 03 of the algo console) + device endpoints on CONSOLE_PORT
src/edge/recorder.ts     daily JSONL logs = Phase 3 calibration data
src/shared/geometry.ts   110° f-theta pixel <-> floor, height-aware
src/shared/seats.ts      seat layout + "N seats together" (server and client share it)
src/web/                 student web tier (auth, snapshot store, API, WS)
web-app/                 student UI: React + Vite, builds into public-web/app/
src/algo/                algo console: node-graph over the real pipeline (docs/ALGO_DASHBOARD.md)
src/algo/auth.ts         its sign-in: per-person accounts, cookie, Turnstile (no Basic auth)
src/algo/train/          module 02: HPC2021 training jobs: drafts, uploads, sbatch (docs/hpc/)
src/algo/train/hpc/      Plan A: sealed credentials, openconnect + ocproxy tunnels, OpenSSH, SLURM (npm run test:hpc-stack)
algo-app/                its UI: 8-bit console shell (src/console/): 01 /flow React Flow editor, 02 /train, 03 /console
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
  reach a browser only in the signed-in algo console on the edge (its
  debugger and module 03, the debug console).
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
  firmware lies about the thing it is debugging. `edgedetect.ts` is not such
  a copy: it is the edge's own detector for `"detector": "edge"` nodes, with
  a different background by design, and the debugger labels it as such.
- **A still person is not background.** An edge-detected node's background
  only learns heat present in ~80% of the last 24 h. Never shorten that
  window or raise the quantile to "adapt faster": that is exactly how a
  student sitting for two hours faded out of the count. Until the model has
  an hour of history the node reports not-ready, so its tables are unknown.
- **A live parameter change is temporary.** The algo dashboard's writes revert
  after 15 minutes unless committed, flash writes are a separate act, and
  every change is in `data/algo/audit.jsonl` with its old value.
- **A node is admitted by a person.** TMflash's token buys a *pending
  request*; somebody with the console open approves it. What is admitted is
  an identity: floor, pose and owns are null/empty, so a new node can connect
  and stream but cannot move a number a student sees until it is placed.
  `NodeDef.floorId` and `.pose` are nullable so the compiler finds every
  place that would otherwise do geometry on a pose nobody measured.
- **nodes.json is the one config the edge writes.** It lives in
  `/opt/tmedge-shared` with `NODES_CONFIG` pointing at it, because a release's
  own copy is replaced on the next deploy. The edge refuses to start if
  `TMFLASH_TOKEN` is set and that file is unwritable or inside the release.
- **Config is strict.** Add validation for any new field.
- **Wire format changes touch both repos** and `npm run crosscheck`.
- **One path for every transport.** UDP, TMGW and direct WSS all go through
  `Ingest.handle`; no transport skips the signature, replay rule or
  occupancy. Only an accepted packet may set a node's route or earn an ACK,
  and a direct node's closed session is "no route", never a UDP fallback.
- **An HKU credential is used once and never kept** (module 02, Plan A). It
  is sealed in the browser, opened on the edge into a Buffer (never a
  string), fed to openconnect on stdin and to ssh through askpass (never
  argv or env), and wiped when the login ends. Never log openconnect's
  stderr (it prints cookies). Never retry a login. test/hpcstack.test.ts
  hunts for the PIN in files, logs, /proc and the heap; keep it passing.
  docs/hpc/HANDOVER.md rules 1-6 apply to every change there.
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
