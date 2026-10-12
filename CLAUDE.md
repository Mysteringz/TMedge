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
src/modules/algo-admin/  accounts (admins, /api/admin/accounts) and each person's own account (/api/account: address, password, sessions; docs/algo-admin-roles.md)
src/infrastructure/email/  Amazon SES sender: SigV4 by hand, the EC2 instance role's keys, EMAIL_* config (docs/EMAIL.md)
src/algo/ml-data/        ML data: reader queries, schema, asynchronous ZIP exports (docs/ML_DATA.md)
src/algo/train/          module 02: HPC2021 training jobs: drafts, uploads, sbatch (docs/hpc/)
src/algo/train/hpc/      Plan A: sealed credentials, openconnect + ocproxy tunnels, OpenSSH, SLURM (npm run test:hpc-stack)
algo-app/                its UI: Bluegrid console shell (Carbon Gray 100, IBM Plex, orange accent; src/console/): 01 /flow, 02 ML dropdown (/train, /ml-data), 03 /console, Devices dropdown (04 /updates, 06 /adoption, 07 /flash), 05 /analytics; account icon -> /account
src/modules/analytics/   module 05: usage of the student site + host/back-end history, read-only (docs/ANALYTICS.md)
src/infrastructure/analytics/  its probes: /proc, disks, systemd (read-only), JSONL history, the web tier's usage report
src/modules/workspace/   the landing page's team side: mailbox, feature requests, tasks (docs/WORKSPACE.md); /api/workspace
src/modules/assistant/   Ask AI: a model on the team's Proxmox cluster, told config/ai-knowledge.md (docs/ASSISTANT.md); /api/assistant
config/ai-knowledge.md   what Ask AI knows about the system -- UPDATE IT WITH EVERY CHANGE TO THE SYSTEM (rule below)
algo-app/src/widgets/workspace/  the landing page under the welcome: the search/ask box, suggestions, system figures, mailbox, board
src/algo/flasher-login.ts browser consent + PKCE exchange for account-bound TMflash access
src/shared/flasher/      module 07's core, no DOM: settings, the node's serial console, the flash write plan (docs/WEB_FLASHER.md)
algo-app/src/console/flash/  module 07's I/O: Web Serial, esptool-js, loading the TMsense release
src/infrastructure/firmware-release/  module 07's firmware: the latest GitHub release of TMsense, fetched and checked by the edge; /api/flash
src/edge/adoption-credentials.ts private digest store, expiry, account invalidation and revocation
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
- **Privacy boundary:** the student web tier receives only `OccupancySnapshot`. Raw frames
  reach a browser only in the signed-in algo console on the edge (its
  debugger and module 03, the debug console). Training recordings also leave
  through the private training database and authenticated ML data exports,
  as requested by the operator; no student API exposes them.
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
- **A node is admitted by a person.** TMflash's account session buys a *pending
  request*; somebody signed into Adoption matches the physical UID and request
  code to approve it. What is admitted is
  an identity: floor, pose and owns are null/empty, so a new node can connect
  and stream but cannot move a number a student sees until it is placed.
  `NodeDef.floorId` and `.pose` are nullable so the compiler finds every
  place that would otherwise do geometry on a pose nobody measured.
- **The web flasher never erases a board, and keeps its secrets off the
  server.** Module 07 writes four images to an allow-list of regions read
  from the partition table being flashed (`src/shared/flasher/images.ts`); a
  plan that would reach an NVS partition is refused, never trimmed, and no
  erase command is sent. NVS holds the boot counter, and a counter that goes
  back to zero makes the edge reject the node as a replay. The Wi-Fi password
  and the signing key go from the page to the USB port: never to an endpoint,
  never to storage, never to the log or an error message.
  The firmware has one source, the latest GitHub release of the TMsense
  repository: the edge fetches it from GitHub's hosts only, and offers it
  only if every file matches the release's manifest and the three make a
  flash plan. No route, picker or upload may hand the page or the edge any
  other image, and a release that fails a check is never replaced by an
  older one.
  It queues an adoption request with the signed-in account and waits at a
  button; pressing it is the person's approval, and nothing answers for them.
  `src/shared/flasher` mirrors TMflash's Swift core and TMsense's console:
  change the three together.
- **nodes.json is the one config the edge writes.** It lives in
  a persistent writable directory with `NODES_CONFIG` pointing at it, because a release's
  own copy is replaced on the next deploy. The edge refuses to start if
  `TMFLASH_TOKEN` is set and that file is unwritable or inside the release.
- **Config is strict.** Add validation for any new field.
- **Wire format changes touch both repos** and `npm run crosscheck`.
- **One path for every transport.** UDP, TMGW and direct WSS all go through
  `Ingest.handle`; no transport skips the signature, replay rule or
  occupancy. Only an accepted packet may set a node's route or earn an ACK,
  and a direct node's closed session is "no route", never a UDP fallback.
- **An HKU credential, or the shared cluster password, is used once and never
  kept** (module 02, Plan A; the cluster is ing@10.21.36.12). The cluster
  password exists on the box only as a fingerprint, never in git. Each
  credential is sealed in the browser, opened on the edge into a Buffer (never a
  string), fed to openconnect on stdin and to ssh through askpass (never
  argv or env), and wiped when the login ends. The CONSOLE's ssh shell is
  encrypted end to end too (src/shared/hpcterm.ts); never log or stringify
  what passes through it. Never log openconnect's
  stderr (it prints cookies). Never retry a login. test/hpcstack.test.ts
  hunts for the PIN in files, logs, /proc and the heap; keep it passing.
  docs/hpc/HANDOVER.md rules 1-6 apply to every change there.
- **The node listener is not a web surface.** `/tmnode`, `/fw/<id>.bin` (grant
  only) and `/healthz`; nothing a person could read. It binds to loopback.
- **Analytics: unknown is not zero, and counts are not people.** A source that
  did not answer has no data, a stretch nothing was measured in is a gap, and
  a floor no sensor covers has no occupancy figure -- never a 0. Nothing in
  `src/modules/analytics` may hold an email, a name or an account ID; "active
  students" is counted from a keyed hash. Its history writer must never throw:
  it runs inside the services it is watching. docs/ANALYTICS.md.
- **Mail is its sender's and its recipients', and nobody else's.** No role
  reads other people's mail, every mailbox listing is filtered by who is
  asking, and mail older than an account is never shown to it (usernames are
  reused). The workspace's store is never replaced by a write that could not
  first read it. docs/WORKSPACE.md.
- **An account's email address is its owner's, and nobody else's.**
  `/api/account` acts on whoever the session belongs to and takes no username.
  The address lives in `account-settings.json` beside the account file,
  private, bound to the account's creation time so a reused username never
  inherits it, and dropped once the account is gone. No admin route, team
  list, page or Ask AI prompt may carry it. Changing a password needs the
  current one, ends every other session, and renews only the one it was
  made from.
- **Email goes only to an address its owner confirmed, and says only what
  they could see signed in.** A code typed back into Account settings is the
  one thing an unconfirmed address is sent; a changed address is unconfirmed
  again. Notifications are read under the recipient's own role, mailbox and
  tasks (`runtime-account-news.ts`), never as an admin. No address reaches a
  log, an error, an API response to anyone else, or the delivery file
  (`email-delivery.json` holds hashes). What is news and how often is
  decided in `domain/email-delivery.ts` and nowhere else: nothing that was
  already true when email was turned on, a clearable fault only after ten
  minutes, one message per 15 minutes, 12 a day. Without `EMAIL_FROM` and
  `EMAIL_SES_REGION` there is no mailer, `emailDelivery` is false and the
  page says so: do not word anything as though mail goes out. docs/EMAIL.md.
- **No class name an ad blocker hides.** `ad-…`, `ads-…`, `…-ad`, `advert…`,
  `sponsor…` are removed from the page by EasyList's generic rules, with no
  error -- it emptied Adoption and TMflash for anyone running one. Those two
  pages use `dv-`. `test/console-classes.test.ts`.
- **Team roles are labels, never authority.** ML, front-end, back-end and the
  rest say what somebody works on. No permission check may read them; access
  is the access role and only that.
- **The assistant answers and never acts.** It is given no tools, and nothing
  it writes is executed or followed. It is shown the knowledge base and a few
  figures every member already sees -- never mail, imagery, anything about a
  student, a machine address or a secret. Its answers are always marked as
  AI, and a model that is down is said to be down. docs/ASSISTANT.md.

## The assistant's knowledge base -- a rule for every change

`config/ai-knowledge.md` is the whole of what Ask AI knows about this system.
It is sent to the model before every question, so when it is out of date the
assistant tells engineers things that are no longer true, with confidence.

**Any change that alters how the system works or what the console offers must
update `config/ai-knowledge.md` in the same commit.** This applies to every
contributor, human or AI coding agent, and it is part of "done" for the task:

- a module, page or screen added, removed, renamed or renumbered;
- a role, permission, or who-may-do-what changed;
- how a count is made, what "unknown" means, or any invariant above changed;
- the pipeline, a transport, the deployment path or a privacy boundary changed;
- anything on the landing page (search, Ask AI, mailbox, board, figures) changed.

Write it for a reader that knows nothing else: plain sentences, what is true
now, no history. Keep it under 16 kB. Never put a secret, a machine address,
a hostname or anything about a named person in it -- it leaves the edge on
every question. `test/assistant.test.ts` fails if a console module is missing
from it or it grows too large; it cannot tell whether a description is still
true, so read the file against your change before you call the change done.

## Conventions

TypeScript `strict` + `noUncheckedIndexedAccess`; the server's runtime deps
are only `express` and `ws` (the student UI's React lives in `web-app/` and
ships as static files). `hkumyseat.com` is a gateway: `/` redirects to
`/login/` or `/dashboard/`, every screen behind it is under `/dashboard/`, and
no page or redirect that depends on the session cookie may be cached. Comments explain *why*. Plan units are cm, origin top-left.
Tests read as claims about behaviour. Add one that fails without your change.
On the dev Mac, NordVPN may block LAN traffic; bind to `en0` if packets stop.
